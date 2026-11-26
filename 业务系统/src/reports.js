const REASON_TYPES = ['虚假信息', '违禁品', '人身攻击', '欺诈', '其他'];
const TARGET_TYPES = ['product', 'user'];
// 同一举报人在 7 天内对同一对象的同一原因只保留一条举报，后续证据并入原记录。
const MERGE_WINDOW = 7 * 24 * 60 * 60 * 1000;
const MAX_EVIDENCE = 6;

// 举报表由本模块自己建，避免与其它模块同时改 database.js 时产生冲突。
function ensureSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY,reporter_id INTEGER NOT NULL REFERENCES users(id),target_type TEXT NOT NULL,target_id INTEGER NOT NULL,reason_type TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,handled_by INTEGER REFERENCES users(id),handled_at INTEGER,result TEXT,penalty TEXT);
CREATE INDEX IF NOT EXISTS report_dedup ON reports(reporter_id,target_type,target_id,reason_type,created_at);
CREATE TABLE IF NOT EXISTS report_evidences(id INTEGER PRIMARY KEY,report_id INTEGER NOT NULL REFERENCES reports(id),uploader_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS evidence_by_report ON report_evidences(report_id,id);
`);
}

// 证据支持纯文本与图片（data URL）；图片同时校验声明类型、内容魔数与大小。
function evidence(list, fail, text) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail(400, '证据须为数组');
  if (list.length > MAX_EVIDENCE) fail(400, `一次最多提交${MAX_EVIDENCE}条证据`);
  return list.map(item => {
    if (!item || typeof item !== 'object') fail(400, '证据格式错误');
    if (item.type === 'text') return { kind: 'text', content: text(item.content, 1, 500) };
    if (item.type === 'image') {
      const raw = typeof item.content === 'string' ? item.content : '';
      const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
      if (!match) fail(400, '仅允许PNG/JPEG图片');
      const bytes = Buffer.from(match[2], 'base64');
      const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
      if (!(match[1] === 'png' ? png : jpeg)) fail(400, '图片内容与格式不符');
      if (bytes.length > 2 * 1024 * 1024) fail(400, '单张图片不能超过2MB');
      return { kind: 'image', content: raw };
    }
    return fail(400, '证据类型须为 text 或 image');
  });
}

export function createReportRoutes({ db, now, auth, body, fail, text, tx, audit, notice }) {
  ensureSchema(db);
  const count = id => db.prepare('SELECT COUNT(*) n FROM report_evidences WHERE report_id=?').get(id).n;
  const saveEvidence = (reportId, userId, items) => {
    for (const item of items) db.prepare('INSERT INTO report_evidences(report_id,uploader_id,kind,content,created_at) VALUES(?,?,?,?,?)').run(reportId, userId, item.kind, item.content, now());
  };
  // 举报指向的对象：商品投诉卖家，用户投诉本人。
  const targetOf = r => r.target_type === 'product'
    ? db.prepare('SELECT p.owner_id user_id,p.title label FROM products p WHERE p.id=?').get(r.target_id)
    : db.prepare('SELECT u.id user_id,u.username label FROM users u WHERE u.id=?').get(r.target_id);

  return async function handleReportRequest(req, url, send) {
    const path = url.pathname;
    const method = req.method;

    // 提交举报：未认证用户也可以举报，因此只要求登录。
    if (path === '/api/reports' && method === 'POST') {
      const u = auth(req);
      const b = await body(req);
      if (!TARGET_TYPES.includes(b.targetType)) fail(400, '举报对象类型须为商品或用户');
      const targetId = Number(b.targetId);
      if (!Number.isInteger(targetId) || targetId < 1) fail(400, '举报对象不存在');
      if (!REASON_TYPES.includes(b.reasonType)) fail(400, `举报原因须为${REASON_TYPES.join('、')}之一`);
      const reason = text(b.reason, 5, 500);
      const items = evidence(b.evidence, fail, text);
      if (b.targetType === 'product') {
        const p = db.prepare('SELECT id,owner_id FROM products WHERE id=?').get(targetId);
        if (!p) fail(404, '举报对象不存在');
        if (p.owner_id === u.id) fail(400, '不能举报自己的商品');
      } else {
        const t = db.prepare('SELECT id FROM users WHERE id=?').get(targetId);
        if (!t) fail(404, '举报对象不存在');
        if (t.id === u.id) fail(400, '不能举报自己');
      }
      // 7 天内同人、同对象、同原因合并到原举报，不新建记录。
      const existing = db.prepare(`SELECT id,status FROM reports WHERE reporter_id=? AND target_type=? AND target_id=? AND reason_type=? AND created_at>=? ORDER BY id DESC LIMIT 1`).get(u.id, b.targetType, targetId, b.reasonType, now() - MERGE_WINDOW);
      if (existing) {
        if (existing.status !== 'pending') fail(409, '该对象的同一举报已处理，如需补充请通过客服反馈');
        tx(() => saveEvidence(existing.id, u.id, items));
        return send(200, { id: existing.id, merged: true, evidenceCount: count(existing.id) });
      }
      const id = tx(() => {
        const r = db.prepare('INSERT INTO reports(reporter_id,target_type,target_id,reason_type,reason,status,created_at) VALUES(?,?,?,?,?,?,?)').run(u.id, b.targetType, targetId, b.reasonType, reason, 'pending', now());
        const id = Number(r.lastInsertRowid);
        saveEvidence(id, u.id, items);
        return id;
      });
      return send(201, { id, merged: false, status: 'pending', evidenceCount: count(id) });
    }

    // 追加证据：只有举报人本人、且举报仍待处理时可以追加。
    let match = path.match(/^\/api\/reports\/(\d+)\/evidence$/);
    if (match && method === 'POST') {
      const u = auth(req);
      const b = await body(req);
      const report = db.prepare('SELECT * FROM reports WHERE id=?').get(Number(match[1]));
      if (!report) fail(404, '举报不存在');
      if (report.reporter_id !== u.id) fail(403, '只能为自己的举报补充证据');
      if (report.status !== 'pending') fail(409, '举报已处理，不能再补充证据');
      const items = evidence(b.evidence === undefined ? [b] : b.evidence, fail, text);
      if (!items.length) fail(400, '请提交至少一条证据');
      if (count(report.id) + items.length > MAX_EVIDENCE) fail(409, `每条举报最多${MAX_EVIDENCE}条证据`);
      tx(() => saveEvidence(report.id, u.id, items));
      return send(201, { id: report.id, evidenceCount: count(report.id) });
    }

    // 举报人查看自己的举报历史（不含他人举报，防止互相窥探）。
    if (path === '/api/reports/mine' && method === 'GET') {
      const u = auth(req);
      const rows = db.prepare(`SELECT r.*,(SELECT COUNT(*) FROM report_evidences e WHERE e.report_id=r.id) evidence_count FROM reports r WHERE r.reporter_id=? ORDER BY r.id DESC`).all(u.id);
      return send(200, rows);
    }

    // 管理端：待处理/已处理列表，带举报人、对象与证据条数。
    if (path === '/api/admin/reports' && method === 'GET') {
      const actor = auth(req, 'admin');
      const status = (url.searchParams.get('status') || 'pending').trim();
      if (!['pending', 'handled', 'all'].includes(status)) fail(400, '状态筛选须为 pending、handled 或 all');
      const rows = db.prepare(`SELECT r.*,u.username reporter,(SELECT COUNT(*) FROM report_evidences e WHERE e.report_id=r.id) evidence_count FROM reports r JOIN users u ON u.id=r.reporter_id ${status === 'all' ? '' : 'WHERE r.status=?'} ORDER BY r.status='pending' DESC,r.id DESC`).all(...(status === 'all' ? [] : [status]));
      audit(actor.id, 'read_reports', 'reports', `status=${status} count=${rows.length}`);
      return send(200, rows.map(r => ({ ...r, target: targetOf(r) || null })));
    }

    // 管理端：记录处置结论与依据，并通知举报人；处置记录不可删除。
    const decision = path.match(/^\/api\/admin\/reports\/(\d+)$/);
    if (decision && method === 'POST') {
      const actor = auth(req, 'admin');
      const b = await body(req);
      if (!['uphold', 'dismiss'].includes(b.action)) fail(400, '处置动作须为成立或不成立');
      const result = text(b.result, 5, 500);
      const id = Number(decision[1]);
      const report = db.prepare('SELECT * FROM reports WHERE id=?').get(id);
      if (!report) fail(404, '举报不存在');
      if (report.status !== 'pending') fail(409, '该举报已处理');
      const verdict = b.action === 'uphold' ? '成立' : '不成立';
      tx(() => {
        db.prepare('UPDATE reports SET status=?,result=?,handled_by=?,handled_at=? WHERE id=?').run('handled', result, actor.id, now(), id);
        // 通知举报人结果；成立时提醒被举报方，但不向被举报方透露举报人身份。
        notice(report.reporter_id, `举报结果：${verdict}。依据：${result}`);
        const target = targetOf(report);
        if (target && b.action === 'uphold' && b.notifyTarget === true) notice(target.user_id, `你收到一条举报，经核实${verdict}。依据：${result}`);
        audit(actor.id, 'handle_report', id, `${verdict} ${result}`);
      });
      return send(200, { id, status: 'handled', result });
    }
  };
}

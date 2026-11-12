// 管理员授权、账号恢复与审计查询（A08）。
// 授权记录单独建表，避免多人同时改 database.js；users 表只改 role 一列，本就不存在。
function ensureSchema(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS admin_grants(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),granted_by INTEGER REFERENCES users(id),granted_at INTEGER NOT NULL,revoked_by INTEGER REFERENCES users(id),revoked_at INTEGER,note TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS grant_by_user ON admin_grants(user_id,granted_at);
`);
}

export function createGrantRoutes({ db, now, auth, body, fail, text, tx, audit, notice }) {
  ensureSchema(db);
  const adminCount = () => db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").get().n;
  const findUser = id => db.prepare('SELECT id,username,role,failed_attempts,locked_until FROM users WHERE id=?').get(id);

  return async function handleGrantRequest(req, url, send) {
    const path = url.pathname;
    const method = req.method;

    // 授权 / 撤销管理员。撤销自己与撤销最后一名管理员都被拒绝，避免把后台锁死。
    const grant = path.match(/^\/api\/admin\/users\/(\d+)\/grant$/);
    if (grant && method === 'POST') {
      const actor = auth(req, 'admin');
      const b = await body(req);
      if (!['grant', 'revoke'].includes(b.action)) fail(400, '授权动作须为授予或撤销');
      const user = findUser(Number(grant[1]));
      if (!user) fail(404, '账号不存在');
      const note = b.note === undefined || b.note === '' ? '' : text(b.note, 1, 200);
      if (b.action === 'grant') {
        if (user.role === 'admin') fail(409, '该账号已是管理员');
        tx(() => {
          db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
          db.prepare('INSERT INTO admin_grants(user_id,granted_by,granted_at,note) VALUES(?,?,?,?)').run(user.id, actor.id, now(), note);
          notice(user.id, '你已被授予管理员权限');
          audit(actor.id, 'grant_admin', user.id, note);
        });
        return send(200, { id: user.id, role: 'admin' });
      }
      if (user.role !== 'admin') fail(409, '该账号不是管理员');
      if (user.id === actor.id) fail(409, '不能撤销自己的管理员权限');
      if (adminCount() <= 1) fail(409, '至少保留一名管理员');
      tx(() => {
        db.prepare("UPDATE users SET role='student' WHERE id=?").run(user.id);
        db.prepare('UPDATE admin_grants SET revoked_by=?,revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(actor.id, now(), user.id);
        notice(user.id, '你的管理员权限已被撤销');
        audit(actor.id, 'revoke_admin', user.id, note);
      });
      return send(200, { id: user.id, role: 'student' });
    }

    // 账号恢复：解除因连续登录失败产生的锁定，保留原因与操作人。
    const restore = path.match(/^\/api\/admin\/users\/(\d+)\/restore$/);
    if (restore && method === 'POST') {
      const actor = auth(req, 'admin');
      const b = await body(req);
      const reason = text(b.reason, 5, 200);
      const user = findUser(Number(restore[1]));
      if (!user) fail(404, '账号不存在');
      tx(() => {
        db.prepare('UPDATE users SET failed_attempts=0,locked_until=0 WHERE id=?').run(user.id);
        notice(user.id, '你的账号已恢复，可以重新登录');
        audit(actor.id, 'restore_account', user.id, reason);
      });
      return send(200, { id: user.id, locked: false });
    }

    // 审计查询：只读，支持按操作人和动作过滤，默认最近 50 条、上限 200 条。
    if (path === '/api/admin/audit' && method === 'GET') {
      const actor = auth(req, 'admin');
      const limitRaw = Number(url.searchParams.get('limit') || 50);
      if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 200) fail(400, '条数须为1～200的整数');
      const action = (url.searchParams.get('action') || '').trim();
      const who = (url.searchParams.get('actor') || '').trim();
      const where = [], params = [];
      if (action) { where.push('a.action=?'); params.push(action); }
      if (who) { where.push('u.username=?'); params.push(who); }
      const rows = db.prepare(`SELECT a.id,a.action,a.target,a.detail,a.created_at,u.username actor FROM audit a LEFT JOIN users u ON u.id=a.actor_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`).all(...params, limitRaw);
      audit(actor.id, 'read_audit', 'audit', `limit=${limitRaw} action=${action || '-'} actor=${who || '-'}`);
      return send(200, rows);
    }
  };
}

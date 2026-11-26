// 账号处置：7 天限制新增交易、30 天封禁与到期恢复（A06）。
// 状态字段在 users 上（见 database.js 的迁移），本模块只负责写入与留痕。
const LIMIT_DAYS = 7;
const BAN_DAYS = 30;

export function createSanctionRoutes({ db, now, auth, body, fail, text, tx, audit, notice }) {
  const DAY = 24 * 60 * 60 * 1000;
  const findUser = id => db.prepare('SELECT id,username,role,status,limited_until,banned_until FROM users WHERE id=?').get(id);
  const stateOf = u => {
    const t = now();
    if (u.status === 'banned' && u.banned_until > t) return 'banned';
    if (u.status === 'limited' && u.limited_until > t) return 'limited';
    return 'normal';
  };
  // 到期处理：把过了截止时间的处置统一恢复为正常，避免「已经过期但还挂着限制」。
  // 登录与交易链路会各自惰性恢复，这里负责让后台列表与统计数据也及时归位。
  const sweep = () => {
    const t = now();
    db.prepare(
      "UPDATE users SET status='normal',limited_until=0,banned_until=0,status_reason='' " +
        "WHERE (status='limited' AND limited_until>0 AND limited_until<=?) " +
        "OR (status='banned' AND banned_until>0 AND banned_until<=?)"
    ).run(t, t);
  };

  return async function handleSanctionRequest(req, url, send) {
    const path = url.pathname;
    const method = req.method;

    // 处置列表：管理员查看当前处于限制/封禁的账号，便于核对到期时间。
    if (path === '/api/admin/sanctions' && method === 'GET') {
      const actor = auth(req, 'admin');
      sweep();
      const rows = db.prepare("SELECT id,username,certified,status,limited_until,banned_until,status_reason FROM users WHERE status<>'normal' ORDER BY id DESC").all().map(u => ({ ...u, state: stateOf(u) }));
      audit(actor.id, 'read_sanctions', 'users', `count=${rows.length}`);
      return send(200, rows);
    }

    const match = path.match(/^\/api\/admin\/users\/(\d+)\/sanction$/);
    if (match && method === 'POST') {
      const actor = auth(req, 'admin');
      const b = await body(req);
      if (!['limit', 'ban', 'lift'].includes(b.action)) fail(400, '处置动作须为限制、封禁或解除');
      const reason = text(b.reason, 5, 200);
      const user = findUser(Number(match[1]));
      if (!user) fail(404, '账号不存在');
      if (user.id === actor.id) fail(409, '不能处置自己的账号');
      if (user.role === 'admin') fail(409, '不能处置管理员账号，请先撤销其权限');

      if (b.action === 'lift') {
        tx(() => {
          db.prepare("UPDATE users SET status='normal',limited_until=0,banned_until=0,status_reason='' WHERE id=?").run(user.id);
          notice(user.id, '账号处置已解除');
          audit(actor.id, 'lift_sanction', user.id, reason);
        });
        return send(200, { id: user.id, state: 'normal' });
      }

      // 限制与封禁都写绝对到期时间；再次处置按新截止时间重算，不叠加。
      const banned = b.action === 'ban';
      if (stateOf(user) === (banned ? 'banned' : 'limited')) fail(409, banned ? '该账号已处于封禁状态' : '该账号已处于限制状态');
      const until = now() + (banned ? BAN_DAYS : LIMIT_DAYS) * DAY;
      tx(() => {
        if (banned) {
          db.prepare("UPDATE users SET status='banned',banned_until=?,limited_until=0,status_reason=? WHERE id=?").run(until, reason, user.id);
          // 封禁立刻生效：清空会话，旧 cookie 下一次请求就会被拒。
          db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
          notice(user.id, `你的账号已被封禁 ${BAN_DAYS} 天。依据：${reason}`);
          audit(actor.id, 'ban_account', user.id, reason);
        } else {
          db.prepare("UPDATE users SET status='limited',limited_until=?,banned_until=0,status_reason=? WHERE id=?").run(until, reason, user.id);
          // 限制不踢下线：仍可登录、浏览、履约存量订单，只是不能新增交易。
          notice(user.id, `你的账号被限制 ${LIMIT_DAYS} 天，期间不能发布商品或下单。依据：${reason}`);
          audit(actor.id, 'limit_account', user.id, reason);
        }
      });
      return send(200, { id: user.id, state: banned ? 'banned' : 'limited', until });
    }
  };
}

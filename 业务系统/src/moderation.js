// A07：违规下架与异常订单处置（暂停 / 恢复 / 终止）。
// 订单的 paused 字段由 orders 表提供；本模块只补充暂停快照与终止原因，改 orders.js 的必要性为零。
const ACTIVE = ['pending', 'delivery', 'confirmation'];
const PENDING_HOURS = 48;
const DAY = 24 * 60 * 60 * 1000;

export function createModerationRoutes({ db, now, auth, body, fail, text, tx, audit, notice }) {
  // 迁移写成幂等的：老库补列，新库无操作。放在模块里是为了避开 database.js 的多人同改。
  const ensureSchema = () => {
    const columns = db.prepare('PRAGMA table_info(orders)').all().map(c => c.name);
    const extra = [
      ['paused_stage', 'TEXT'],
      ['paused_deadline', 'INTEGER'],
      ['paused_at', 'INTEGER'],
      ['pause_reason', "TEXT NOT NULL DEFAULT ''"],
      ['close_reason', "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [name, definition] of extra) {
      if (!columns.includes(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
    }
  };
  ensureSchema();

  const quotaOf = uid => db.prepare("SELECT COUNT(*) n FROM products WHERE owner_id=? AND status IN ('pending','live')").get(uid).n;
  const findOrder = id => db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  const findProduct = id => db.prepare('SELECT * FROM products WHERE id=?').get(id);

  // BR-22：只有「无进行中订单 + 发布者正常 + 认证有效 + 非违规终态 + 配额未满」才回到在售。
  // 违规终态不参与释放，避免处置被一次终止动作绕过。
  const releaseProduct = product => {
    if (product.status === 'violation') return 'violation';
    const owner = db.prepare('SELECT id,certified,status FROM users WHERE id=?').get(product.owner_id);
    const usable = Boolean(owner && owner.certified && owner.status === 'normal');
    const next = usable && quotaOf(owner.id) < 20 ? 'live' : 'off';
    db.prepare('UPDATE products SET status=? WHERE id=?').run(next, product.id);
    return next;
  };

  const logEvent = (orderId, actorId, action, detail) =>
    db.prepare('INSERT INTO events(order_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)')
      .run(orderId, actorId, action, detail, now()).lastInsertRowid;

  // 暂停：记住原阶段与原截止时间，恢复时据此回退；pending 的倒计时不冻结在原值上，避免恢复即超时。
  const pauseOrder = (actorId, order, reason) => {
    db.prepare('UPDATE orders SET paused=1,paused_stage=?,paused_deadline=?,paused_at=?,pause_reason=? WHERE id=?')
      .run(order.status, order.deadline, now(), reason, order.id);
    const event = logEvent(order.id, actorId, 'pause', reason);
    const message = `订单 #${order.id} 已被管理员暂停。依据：${reason}`;
    notice(order.buyer_id, 'order-pause:' + event, message);
    notice(order.seller_id, 'order-pause:' + event, message);
    audit(actorId, 'pause_order', order.id, reason);
    return event;
  };

  return async function handleModerationRequest(req, url, send) {
    const path = url.pathname;
    const method = req.method;

    // 处置台：已暂停的进行中订单 + 违规下架商品，方便管理员一眼看到待办。
    if (path === '/api/admin/moderation' && method === 'GET') {
      const actor = auth(req, 'admin');
      const orders = db.prepare(`
        SELECT o.id,o.product_id,o.buyer_id,o.seller_id,o.status,o.paused_stage,o.paused_at,o.paused_deadline,o.pause_reason,
               p.title product_title,b.username buyer_name,s.username seller_name
        FROM orders o JOIN products p ON p.id=o.product_id
        JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id
        WHERE o.paused=1 AND o.status IN ('pending','delivery','confirmation') ORDER BY o.id DESC
      `).all();
      const products = db.prepare("SELECT id,title,owner_id,status FROM products WHERE status='violation' ORDER BY id DESC").all();
      audit(actor.id, 'read_moderation', 'orders', `orders=${orders.length},products=${products.length}`);
      return send(200, { orders, products });
    }

    // 违规下架：终态，商品不再出现在任何公开入口；进行中的订单一并暂停，等待人工处理。
    let match = path.match(/^\/api\/admin\/products\/(\d+)\/violation$/);
    if (match && method === 'POST') {
      const actor = auth(req, 'admin');
      const b = await body(req);
      const reason = text(b.reason, 5, 200);
      const product = findProduct(Number(match[1]));
      if (!product) fail(404, '商品不存在');
      if (product.status === 'violation') fail(409, '商品已处于违规下架状态');
      const paused = tx(() => {
        db.prepare("UPDATE products SET status='violation' WHERE id=?").run(product.id);
        const active = db.prepare(`SELECT * FROM orders WHERE product_id=? AND status IN ('pending','delivery','confirmation')`).all(product.id);
        let count = 0;
        for (const order of active) {
          if (order.paused) continue;
          pauseOrder(actor.id, order, reason);
          count += 1;
        }
        const event = audit(actor.id, 'violation_takedown', product.id, reason).lastInsertRowid;
        notice(product.owner_id, 'product:' + event, `你的商品《${product.title}》因违规被下架。依据：${reason}`);
        return count;
      });
      return send(200, { id: product.id, status: 'violation', pausedOrders: paused });
    }

    // 异常订单：暂停 / 恢复 / 终止，三个动作都必须写原因并留痕。
    match = path.match(/^\/api\/admin\/orders\/(\d+)\/control$/);
    if (match && method === 'POST') {
      const actor = auth(req, 'admin');
      const b = await body(req);
      if (!['pause', 'resume', 'terminate'].includes(b.action)) fail(400, '处置动作须为暂停、恢复或终止');
      const reason = text(b.reason, 5, 200);
      const order = findOrder(Number(match[1]));
      if (!order) fail(404, '订单不存在');
      if (!ACTIVE.includes(order.status)) fail(409, '订单已结束，不能再处置');

      if (b.action === 'pause') {
        if (order.paused) fail(409, '订单已处于暂停状态');
        tx(() => pauseOrder(actor.id, order, reason));
        return send(200, { id: order.id, paused: true });
      }

      if (b.action === 'resume') {
        if (!order.paused) fail(409, '订单未被暂停，无需恢复');
        const stage = order.paused_stage || order.status;
        // 待确认阶段恢复时重设 48 小时，否则等于一恢复就超时。
        const deadline = stage === 'pending' ? now() + PENDING_HOURS * 60 * 60 * 1000 : order.deadline;
        tx(() => {
          db.prepare("UPDATE orders SET paused=0,status=?,deadline=?,paused_stage=NULL,paused_deadline=0,paused_at=0,pause_reason='' WHERE id=?")
            .run(stage, deadline, order.id);
          const event = logEvent(order.id, actor.id, 'resume', reason);
          const message = `订单 #${order.id} 已恢复，请继续处理。说明：${reason}`;
          notice(order.buyer_id, 'order-resume:' + event, message);
          notice(order.seller_id, 'order-resume:' + event, message);
          audit(actor.id, 'resume_order', order.id, reason);
        });
        return send(200, { id: order.id, paused: false, stage, deadline });
      }

      // 终止：订单进 closed 终态，商品按 BR-22 释放；商品本身是违规终态时保持不动。
      const result = tx(() => {
        db.prepare("UPDATE orders SET status='closed',close_reason=?,paused=0,paused_stage=NULL,paused_deadline=0,paused_at=0 WHERE id=?")
          .run(reason, order.id);
        const event = logEvent(order.id, actor.id, 'terminate', reason);
        const message = `订单 #${order.id} 已被管理员终止。依据：${reason}`;
        notice(order.buyer_id, 'order-terminate:' + event, message);
        notice(order.seller_id, 'order-terminate:' + event, message);
        audit(actor.id, 'terminate_order', order.id, reason);
        return releaseProduct(findProduct(order.product_id));
      });
      return send(200, { id: order.id, status: 'closed', productStatus: result });
    }
  };
}

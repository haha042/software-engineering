// 订单与履约模块。
// 本文件的 B02～B07 行为采用「默认实现口径」，#12 商品版本/订单快照契约尚未经跨组人工确认，
// 依据见 业务系统/docs/B02-B07_订单模块默认实现口径_待复核.md；不得据此宣称契约已冻结。
export function createOrderRoutes({db, now, auth, body, fail, text, images, amount, tx, quota, notice, session}) {
  const event = (o, u, action, detail = '') =>
    db.prepare('INSERT INTO events(order_id,actor_id,action,detail,created_at) VALUES(?,?,?,?,?)').run(o, u, action, detail, now());
  const release = p => {
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(p);
    const owner = db.prepare('SELECT * FROM users WHERE id=?').get(product.owner_id);
    db.prepare('UPDATE products SET status=? WHERE id=?').run(owner.certified && quota(owner.id) < 20 ? 'live' : 'off', p);
  };
  function expire() {
    tx(() => {
      for (const o of db.prepare("SELECT * FROM orders WHERE status='pending' AND paused=0 AND deadline<=?").all(now())) {
        db.prepare("UPDATE orders SET status='closed' WHERE id=?").run(o.id);
        release(o.product_id);
        event(o.id, null, 'timeout');
        notice(o.buyer_id, '订单超时关闭');
        notice(o.seller_id, '订单超时关闭');
      }
    });
  }

  const REVIEW_WINDOW = 14 * 24 * 60 * 60 * 1000;
  // B03：下单事务内把目标商品图片复制到订单侧，商品后续编辑删图不影响历史订单。
  const copyTargetImages = orderId => {
    const productId = db.prepare('SELECT product_id FROM orders WHERE id=?').get(orderId).product_id;
    const rows = db.prepare('SELECT id,data_url FROM product_images WHERE product_id=? ORDER BY id').all(productId);
    const insert = db.prepare("INSERT INTO order_images(order_id,kind,source_image_id,data_url) VALUES(?,?,?,?)");
    for (const img of rows) insert.run(orderId, 'target', img.id, img.data_url);
  };
  const targetImageUrls = orderId =>
    db.prepare("SELECT id FROM order_images WHERE order_id=? AND kind='target' ORDER BY id").all(orderId).map(x => `/api/order-images/${x.id}`);
  const orderPayload = o => {
    const imgs = targetImageUrls(o.id);
    return {
      ...o,
      snapshot: JSON.parse(o.snapshot),
      offer: o.offer ? JSON.parse(o.offer) : null,
      snapshotImages: imgs,
      // 旧订单无订单侧副本：明示兼容视图，不冒充「历史原图版本」。
      snapshotImageSource: imgs.length ? 'order' : 'product_legacy',
      events: db.prepare('SELECT actor_id,action,detail,created_at FROM events WHERE order_id=? ORDER BY id').all(o.id),
      cancelRequests: db.prepare('SELECT id,requested_by,requested_at,reason,status,responded_by,responded_at FROM cancel_requests WHERE order_id=? ORDER BY id').all(o.id),
      reviews: db.prepare('SELECT id,reviewer_id,reviewee_id,rating,content,created_at,reply,reply_at FROM reviews WHERE order_id=? ORDER BY id').all(o.id)
    };
  };

  async function handleOrderRequest(req, url, send, res) {
    const path = url.pathname;
    const method = req.method;
    if (path === '/api/orders' && method === 'GET') {
      const u = auth(req);
      return send(200, db.prepare('SELECT * FROM orders WHERE buyer_id=? OR seller_id=? ORDER BY id DESC').all(u.id, u.id).map(orderPayload));
    }
    if (path === '/api/orders' && method === 'POST') {
      const u = auth(req, 'student'), b = await body(req);
      const key = text(b.requestKey, 8, 100);
      // B02 默认口径：productVersion 可选；显式提交时严格校验，缺省沿用旧客户端行为（待 #12 确认后收紧）。
      if (b.productVersion !== undefined && (!Number.isInteger(b.productVersion) || b.productVersion < 1)) fail(400, '商品版本格式错误');
      const id = tx(() => {
        const old = db.prepare('SELECT * FROM orders WHERE buyer_id=? AND request_key=?').get(u.id, key);
        if (old) {
          const agreedVersion = JSON.parse(old.snapshot).version ?? 1;
          if (old.product_id !== b.productId
            || old.topup !== (b.topup === undefined ? 0 : amount(b.topup))
            || JSON.stringify(b.offer || null) !== (old.offer || 'null')
            || (b.payer || null) !== old.payer
            || (b.productVersion !== undefined && b.productVersion !== agreedVersion)) fail(409, '请求标识已用于不同参数');
          return old.id;
        }
        const p = db.prepare('SELECT * FROM products WHERE id=?').get(b.productId);
        if (!p || p.status !== 'live') fail(409, '商品不可交易');
        if (p.owner_id === u.id) fail(403, '不能下单本人商品');
        if (b.productVersion !== undefined && b.productVersion !== p.version) fail(409, '商品版本已更新，请刷新后重新确认', 'PRODUCT_VERSION_STALE');
        let offer = null, topup = 0, payer = null;
        if (p.trade_type === 'exchange') {
          offer = {
            title: text(b.offer?.title, 1, 80),
            description: text(b.offer?.description),
            condition: text(b.offer?.condition, 1, 40),
            images: images(b.offer?.images)
          };
          topup = amount(b.topup || 0);
          payer = topup ? b.payer : null;
          if (topup && !['buyer', 'seller'].includes(payer)) fail(400, '差价付款方向错误');
        }
        const r = db.prepare('INSERT INTO orders(product_id,buyer_id,seller_id,snapshot,offer,topup,payer,request_key,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(p.id, u.id, p.owner_id, JSON.stringify(p), offer ? JSON.stringify(offer) : null, topup, payer, key, now() + 172800000, now());
        const id = Number(r.lastInsertRowid);
        copyTargetImages(id);
        db.prepare("UPDATE products SET status='reserved' WHERE id=?").run(p.id);
        event(id, u.id, 'create');
        notice(p.owner_id, '有新订单等待确认');
        return id;
      });
      return send(201, { id });
    }

    let match = path.match(/^\/api\/orders\/(\d+)\/action$/);
    if (match && method === 'POST') {
      const u = auth(req, 'student'), b = await body(req);
      tx(() => {
        const o = db.prepare('SELECT * FROM orders WHERE id=?').get(+match[1]);
        if (!o || ![o.buyer_id, o.seller_id].includes(u.id)) fail(403, '不是订单参与者');
        if (o.paused) fail(409, '订单已暂停');
        const action = b.action;
        const assert = c => { if (!c) fail(409, '操作与当前角色或阶段不符'); };
        if (action === 'accept') {
          assert(o.status === 'pending' && u.id === o.seller_id && now() < o.deadline);
          db.prepare("UPDATE orders SET status='delivery' WHERE id=?").run(o.id);
        } else if (action === 'reject' || action === 'cancel') {
          assert(o.status === 'pending' && u.id === (action === 'reject' ? o.seller_id : o.buyer_id));
          // B04：拒单原因必填，校验在任何写操作之前，失败整体回滚。
          if (action === 'reject') {
            const reason = text(b.reason, 1, 500);
            db.prepare("UPDATE orders SET status='closed',reject_reason=? WHERE id=?").run(reason, o.id);
          } else {
            db.prepare("UPDATE orders SET status='cancelled' WHERE id=?").run(o.id);
          }
          release(o.product_id);
        } else if (action === 'request_cancel') {
          assert(o.status === 'delivery' && o.cancel_status !== 'pending');
          const reason = text(b.reason, 1, 500);
          db.prepare("INSERT INTO cancel_requests(order_id,requested_by,requested_at,reason,status) VALUES(?,?,?,?,'pending')")
            .run(o.id, u.id, now(), reason);
          db.prepare("UPDATE orders SET cancel_by=?,cancel_status='pending',cancel_reason=? WHERE id=?").run(u.id, reason, o.id);
        } else if (['withdraw_cancel', 'deny_cancel', 'agree_cancel'].includes(action)) {
          assert(o.status === 'delivery' && o.cancel_status === 'pending' && (action === 'withdraw_cancel' ? u.id === o.cancel_by : u.id !== o.cancel_by));
          const result = { withdraw_cancel: 'withdrawn', deny_cancel: 'denied', agree_cancel: 'agreed' }[action];
          db.prepare('UPDATE orders SET cancel_status=?,status=? WHERE id=?').run(result, action === 'agree_cancel' ? 'cancelled' : o.status, o.id);
          // B05：把回应人、回应时间、结果写回本次申请，申请编号即表主键。
          const pending = db.prepare("SELECT id FROM cancel_requests WHERE order_id=? AND status='pending' ORDER BY id DESC").get(o.id);
          if (pending) db.prepare('UPDATE cancel_requests SET status=?,responded_by=?,responded_at=? WHERE id=?').run(result, u.id, now(), pending.id);
          if (action === 'agree_cancel') release(o.product_id);
        } else if (action === 'deliver') {
          assert(o.status === 'delivery' && u.id === o.seller_id && o.cancel_status !== 'pending');
          const occurredAt = Number(b.occurredAt);
          if (!Number.isFinite(occurredAt) || occurredAt <= 0 || occurredAt > now()) fail(400, '实际交付时间不合法');
          const delivery = { location: text(b.location, 1, 200), note: text(b.note), occurredAt, recordedAt: now() };
          if (o.offer) {
            // B04：交换交付须分别记录双方物品；漏一件即拒绝且不改订单状态。
            const items = b.items;
            if (!items || typeof items !== 'object' || Array.isArray(items)
              || items.seller?.delivered !== true || items.buyer?.delivered !== true) fail(400, '交换交付须分别记录双方物品');
            const snapshot = JSON.parse(o.snapshot), offer = JSON.parse(o.offer);
            delivery.items = {
              seller: { productId: snapshot.id, title: snapshot.title, condition: snapshot.condition_text, delivered: true, recordedAt: now() },
              buyer: { productId: null, title: offer.title, condition: offer.condition, delivered: true, recordedAt: now() }
            };
          }
          db.prepare("UPDATE orders SET delivery=?,status='confirmation' WHERE id=?").run(JSON.stringify(delivery), o.id);
        } else if (action === 'confirm') {
          assert(o.status === 'confirmation');
          const field = u.id === o.buyer_id ? 'buyer_confirmed' : 'seller_confirmed';
          if (o[field]) return;
          db.prepare(`UPDATE orders SET ${field}=1 WHERE id=?`).run(o.id);
          if ((o.buyer_confirmed || field === 'buyer_confirmed') && (o.seller_confirmed || field === 'seller_confirmed')) {
            db.prepare("UPDATE orders SET status='completed',completed_at=? WHERE id=?").run(now(), o.id);
            db.prepare("UPDATE products SET status='sold' WHERE id=?").run(o.product_id);
          }
        } else fail(400, '不支持的动作');
        event(o.id, u.id, action, b.reason || '');
        notice(u.id === o.buyer_id ? o.seller_id : o.buyer_id, '订单状态更新：' + action);
      });
      return send(200, { ok: true });
    }

    // B03：订单侧图片按订单参与者授权；非参与者、未登录一律 404，不泄露资源存在性。
    match = path.match(/^\/api\/order-images\/(\d+)$/);
    if (match && method === 'GET') {
      const img = db.prepare('SELECT i.data_url,o.buyer_id,o.seller_id FROM order_images i JOIN orders o ON o.id=i.order_id WHERE i.id=?').get(+match[1]);
      const u = session(req);
      if (!img || !u || ![img.buyer_id, img.seller_id].includes(u.id)) fail(404, '图片不存在或不可见');
      const [prefix, data] = img.data_url.split(',');
      res.writeHead(200, { 'Content-Type': prefix.includes('png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, no-store' });
      return res.end(Buffer.from(data, 'base64'));
    }

    // B07：完成后 14 天内，双方各评价一次；原评价不可改删。
    match = path.match(/^\/api\/orders\/(\d+)\/reviews$/);
    if (match && method === 'POST') {
      const u = auth(req, 'student'), b = await body(req);
      const id = tx(() => {
        const o = db.prepare('SELECT * FROM orders WHERE id=?').get(+match[1]);
        if (!o || ![o.buyer_id, o.seller_id].includes(u.id)) fail(403, '不是订单参与者');
        if (o.status !== 'completed' || !o.completed_at) fail(409, '订单未完成，暂不能评价');
        if (now() - o.completed_at > REVIEW_WINDOW) fail(409, '评价期限为完成后14天内');
        if (db.prepare('SELECT id FROM reviews WHERE order_id=? AND reviewer_id=?').get(o.id, u.id)) fail(409, '每单每人只能评价一次');
        if (!Number.isInteger(b.rating) || b.rating < 1 || b.rating > 5) fail(400, '评分须为1～5星');
        const content = text(b.content, 1, 500);
        const reviewee = u.id === o.buyer_id ? o.seller_id : o.buyer_id;
        const r = db.prepare('INSERT INTO reviews(order_id,reviewer_id,reviewee_id,rating,content,created_at) VALUES(?,?,?,?,?,?)')
          .run(o.id, u.id, reviewee, b.rating, content, now());
        return Number(r.lastInsertRowid);
      });
      return send(201, { id });
    }
    match = path.match(/^\/api\/orders\/(\d+)\/reviews\/(\d+)\/reply$/);
    if (match && method === 'POST') {
      const u = auth(req, 'student'), b = await body(req);
      const id = tx(() => {
        const review = db.prepare('SELECT * FROM reviews WHERE id=? AND order_id=?').get(+match[2], +match[1]);
        if (!review) fail(404, '评价不存在');
        if (review.reviewee_id !== u.id) fail(403, '仅被评价人可回复');
        if (review.reply !== null) fail(409, '每条评价仅可回复一次');
        const content = text(b.content, 1, 500);
        db.prepare('UPDATE reviews SET reply=?,reply_at=? WHERE id=?').run(content, now(), review.id);
        return review.id;
      });
      return send(200, { id });
    }

    if (path === '/api/notifications' && method === 'GET') {
      const u = auth(req);
      return send(200, db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC').all(u.id));
    }
    match = path.match(/^\/api\/notifications\/(\d+)\/read$/);
    if (match && method === 'POST') {
      const u = auth(req);
      db.prepare('UPDATE notifications SET read_at=? WHERE id=? AND user_id=?').run(now(), +match[1], u.id);
      return send(200, { ok: true });
    }
  }

  return { handleOrderRequest, expire };
}

// 管理员会话取证（BR-23）：只读、必填理由、每次调用都留痕，不提供导出与批量下载。
// 只返回消息文本与参与人用户名，不含手机号、学号等与争议处置无关的信息。
export function createAdminConversationRoutes({ db, auth, fail, audit }) {
  return async function handleAdminConversationRequest(req, url, send) {
    const match = url.pathname.match(/^\/api\/admin\/conversations\/(\d+)$/);
    if (!match || req.method !== 'GET') return;
    const actor = auth(req, 'admin');
    const reason = (url.searchParams.get('reason') || '').trim();
    if (reason.length < 4 || reason.length > 200) fail(400, '查阅理由须为4～200字符');
    const id = Number(match[1]);
    const before = url.searchParams.get('before');
    const boundary = before === null ? null : Number(before);
    if (before !== null && (!/^\d+$/.test(before) || !Number.isSafeInteger(boundary) || boundary < 1)) {
      fail(400, '消息游标无效');
    }
    const row = db.prepare(`SELECT c.id,c.product_id,c.buyer_id,c.seller_id,c.created_at,p.title product_title
      FROM conversations c JOIN products p ON p.id=c.product_id WHERE c.id=?`).get(id);
    if (!row) fail(404, '会话不存在');
    const buyer = db.prepare('SELECT id,username FROM users WHERE id=?').get(row.buyer_id);
    const seller = db.prepare('SELECT id,username FROM users WHERE id=?').get(row.seller_id);
    // 与前台一致：一页最多 100 条，多取一条用于判断是否还有更早的消息。
    const rows = db.prepare('SELECT id,sender_id,content,created_at FROM messages WHERE conversation_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 101').all(id,boundary,boundary);
    audit(actor.id, 'read_conversation', id, `reason=${reason}${boundary===null ? '' : ' before='+boundary}`);
    return send(200, {
      id: row.id,
      product_id: row.product_id,
      product_title: row.product_title,
      buyer: { id: buyer.id, username: buyer.username },
      seller: { id: seller.id, username: seller.username },
      messages: rows.slice(0, 100).reverse(),
      hasMore: rows.length > 100
    });
  };
}

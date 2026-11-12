const TRADE_TYPES = ['sale', 'gift', 'exchange'];
// 关键词按字面匹配：用户输入的 % 与 _ 不当通配符使用。
const like = s => '%' + s.replace(/[\\%_]/g, c => '\\' + c) + '%';
export function createProductRoutes({db, now, auth, body, fail, text, session, images, amount, tx, quota, publicProduct}) {
  // 价格筛选以「元」接收，入库与比较统一用「分」，避免浮点误差。
  const priceCents = (value, name) => {
    if (value === null || value === '') return null;
    if (!/^\d{1,5}(\.\d{1,2})?$/.test(value)) fail(400, `${name}须为0～99999.99的数字，最多两位小数`);
    return Math.round(Number(value) * 100);
  };
  return async function handleProductRequest(req, url, send, res) {
    const path = url.pathname;
    const method = req.method;
    if (path === '/api/products' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const category = (url.searchParams.get('category') || '').trim();
      const condition = (url.searchParams.get('condition') || '').trim();
      const tradeType = (url.searchParams.get('tradeType') || '').trim();
      if (tradeType && !TRADE_TYPES.includes(tradeType)) fail(400, '交易方式须为出售、免费转让或以物易物');
      // 排序：默认按最新发布。价格排序时交换单没有价格，统一排在最后；
      // 同值一律用 id 兜底，保证同价商品的先后顺序稳定、翻页不抖动。
      const sort = (url.searchParams.get('sort') || 'latest').trim();
      const SORTS = {
        latest: 'p.id DESC',
        oldest: 'p.id ASC',
        price_asc: 'CASE WHEN p.price IS NULL THEN 1 ELSE 0 END, p.price ASC, p.id DESC',
        price_desc: 'CASE WHEN p.price IS NULL THEN 1 ELSE 0 END, p.price DESC, p.id DESC'
      };
      if (!SORTS[sort]) fail(400, '排序方式须为最新发布、最早发布、价格从低到高或价格从高到低');
      const min = priceCents(url.searchParams.get('minPrice'), '最低价');
      const max = priceCents(url.searchParams.get('maxPrice'), '最高价');
      if (min !== null && max !== null && min > max) fail(400, '最低价不能高于最高价');
      const where = ["p.status='live'"], params = [];
      if (q) {
        where.push("(p.title LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\')");
        params.push(like(q), like(q));
      }
      if (category) { where.push('p.category=?'); params.push(category); }
      if (condition) { where.push('p.condition_text=?'); params.push(condition); }
      if (tradeType) { where.push('p.trade_type=?'); params.push(tradeType); }
      // 交换单价格为空，价格区间只对出售与赠送生效。
      if (min !== null) { where.push('p.price IS NOT NULL AND p.price>=?'); params.push(min); }
      if (max !== null) { where.push('p.price IS NOT NULL AND p.price<=?'); params.push(max); }
      const rows = db.prepare(`SELECT p.*,u.username owner_name FROM products p JOIN users u ON u.id=p.owner_id WHERE ${where.join(' AND ')} ORDER BY ${SORTS[sort]}`).all(...params);
      return send(200, rows.map(publicProduct));
    }
    if (path === '/api/products/facets' && method === 'GET') {
      const values = column => db.prepare(`SELECT ${column} v,COUNT(*) n FROM products WHERE status='live' GROUP BY ${column} ORDER BY n DESC,${column} ASC`).all().map(r => r.v);
      return send(200, {categories: values('category'), conditions: values('condition_text')});
    }
    if (path === '/api/products/mine' && method === 'GET') { const u = auth(req); return send(200, db.prepare('SELECT * FROM products WHERE owner_id=? ORDER BY id DESC').all(u.id).map(publicProduct)); }
    // —— 草稿（C03）：每人一份，status='draft'，不进公开列表、不占发布配额 ——
    const myDraft = uid => db.prepare("SELECT * FROM products WHERE owner_id=? AND status='draft'").get(uid);
    const draftText = (value, max) => String(value === undefined || value === null ? '' : value).trim().slice(0, max);
    const draftInput = b => ({
      title: draftText(b.title, 80),
      category: draftText(b.category, 40),
      condition: draftText(b.condition, 40),
      description: draftText(b.description, 2000),
      tradeType: ['sale', 'gift', 'exchange'].includes(b.tradeType) ? b.tradeType : 'sale',
      price: b.tradeType === 'exchange' || b.price === '' || b.price === undefined || b.price === null ? null : amount(typeof b.price === 'number' ? b.price : Number(b.price)),
      expectation: draftText(b.expectation, 2000),
      deliveryLocation: draftText(b.deliveryLocation, 200),
      images: b.images === undefined ? null : images(b.images)
    });
    if (path === '/api/products/draft' && method === 'GET') {
      const u = auth(req, 'student');
      const d = myDraft(u.id);
      if (!d) return send(200, { draft: null });
      const imageIds = db.prepare('SELECT id FROM product_images WHERE product_id=? ORDER BY id').all(d.id).map(r => r.id);
      return send(200, { draft: { ...publicProduct(d), imageIds } });
    }
    if (path === '/api/products/draft' && method === 'PUT') {
      const u = auth(req, 'student'), b = await body(req), f = draftInput(b);
      const id = tx(() => {
        const d = myDraft(u.id);
        if (d) {
          db.prepare('UPDATE products SET title=?,category=?,condition_text=?,description=?,trade_type=?,price=?,expectation=?,delivery_location=? WHERE id=?')
            .run(f.title, f.category, f.condition, f.description, f.tradeType, f.price, f.expectation, f.deliveryLocation, d.id);
          if (f.images) {
            db.prepare('DELETE FROM product_images WHERE product_id=?').run(d.id);
            for (const img of f.images) db.prepare('INSERT INTO product_images(product_id,data_url) VALUES(?,?)').run(d.id, img);
          }
          return d.id;
        }
        const r = db.prepare("INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,expectation,delivery_location,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,'draft',?)")
          .run(u.id, f.title, f.category, f.condition, f.description, f.tradeType, f.price, f.expectation, f.deliveryLocation, now());
        const newId = Number(r.lastInsertRowid);
        for (const img of (f.images || [])) db.prepare('INSERT INTO product_images(product_id,data_url) VALUES(?,?)').run(newId, img);
        return newId;
      });
      return send(200, { id, savedAt: now() });
    }
    if (path === '/api/products/draft' && method === 'DELETE') {
      const u = auth(req, 'student'), d = myDraft(u.id);
      if (d) tx(() => {
        db.prepare('DELETE FROM product_images WHERE product_id=?').run(d.id);
        db.prepare('DELETE FROM products WHERE id=?').run(d.id);
      });
      return send(200, { ok: true, removed: Boolean(d) });
    }
    if (path === '/api/products' && method === 'POST') {
      const u = auth(req, 'student'), b = await body(req), type = b.tradeType;
      if (!['sale', 'gift', 'exchange'].includes(type)) fail(400, '交易方式错误');
      const price = type === 'exchange' ? null : type === 'gift' ? 0 : amount(b.price);
      if (type === 'sale' && price <= 0) fail(400, '出售价格须大于0');
      const expectation = type === 'exchange' ? text(b.expectation) : '';
      const imgs = b.images === undefined ? null : images(b.images);
      const draftId = b.draftId ? Number(b.draftId) : null;
      const id = tx(() => {
        const draft = draftId ? db.prepare("SELECT * FROM products WHERE id=? AND owner_id=? AND status='draft'").get(draftId, u.id) : null;
        if (draftId && !draft) fail(400, '草稿不存在或已提交');
        if (quota(u.id) >= 20) fail(409, '待审核及在售最多20件');
        const keepImages = draft && imgs === null;
        if (!draft && (!imgs || !imgs.length)) fail(400, '请至少上传一张图片');
        const values = [text(b.title, 1, 80), text(b.category, 1, 40), text(b.condition, 1, 40), text(b.description), type, price, expectation, text(b.deliveryLocation, 1, 200), now()];
        let productId;
        if (draft) {
          db.prepare("UPDATE products SET title=?,category=?,condition_text=?,description=?,trade_type=?,price=?,expectation=?,delivery_location=?,created_at=?,status='pending',review_reason=NULL WHERE id=?")
            .run(...values, draft.id);
          productId = draft.id;
        } else {
          const r = db.prepare('INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,expectation,delivery_location,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(u.id, ...values);
          productId = Number(r.lastInsertRowid);
        }
        if (!keepImages) {
          db.prepare('DELETE FROM product_images WHERE product_id=?').run(productId);
          for (const img of (imgs || [])) db.prepare('INSERT INTO product_images(product_id,data_url) VALUES(?,?)').run(productId, img);
        }
        return productId;
      });
      return send(201, { id, status: 'pending' });
    }
    // —— 编辑与驳回重提（C04）：驳回/在售可改，改完重新进入审核；预订中、审核中、已成交、草稿、已下架不允许 ——
    if (method === 'PATCH' && /^\/api\/products\/\d+$/.test(path)) {
      const u = auth(req, 'student');
      const id = Number(path.slice(path.lastIndexOf('/') + 1));
      const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      if (!p || (p.owner_id !== u.id && u.role !== 'admin')) fail(404, '物品不存在');
      if (p.status === 'reserved') fail(409, '预订中的物品不能修改，请等这笔订单结束');
      if (p.status === 'pending') fail(409, '审核中的物品不能修改，请等审核结果');
      if (p.status === 'sold') fail(409, '已成交的物品不能修改');
      if (p.status === 'draft') fail(409, '草稿请用草稿接口保存');
      if (p.status === 'off') fail(409, '已下架的物品不能直接修改，请先重新上架');
      const b = await body(req);
      const type = b.tradeType === undefined ? p.trade_type : b.tradeType;
      if (!['sale', 'gift', 'exchange'].includes(type)) fail(400, '交易方式错误');
      const rawPrice = b.price === undefined ? p.price / 100 : (typeof b.price === 'number' ? b.price : Number(b.price));
      const price = type === 'exchange' ? null : type === 'gift' ? 0 : amount(rawPrice);
      if (type === 'sale' && price <= 0) fail(400, '出售价格须大于0');
      const expectation = type === 'exchange' ? text(b.expectation === undefined ? p.expectation : b.expectation) : '';
      const imgs = b.images === undefined ? null : images(b.images);
      tx(() => {
        db.prepare("UPDATE products SET title=?,category=?,condition_text=?,description=?,trade_type=?,price=?,expectation=?,delivery_location=?,status='pending',review_reason=NULL WHERE id=?")
          .run(text(b.title === undefined ? p.title : b.title, 1, 80),
            text(b.category === undefined ? p.category : b.category, 1, 40),
            text(b.condition === undefined ? p.condition_text : b.condition, 1, 40),
            text(b.description === undefined ? p.description : b.description),
            type, price, expectation,
            text(b.deliveryLocation === undefined ? p.delivery_location : b.deliveryLocation, 1, 200),
            id);
        if (imgs) {
          db.prepare('DELETE FROM product_images WHERE product_id=?').run(id);
          for (const img of imgs) db.prepare('INSERT INTO product_images(product_id,data_url) VALUES(?,?)').run(id, img);
        }
      });
      const updated = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      return send(200, { ...publicProduct(updated), resubmitted: updated.status === 'pending' });
    }
    let match = path.match(/^\/api\/products\/(\d+)$/); if (match && method === 'GET') { const p = db.prepare('SELECT p.*,u.username owner_name FROM products p JOIN users u ON u.id=p.owner_id WHERE p.id=?').get(+match[1]); if (!p) fail(404, '商品不存在'); const u = session(req); const participant = u && db.prepare('SELECT id FROM orders WHERE product_id=? AND (buyer_id=? OR seller_id=?)').get(p.id, u.id, u.id); if (p.status !== 'live' && u?.id !== p.owner_id && u?.role !== 'admin' && !participant) fail(404, '商品不存在或不可见'); return send(200, publicProduct(p)) }
    match = path.match(/^\/api\/images\/(\d+)$/); if (match && method === 'GET') { const img = db.prepare('SELECT i.*,p.status,p.owner_id FROM product_images i JOIN products p ON p.id=i.product_id WHERE i.id=?').get(+match[1]); if (!img) fail(404, '图片不存在'); const u = session(req); if (img.status !== 'live' && u?.id !== img.owner_id && u?.role !== 'admin' && !(u && db.prepare('SELECT id FROM orders WHERE product_id=? AND (buyer_id=? OR seller_id=?)').get(img.product_id, u.id, u.id))) fail(404, '图片不可见'); const [prefix, data] = img.data_url.split(','); res.writeHead(200, { 'Content-Type': prefix.includes('png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, no-store' }); return res.end(Buffer.from(data, 'base64')) }
  }
}

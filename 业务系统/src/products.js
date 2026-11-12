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
    if (path === '/api/products' && method === 'POST') { const u = auth(req, 'student'), b = await body(req); const type = b.tradeType; if (!['sale', 'gift', 'exchange'].includes(type)) fail(400, '交易方式错误'); const price = type === 'exchange' ? null : type === 'gift' ? 0 : amount(b.price); if (type === 'sale' && price <= 0) fail(400, '出售价格须大于0'); const expectation = type === 'exchange' ? text(b.expectation) : ''; const imgs = images(b.images); const data = [u.id, text(b.title, 1, 80), text(b.category, 1, 40), text(b.condition, 1, 40), text(b.description), type, price, expectation, text(b.deliveryLocation, 1, 200), now()]; const id = tx(() => { if (quota(u.id) >= 20) fail(409, '待审核及在售最多20件'); const r = db.prepare('INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,expectation,delivery_location,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(...data); const id = Number(r.lastInsertRowid); for (const img of imgs) db.prepare('INSERT INTO product_images(product_id,data_url) VALUES(?,?)').run(id, img); return id }); return send(201, {id, status: 'pending' }) }
    let match = path.match(/^\/api\/products\/(\d+)$/); if (match && method === 'GET') { const p = db.prepare('SELECT p.*,u.username owner_name FROM products p JOIN users u ON u.id=p.owner_id WHERE p.id=?').get(+match[1]); if (!p) fail(404, '商品不存在'); const u = session(req); const participant = u && db.prepare('SELECT id FROM orders WHERE product_id=? AND (buyer_id=? OR seller_id=?)').get(p.id, u.id, u.id); if (p.status !== 'live' && u?.id !== p.owner_id && u?.role !== 'admin' && !participant) fail(404, '商品不存在或不可见'); return send(200, publicProduct(p)) }
    match = path.match(/^\/api\/images\/(\d+)$/); if (match && method === 'GET') { const img = db.prepare('SELECT i.*,p.status,p.owner_id FROM product_images i JOIN products p ON p.id=i.product_id WHERE i.id=?').get(+match[1]); if (!img) fail(404, '图片不存在'); const u = session(req); if (img.status !== 'live' && u?.id !== img.owner_id && u?.role !== 'admin' && !(u && db.prepare('SELECT id FROM orders WHERE product_id=? AND (buyer_id=? OR seller_id=?)').get(img.product_id, u.id, u.id))) fail(404, '图片不可见'); const [prefix, data] = img.data_url.split(','); res.writeHead(200, { 'Content-Type': prefix.includes('png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'private, no-store' }); return res.end(Buffer.from(data, 'base64')) }
  }
}

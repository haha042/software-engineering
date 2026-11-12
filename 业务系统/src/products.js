export function createProductRoutes({db, now, auth, body, fail, text, session, images, amount, tx, quota, publicProduct}) {
  // 分类校验：只接受启用中的分类 id，文本 category 仅作历史兼容提示（见 docs/分类字段与历史商品兼容规则.md）。
  function resolveCategory(input) {
    if (input.categoryId === undefined || input.categoryId === null || input.categoryId === '') {
      if (typeof input.category === 'string' && input.category.trim()) fail(400, '请使用 categoryId 选择分类');
      fail(400, '请选择分类');
    }
    const id = Number(input.categoryId);
    if (!Number.isInteger(id) || id <= 0) fail(400, '分类不存在');
    const row = db.prepare('SELECT id,name,status FROM categories WHERE id=?').get(id);
    if (!row) fail(400, '分类不存在');
    if (row.status !== 'active') fail(400, '分类已停用，请重新选择');
    return row;
  }
  return async function handleProductRequest(req, url, send, res) {
    const path = url.pathname;
    const method = req.method;
    if(path==='/api/products'&&method==='GET'){const q=url.searchParams.get('q')||'';return send(200,db.prepare("SELECT p.*,u.username owner_name FROM products p JOIN users u ON u.id=p.owner_id WHERE p.status='live' AND p.title LIKE ? ORDER BY p.id DESC").all('%'+q+'%').map(publicProduct))}
    if(path==='/api/products/mine'&&method==='GET'){const u=auth(req);return send(200,db.prepare('SELECT * FROM products WHERE owner_id=? ORDER BY id DESC').all(u.id).map(publicProduct))}
    if(path==='/api/products'&&method==='POST'){const u=auth(req,'student'),b=await body(req);const type=b.tradeType;if(!['sale','gift','exchange'].includes(type))fail(400,'交易方式错误');const price=type==='exchange'?null:type==='gift'?0:amount(b.price);if(type==='sale'&&price<=0)fail(400,'出售价格须大于0');const expectation=type==='exchange'?text(b.expectation):'';const imgs=images(b.images);const category=resolveCategory(b);const data=[u.id,text(b.title,1,80),category.name,text(b.condition,1,40),text(b.description),type,price,expectation,text(b.deliveryLocation,1,200),now(),category.id];const id=tx(()=>{if(quota(u.id)>=20)fail(409,'待审核及在售最多20件');const r=db.prepare('INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,expectation,delivery_location,created_at,category_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(...data);const id=Number(r.lastInsertRowid);for(const img of imgs)db.prepare('INSERT INTO product_images(product_id,data_url) VALUES(?,?)').run(id,img);return id});return send(201,{id,status:'pending'})}
    let match=path.match(/^\/api\/products\/(\d+)$/);if(match&&method==='GET'){const p=db.prepare('SELECT p.*,u.username owner_name FROM products p JOIN users u ON u.id=p.owner_id WHERE p.id=?').get(+match[1]);if(!p)fail(404,'商品不存在');const u=session(req);const participant=u&&db.prepare('SELECT id FROM orders WHERE product_id=? AND (buyer_id=? OR seller_id=?)').get(p.id,u.id,u.id);if(p.status!=='live'&&u?.id!==p.owner_id&&u?.role!=='admin'&&!participant)fail(404,'商品不存在或不可见');return send(200,publicProduct(p))}
    match=path.match(/^\/api\/images\/(\d+)$/);if(match&&method==='GET'){const img=db.prepare('SELECT i.*,p.status,p.owner_id FROM product_images i JOIN products p ON p.id=i.product_id WHERE i.id=?').get(+match[1]);if(!img)fail(404,'图片不存在');const u=session(req);if(img.status!=='live'&&u?.id!==img.owner_id&&u?.role!=='admin'&&!(u&&db.prepare('SELECT id FROM orders WHERE product_id=? AND (buyer_id=? OR seller_id=?)').get(img.product_id,u.id,u.id)))fail(404,'图片不可见');const [prefix,data]=img.data_url.split(',');res.writeHead(200,{'Content-Type':prefix.includes('png')?'image/png':'image/jpeg','Cache-Control':'private, no-store'});return res.end(Buffer.from(data,'base64'))}
  }
}

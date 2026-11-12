// 单级分类维护（A02 / Issue #5）。
// 规则依据：docs/分类字段与历史商品兼容规则.md —— 分类停用不下架商品，仅限制发布与编辑。
export function createCategoryRoutes({db, now, auth, body, fail, text, tx, audit}) {
  const LIST_SQL = 'SELECT id,name,status,sort,created_at,disabled_at FROM categories ORDER BY sort,id';
  return async function handleCategoryRequest(req, url, send) {
    const path = url.pathname;
    const method = req.method;
    if (path === '/api/categories' && method === 'GET') {
      return send(200, db.prepare("SELECT id,name,sort FROM categories WHERE status='active' ORDER BY sort,id").all());
    }
    if (path === '/api/admin/categories' && method === 'GET') {
      const actor = auth(req, 'admin');
      const rows = db.prepare(`SELECT c.id,c.name,c.status,c.sort,c.created_at,c.disabled_at,
       (SELECT COUNT(*) FROM products p WHERE p.category_id=c.id) product_count
       FROM categories c ORDER BY c.sort,c.id`).all();
      audit(actor.id, 'read_categories', 'categories', `count=${rows.length}`);
      return send(200, {categories: rows});
    }
    if (path === '/api/admin/categories' && method === 'POST') {
      const actor = auth(req, 'admin');
      const input = await body(req);
      const name = text(input.name, 1, 20);
      const sort = Number.isInteger(input.sort) ? input.sort : 0;
      if (sort < 0 || sort > 9999) fail(400, '排序值须为 0～9999 的整数');
      const id = tx(() => {
        if (db.prepare('SELECT id FROM categories WHERE name=?').get(name)) fail(409, '分类名称已存在');
        const result = db.prepare('INSERT INTO categories(name,status,sort,created_at) VALUES(?,?,?,?)').run(name, 'active', sort, now());
        const created = Number(result.lastInsertRowid);
        audit(actor.id, 'create_category', created, name);
        return created;
      });
      return send(201, {id, name, status: 'active', sort});
    }
    const one = path.match(/^\/api\/admin\/categories\/(\d+)$/);
    if (one && method === 'PATCH') {
      const actor = auth(req, 'admin');
      const input = await body(req);
      const id = Number(one[1]);
      const current = db.prepare('SELECT * FROM categories WHERE id=?').get(id);
      if (!current) fail(404, '分类不存在');
      const fields = {};
      if (input.name !== undefined) {
        const name = text(input.name, 1, 20);
        if (db.prepare('SELECT id FROM categories WHERE name=? AND id<>?').get(name, id)) fail(409, '分类名称已存在');
        fields.name = name;
      }
      if (input.sort !== undefined) {
        if (!Number.isInteger(input.sort) || input.sort < 0 || input.sort > 9999) fail(400, '排序值须为 0～9999 的整数');
        fields.sort = input.sort;
      }
      if (input.status !== undefined) {
        if (!['active', 'disabled'].includes(input.status)) fail(400, '状态只能为 active 或 disabled');
        fields.status = input.status;
      }
      if (!Object.keys(fields).length) fail(400, '没有需要修改的内容');
      const changes = [];
      const values = [];
      for (const [key, value] of Object.entries(fields)) {
        changes.push(`${key}=?`);
        values.push(value);
      }
      if (fields.status === 'disabled' && current.status !== 'disabled') {
        changes.push('disabled_at=?');
        values.push(now());
      }
      if (fields.status === 'active' && current.status === 'disabled') {
        changes.push('disabled_at=NULL');
      }
      values.push(id);
      tx(() => {
        db.prepare(`UPDATE categories SET ${changes.join(',')} WHERE id=?`).run(...values);
        audit(actor.id, fields.status ? `category_${fields.status}` : 'update_category', id, JSON.stringify(fields));
      });
      return send(200, {ok: true, id});
    }
    return false;
  };
}

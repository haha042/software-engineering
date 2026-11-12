import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.js';
import {openDatabase} from '../src/database.js';

async function start(t, options = {}) {
  const app = createApp({database: ':memory:', adminPassword: 'AdminPassword123!', ...options});
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => app.server.close(r)));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const client = () => ({cookie: '', csrf: ''});
  async function req(c, path, method = 'GET', payload, expected = 200) {
    const r = await fetch(base + '/api' + path, {
      method,
      headers: {cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json'},
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    if (r.headers.get('set-cookie')) c.cookie = r.headers.get('set-cookie').split(';')[0];
    const b = await r.json();
    assert.equal(r.status, expected, JSON.stringify(b));
    if (b.csrf) c.csrf = b.csrf;
    return b;
  }
  return {app, req, client};
}

test('分类维护：公开只读、管理员增改停用、未认证不可维护', async t => {
  const {req, client} = await start(t);
  const admin = client(), student = client();

  assert.deepEqual(await req(client(), '/categories'), []);
  await req(student, '/register', 'POST', {username: 'cat_student', password: 'Password123'}, 201);
  await req(student, '/login', 'POST', {username: 'cat_student', password: 'Password123'});
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});

  // 未登录与普通学生都不能读管理列表，也不能写入
  await req(client(), '/admin/categories', 'GET', undefined, 401);
  await req(student, '/admin/categories', 'GET', undefined, 403);
  await req(student, '/admin/categories', 'POST', {name: '违规分类'}, 403);
  assert.deepEqual(await req(client(), '/categories'), []);

  // 名称与排序值校验
  await req(admin, '/admin/categories', 'POST', {name: ''}, 400);
  await req(admin, '/admin/categories', 'POST', {name: '  '}, 400);
  await req(admin, '/admin/categories', 'POST', {name: '分'.repeat(21)}, 400);
  await req(admin, '/admin/categories', 'POST', {name: '书籍教材', sort: -1}, 400);

  const books = await req(admin, '/admin/categories', 'POST', {name: '书籍教材', sort: 20}, 201);
  const life = await req(admin, '/admin/categories', 'POST', {name: '生活用品', sort: 10}, 201);
  await req(admin, '/admin/categories', 'POST', {name: '书籍教材'}, 409);

  // 公开列表只返回启用分类，按 sort 升序
  assert.deepEqual((await req(client(), '/categories')).map(c => c.name), ['生活用品', '书籍教材']);

  // 重命名与重排
  await req(admin, '/admin/categories/' + books.id, 'PATCH', {name: '教材资料'});
  await req(admin, '/admin/categories/' + books.id, 'PATCH', {name: '生活用品'}, 409);
  await req(admin, '/admin/categories/' + books.id, 'PATCH', {sort: 5});
  assert.deepEqual((await req(client(), '/categories')).map(c => c.name), ['教材资料', '生活用品']);
  await req(admin, '/admin/categories/' + books.id, 'PATCH', {}, 400);
  await req(admin, '/admin/categories/' + books.id, 'PATCH', {status: 'deleted'}, 400);
  await req(admin, '/admin/categories/9999', 'PATCH', {name: '不存在的分类'}, 404);

  // 停用：公开列表消失，管理列表仍可见并记录停用时间；再启用可恢复
  await req(admin, '/admin/categories/' + life.id, 'PATCH', {status: 'disabled'});
  assert.deepEqual((await req(client(), '/categories')).map(c => c.name), ['教材资料']);
  const all = (await req(admin, '/admin/categories')).categories;
  const disabled = all.find(c => c.id === life.id);
  assert.equal(disabled.status, 'disabled');
  assert.ok(disabled.disabled_at > 0);
  await req(admin, '/admin/categories/' + life.id, 'PATCH', {status: 'active'});
  assert.deepEqual((await req(client(), '/categories')).map(c => c.name), ['教材资料', '生活用品']);
  assert.equal((await req(admin, '/admin/categories')).categories.find(c => c.id === life.id).disabled_at, null);

  // 停用分类不影响已有商品：商品行与状态保持不变
  const before = (await req(admin, '/admin/categories')).categories.find(c => c.id === books.id);
  await req(admin, '/admin/categories/' + books.id, 'PATCH', {status: 'disabled'});
  const after = (await req(admin, '/admin/categories')).categories.find(c => c.id === books.id);
  assert.equal(after.product_count, before.product_count);
});

test('历史商品分类迁移：按旧文本建分类并回填 category_id，且可重复启动', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'campus-cat-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const file = join(dir, 'data', 'campus.sqlite');

  const first = openDatabase(file);
  first.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('legacy','x','student',1)").run();
  const insert = first.prepare(`INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,expectation,status,created_at)
    VALUES(1,?,?,?,?,'sale',100,'','live',1)`);
  insert.run('旧书', '书籍教材', '九成新', '有笔记');
  insert.run('旧台灯', '生活用品', '八成新', '可正常使用');
  first.close();

  const second = openDatabase(file);
  const names = second.prepare('SELECT name FROM categories ORDER BY name').all().map(r => r.name);
  assert.deepEqual(names, ['书籍教材', '生活用品']);
  const rows = second.prepare('SELECT p.title, c.name FROM products p JOIN categories c ON c.id=p.category_id ORDER BY p.id').all();
  assert.deepEqual(rows.map(r => [r.title, r.name]), [['旧书', '书籍教材'], ['旧台灯', '生活用品']]);
  const count = second.prepare('SELECT COUNT(*) n FROM categories').get().n;
  second.close();

  // 再次启动不重复建分类、不回填空值
  const third = openDatabase(file);
  assert.equal(third.prepare('SELECT COUNT(*) n FROM categories').get().n, count);
  assert.equal(third.prepare('SELECT COUNT(*) n FROM products WHERE category_id IS NULL').get().n, 0);
  third.close();
});

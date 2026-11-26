import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.js';

test('历史分类回填只做一次：改名重启不复活旧名', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'category-migration-'));
  const file = join(dir, 'store.sqlite');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const boot = async () => {
    const app = createApp({database: file, adminPassword: 'AdminPassword123!'});
    await new Promise(r => app.server.listen(0, '127.0.0.1', r));
    return {app, base: 'http://127.0.0.1:' + app.server.address().port};
  };
  const client = () => ({cookie: '', csrf: ''});
  const mk = env => async (c, path, method = 'GET', body, status = 200) => {
    const r = await fetch(env.base + '/api' + path, {method, headers: {cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
    if (r.headers.get('set-cookie')) c.cookie = r.headers.get('set-cookie').split(';')[0];
    const data = await r.json();
    assert.equal(r.status, status, JSON.stringify(data));
    if (data.csrf) c.csrf = data.csrf;
    return data;
  };

  let env = await boot(), req = mk(env);
  const admin = client(), seller = client();
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  const sellerId = (await req(seller, '/register', 'POST', {username: 'seller', password: 'Password123'}, 201)).id;
  env.app.db.prepare('UPDATE users SET certified=1 WHERE id=?').run(sellerId);
  await req(seller, '/login', 'POST', {username: 'seller', password: 'Password123'});
  const books = await req(admin, '/admin/categories', 'POST', {name: '书籍教材'}, 201);
  await req(seller, '/products', 'POST', {title: '高数教材', categoryId: books.id, condition: '八成新', description: '有笔记', tradeType: 'sale', price: 25, deliveryLocation: '北门', images: [png]}, 201);

  // 改名后重启：旧名不能从历史商品文本里被补建回来。
  await req(admin, '/admin/categories/' + books.id, 'PATCH', {name: '教材资料'});
  await new Promise(r => env.app.server.close(r));
  env = await boot(); req = mk(env);
  const admin2 = client();
  await req(admin2, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  const names = (await req(admin2, '/admin/categories')).categories.map(c => c.name);
  assert.deepEqual(names.sort(), ['教材资料']);
  assert.equal(env.app.db.prepare('PRAGMA user_version').get().user_version, 1);

  // 迁移只跑一次：即使之后又出现没有 category_id 的历史文本，也不会再造分类。
  env.app.db.prepare("INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(sellerId, '遗留商品', '旧分类名', '九成新', '迁移后写入的孤儿行', 'sale', 1000, 'live', Date.now());
  await new Promise(r => env.app.server.close(r));
  env = await boot(); req = mk(env);
  const admin3 = client();
  await req(admin3, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  const after = (await req(admin3, '/admin/categories')).categories.map(c => c.name);
  assert.deepEqual(after.sort(), ['教材资料']);
  assert.equal(env.app.db.prepare('PRAGMA user_version').get().user_version, 1);
  await new Promise(r => env.app.server.close(r));
});

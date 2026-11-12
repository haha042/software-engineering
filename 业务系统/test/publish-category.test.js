import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('发布商品：只接受启用中的 categoryId，文本分类与停用分类被拒绝', async t => {
  const app = createApp({database: ':memory:', adminPassword: 'AdminPassword123!', clock: () => Date.now()});
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

  const admin = client(), seller = client(), plain = client();
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  const books = await req(admin, '/admin/categories', 'POST', {name: '书籍教材', sort: 10}, 201);
  const legacy = await req(admin, '/admin/categories', 'POST', {name: '旧分类', sort: 20}, 201);
  await req(admin, '/admin/categories/' + legacy.id, 'PATCH', {status: 'disabled'});

  for (const [name, c] of [['seller', seller], ['plain', plain]]) {
    await req(c, '/register', 'POST', {username: name, password: 'Password123'}, 201);
    await req(c, '/login', 'POST', {username: name, password: 'Password123'});
  }
  const cert = await req(seller, '/certifications', 'POST', {realName: '测试卖家', studentNo: 'S900'}, 201);
  await req(admin, '/admin/certifications/' + cert.id, 'POST', {action: 'approve', offlineVerified: true});

  const base_product = {title: '高数教材', condition: '九成新', description: '有少量笔记', tradeType: 'sale', price: 25, deliveryLocation: '北校区图书馆正门', images: [png]};

  // 未认证学生不能发布
  await req(plain, '/products', 'POST', {...base_product, categoryId: books.id}, 403);

  // 缺少分类
  await req(seller, '/products', 'POST', {...base_product}, 400);
  assert.equal((await req(seller, '/products', 'POST', {...base_product}, 400)).error, '请选择分类');

  // 只传旧文本字段
  const textOnly = await req(seller, '/products', 'POST', {...base_product, category: '书籍教材'}, 400);
  assert.equal(textOnly.error, '请使用 categoryId 选择分类');

  // 非法或不存在
  for (const categoryId of [99999, 0, -1, 'abc', 1.5]) {
    const bad = await req(seller, '/products', 'POST', {...base_product, categoryId}, 400);
    assert.equal(bad.error, '分类不存在', String(categoryId));
  }

  // 已停用
  const disabled = await req(seller, '/products', 'POST', {...base_product, categoryId: legacy.id}, 400);
  assert.equal(disabled.error, '分类已停用，请重新选择');

  // 校验失败不落库
  assert.equal((await req(seller, '/products/mine')).length, 0);

  // 正常发布：写入分类快照与 category_id
  const created = await req(seller, '/products', 'POST', {...base_product, categoryId: books.id}, 201);
  assert.equal(created.status, 'pending');
  const mine = await req(seller, '/products/mine');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].category, '书籍教材');
  assert.equal(mine[0].category_id, books.id);

  // 分类被停用后，已发布商品仍保留原分类
  await req(admin, '/admin/categories/' + books.id, 'PATCH', {status: 'disabled'});
  const afterDisable = await req(seller, '/products/mine');
  assert.equal(afterDisable[0].category, '书籍教材');
  assert.equal(afterDisable[0].category_id, books.id);
});

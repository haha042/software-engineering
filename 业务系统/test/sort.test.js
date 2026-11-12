import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('C02 市场排序：四种排序与筛选可组合，同价顺序稳定', async t => {
  let time = Date.now();
  const app = createApp({database: ':memory:', adminPassword: 'AdminPassword123!', clock: () => time});
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => app.server.close(r)));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const client = () => ({cookie: '', csrf: ''});
  async function req(c, path, method = 'GET', body, expected = 200) {
    const r = await fetch(base + '/api' + path, {method, headers: {cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
    if (r.headers.get('set-cookie')) c.cookie = r.headers.get('set-cookie').split(';')[0];
    const b = await r.json();
    assert.equal(r.status, expected, JSON.stringify(b));
    if (b.csrf) c.csrf = b.csrf;
    return b;
  }
  const admin = client(), seller = client();
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  await req(seller, '/register', 'POST', {username: 'seller', password: 'Password123'}, 201);
  await req(seller, '/login', 'POST', {username: 'seller', password: 'Password123'});
  const cert = await req(seller, '/certifications', 'POST', {realName: '测试学生', studentNo: 'S001'}, 201);
  await req(admin, '/admin/certifications/' + cert.id, 'POST', {action: 'approve', offlineVerified: true});
  const publish = async (title, category, condition, tradeType, price, expectation = '') => {
    const b = await req(seller, '/products', 'POST', {title, category, condition, tradeType, price, expectation, description: title + '的描述', deliveryLocation: '图书馆正门', images: [png]}, 201);
    await req(admin, '/admin/products/' + b.id, 'POST', {action: 'approve'});
    return b.id;
  };
  // 序号即发布顺序：A..G；F 与 G 同价（50 元），用于验证同值顺序稳定
  const A = await publish('数据结构教材', '书籍教材', '九成新', 'sale', 30);
  const B = await publish('宿舍台灯', '生活用品', '八成新', 'sale', 45);
  const C = await publish('手机壳', '数码配件', '全新', 'gift', 0);
  const D = await publish('篮球', '运动器材', '六成新', 'exchange', 0, '希望换一本小说');
  const E = await publish('算法导论', '书籍教材', '九成新', 'sale', 88);
  const F = await publish('概率论教材', '书籍教材', '九成新', 'sale', 50);
  const G = await publish('线性代数教材', '书籍教材', '九成新', 'sale', 50);
  const list = async query => (await req(seller, '/products' + query)).map(p => p.id);

  // 默认按最新发布；显式 latest 与默认一致
  assert.deepEqual(await list(''), [G, F, E, D, C, B, A]);
  assert.deepEqual(await list('?sort=latest'), [G, F, E, D, C, B, A]);
  // 最早发布
  assert.deepEqual(await list('?sort=oldest'), [A, B, C, D, E, F, G]);
  // 价格升序：交换单没有价格，排在最后；同价按 id 倒序，保证稳定
  assert.deepEqual(await list('?sort=price_asc'), [C, A, B, G, F, E, D]);
  // 价格降序
  assert.deepEqual(await list('?sort=price_desc'), [E, G, F, B, A, C, D]);
  // 排序与筛选可组合：书籍教材里按价格升序
  assert.deepEqual(await list('?sort=price_asc&category=' + encodeURIComponent('书籍教材')), [A, G, F, E]);
  assert.deepEqual(await list('?sort=price_desc&maxPrice=50'), [G, F, B, A, C]);
  // 非法排序值
  await req(seller, '/products?sort=hot', 'GET', undefined, 400);
  await req(seller, '/products?sort=', 'GET', undefined, 200);
});

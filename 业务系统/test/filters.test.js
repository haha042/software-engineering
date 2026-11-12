import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('C01 市场筛选：关键词、分类、方式、成色、价格区间可组合，空结果与非法参数有明确响应', async t => {
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
  const publish = async (title, category, condition, tradeType, price, expectation = '', desc) => {
    const b = await req(seller, '/products', 'POST', {title, category, condition, tradeType, price, expectation, description: desc || title + '的描述', deliveryLocation: '图书馆正门', images: [png]}, 201);
    return b.id;
  };
  const ids = [];
  ids.push(await publish('数据结构教材', '书籍教材', '九成新', 'sale', 30));
  ids.push(await publish('宿舍台灯', '生活用品', '八成新', 'sale', 45));
  ids.push(await publish('手机壳', '数码配件', '全新', 'gift', 0));
  ids.push(await publish('篮球', '运动器材', '六成新', 'exchange', 0, '希望换一本小说', '附带打气筒，室内外都能用'));
  ids.push(await publish('算法导论', '书籍教材', '九成新', 'sale', 88));
  const pendingId = await publish('待审核的旧键盘', '数码配件', '八成新', 'sale', 20);
  for (const id of ids) await req(admin, '/admin/products/' + id, 'POST', {action: 'approve'});
  const list = async query => (await req(seller, '/products' + query)).map(p => p.id);
  // 默认列表：只看在售，按 id 倒序，未审核的不出现
  assert.deepEqual(await list(''), ids.slice().reverse());
  assert.ok(!(await list('')).includes(pendingId));
  // 关键词同时匹配标题与描述，且按字面匹配（% 与 _ 不当通配符）
  assert.deepEqual(await list('?q=数据'), [ids[0]]);
  assert.deepEqual(await list('?q=' + encodeURIComponent('算法导论的描述')), [ids[4]]);
  assert.deepEqual(await list('?q=' + encodeURIComponent('%')), []);
  assert.deepEqual(await list('?q=' + encodeURIComponent('_')), []);
  // 分类、成色、交易方式各自单测
  assert.deepEqual((await list('?category=' + encodeURIComponent('书籍教材'))).sort(), [ids[0], ids[4]].sort());
  assert.deepEqual((await list('?condition=' + encodeURIComponent('九成新'))).sort(), [ids[0], ids[4]].sort());
  assert.deepEqual(await list('?tradeType=gift'), [ids[2]]);
  assert.deepEqual(await list('?tradeType=exchange'), [ids[3]]);
  // 价格区间按元输入、按分比较；交换单没有价格，不进入价格区间
  assert.deepEqual((await list('?minPrice=30&maxPrice=50')).sort(), [ids[0], ids[1]].sort());
  assert.deepEqual((await list('?maxPrice=0')).sort(), [ids[2]].sort());
  assert.deepEqual((await list('?minPrice=1')).sort(), [ids[0], ids[1], ids[4]].sort());
  // 组合筛选
  assert.deepEqual(await list('?category=' + encodeURIComponent('书籍教材') + '&maxPrice=50'), [ids[0]]);
  assert.deepEqual(await list('?q=' + encodeURIComponent('导论') + '&tradeType=sale&minPrice=31'), [ids[4]]);
  // 无结果返回空数组，由前端呈现空状态
  assert.deepEqual(await list('?category=' + encodeURIComponent('书籍教材') + '&tradeType=gift'), []);
  // 非法参数
  await req(seller, '/products?tradeType=rent', 'GET', undefined, 400);
  await req(seller, '/products?minPrice=50&maxPrice=30', 'GET', undefined, 400);
  await req(seller, '/products?minPrice=1.234', 'GET', undefined, 400);
  await req(seller, '/products?maxPrice=-1', 'GET', undefined, 400);
  // 筛选选项来自当前在售数据
  const facets = await req(seller, '/products/facets');
  assert.deepEqual(facets.categories, ['书籍教材', '数码配件', '生活用品', '运动器材']);
  assert.deepEqual(facets.conditions, ['九成新', '全新', '八成新', '六成新']);
  assert.ok(!facets.categories.includes('待审核'), '待审核商品的分类不应出现在筛选项里');
});

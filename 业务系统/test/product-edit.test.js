import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('C04 编辑与驳回重提：驳回可重提、在售改动重新审核、预订中受限、订单快照不变', async t => {
  const app = createApp({database: ':memory:', adminPassword: 'AdminPassword123!', clock: () => Date.now()});
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

  const admin = client(), seller = client(), buyer = client(), stranger = client();
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  for (const [c, name, no] of [[seller, 'editseller', 'E001'], [buyer, 'editbuyer', 'E002'], [stranger, 'editstranger', 'E003']]) {
    await req(c, '/register', 'POST', {username: name, password: 'Password123'}, 201);
    await req(c, '/login', 'POST', {username: name, password: 'Password123'});
    const cert = await req(c, '/certifications', 'POST', {realName: '测试学生', studentNo: no}, 201);
    await req(admin, '/admin/certifications/' + cert.id, 'POST', {action: 'approve', offlineVerified: true});
  }

  const publish = async (title, price = 30) => (await req(seller, '/products', 'POST', {
    title, category: '书籍教材', condition: '九成新', tradeType: 'sale', price,
    description: title + '的详细描述', deliveryLocation: '图书馆正门', images: [png]
  }, 201)).id;

  // 1) 驳回 → 修改 → 重新进入审核
  const rejectedId = await publish('被驳回的旧教材', 25);
  await req(admin, '/admin/products/' + rejectedId, 'POST', {action: 'reject', reason: '图片看不清，请重拍'});
  assert.equal((await req(seller, '/products/' + rejectedId)).status, 'rejected');

  const edited = await req(seller, '/products/' + rejectedId, 'PATCH', {
    title: '被驳回的旧教材（已重拍）', category: '书籍教材', condition: '九成新', tradeType: 'sale', price: 22,
    description: '这次补了封面和版权页照片', deliveryLocation: '图书馆正门', images: [png]
  });
  assert.equal(edited.status, 'pending', '驳回后修改应重新进入审核');
  assert.equal(edited.resubmitted, true);
  assert.equal(edited.review_reason, null, '重提后清空驳回理由');
  assert.equal(edited.title, '被驳回的旧教材（已重拍）');
  assert.equal(edited.price, 2200);
  // 审核期间不出现在市场
  assert.ok(!(await req(buyer, '/products')).some(p => p.id === rejectedId));

  // 2) 审核中不能改
  await req(seller, '/products/' + rejectedId, 'PATCH', {title: '审核中偷改'}, 409);

  // 3) 通过后（在售）改一次 → 重新进入审核
  await req(admin, '/admin/products/' + rejectedId, 'POST', {action: 'approve'});
  assert.equal((await req(seller, '/products/' + rejectedId)).status, 'live');
  const liveEdit = await req(seller, '/products/' + rejectedId, 'PATCH', {title: '在售商品改名', price: 18});
  assert.equal(liveEdit.status, 'pending');
  assert.equal(liveEdit.price, 1800);
  // 只改一处时其余字段保持原值
  assert.equal(liveEdit.category, '书籍教材');
  assert.equal(liveEdit.delivery_location, '图书馆正门');

  // 4) 下单后商品进入预订中，卖家不能改，且订单快照保持下单时的样子
  const orderedId = await publish('会被预订的书', 40);
  await req(admin, '/admin/products/' + orderedId, 'POST', {action: 'approve'});
  const order = await req(buyer, '/orders', 'POST', {requestKey: 'req-c04-0001', productId: orderedId}, 201);
  assert.equal((await req(seller, '/products/' + orderedId)).status, 'reserved');
  await req(seller, '/products/' + orderedId, 'PATCH', {title: '预订中偷改标题', price: 1}, 409);

  const snapshot = JSON.parse(app.db.prepare('SELECT snapshot FROM orders WHERE id=?').get(order.id).snapshot);
  assert.equal(snapshot.title, '会被预订的书');
  assert.equal(snapshot.price, 4000);
  assert.equal((await req(seller, '/products/' + orderedId)).title, '会被预订的书', '商品本身也没被改');

  // 5) 别人不能改，管理员以外的非本人也拿不到
  await req(stranger, '/products/' + orderedId, 'PATCH', {title: '越权修改'}, 404);

  // 6) 已成交的商品不能改
  const act = (who, action, extra = {}) => req(who, '/orders/' + order.id + '/action', 'POST', {action, ...extra});
  await act(seller, 'accept');
  await act(seller, 'deliver', {location: '图书馆正门', note: '当面交付，包装完好', occurredAt: Date.now()});
  await act(buyer, 'confirm');
  await act(seller, 'confirm');
  assert.equal((await req(seller, '/products/' + orderedId)).status, 'sold');
  await req(seller, '/products/' + orderedId, 'PATCH', {title: '成交后偷改'}, 409);

  // 7) 交换单改成出售：价格必须重新给，且必须大于 0
  const exId = await publish('交换用的旧书', 10);
  await req(admin, '/admin/products/' + exId, 'POST', {action: 'approve'});
  await req(seller, '/products/' + exId, 'PATCH', {tradeType: 'exchange', expectation: '想换一本科幻'});
  const ex2 = await publish('另一本交换书', 10);
  await req(admin, '/admin/products/' + ex2, 'POST', {action: 'approve'});
  const back = await req(seller, '/products/' + ex2, 'PATCH', {tradeType: 'sale', price: 0}, 400);
  assert.equal(back.error, '出售价格须大于0');
});

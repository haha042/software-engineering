import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, png, pngAlt} from './helpers.js';

const bytes = dataUrl => Buffer.from(dataUrl.split(',')[1], 'base64');

// B03：订单保留创建时的目标图片、商品改图不影响旧订单、非参与者不能读订单图片、旧订单兼容明示。
test('B03 订单图片固化、参与者授权与历史兼容', async t => {
  const f = await fixture(t);
  const pid = await f.publish();
  const o = await f.order(pid, 'image-order-0001');
  let list = await f.req(f.buyer, '/orders');
  const first = list[0];
  assert.equal(first.snapshotImageSource, 'order');
  assert.equal(first.snapshotImages.length, 1);
  const url = first.snapshotImages[0];

  const asBuyer = await fetch(f.base + url, {headers: {cookie: f.buyer.cookie}});
  assert.equal(asBuyer.status, 200);
  assert.equal(asBuyer.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await asBuyer.arrayBuffer()), bytes(png));
  assert.equal((await fetch(f.base + url, {headers: {cookie: f.seller.cookie}})).status, 200);
  assert.equal((await fetch(f.base + url, {headers: {cookie: f.third.cookie}})).status, 404, '非参与者不可读');
  assert.equal((await fetch(f.base + url)).status, 404, '未登录不可读');

  // 结束订单后商品恢复在售，卖家改标题与图片，旧订单应仍显示原约定与原图版本。
  await f.act(f.buyer, o.id, 'cancel');
  assert.equal((await f.req(f.buyer, '/products/' + pid)).status, 'live');
  await f.req(f.seller, '/products/' + pid, 'PATCH', {title: '改图后的台灯', images: [pngAlt]});
  await f.req(f.admin, '/admin/products/' + pid, 'POST', {action: 'approve'});
  const current = await f.req(f.buyer, '/products/' + pid);
  const changedImage = await fetch(f.base + current.images[0], {headers: {cookie: f.buyer.cookie}});
  assert.equal(changedImage.status, 200);
  assert.deepEqual(Buffer.from(await changedImage.arrayBuffer()), bytes(pngAlt), '商品当前图已更换');

  list = await f.req(f.buyer, '/orders');
  const old = list.find(x => x.id === o.id);
  assert.equal(old.snapshot.title, '测试台灯', '旧订单文字约定不被覆盖');
  assert.equal(old.snapshotImages.length, 1);
  const oldImage = await fetch(f.base + old.snapshotImages[0], {headers: {cookie: f.buyer.cookie}});
  assert.equal(oldImage.status, 200);
  assert.deepEqual(Buffer.from(await oldImage.arrayBuffer()), bytes(png), '旧订单仍读原图版本');

  // 模拟迁移前已有订单：无订单侧图片副本、快照无版本字段。
  const row = f.app.db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
  f.app.db.prepare('INSERT INTO orders(product_id,buyer_id,seller_id,status,snapshot,offer,topup,payer,request_key,deadline,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(row.product_id, row.buyer_id, row.seller_id, 'closed',
      JSON.stringify({title: '历史订单', price: 5000}), null, 0, null,
      'legacy-key-0001', row.deadline, row.created_at);
  const legacy = (await f.req(f.buyer, '/orders')).find(x => x.request_key === 'legacy-key-0001');
  assert.equal(legacy.snapshotImageSource, 'product_legacy', '旧订单明示兼容视图，不冒充历史原图');
  assert.deepEqual(legacy.snapshotImages, []);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, png} from './helpers.js';

// B04：拒单原因必填且可查；交换交付须分别记录双方物品，遗漏拒绝且失败不改状态。
test('B04 拒单理由与交换交付双方物品记录', async t => {
  const f = await fixture(t);
  const pid = await f.publish();
  const o = await f.order(pid, 'reject-test-0001');
  const missing = await f.act(f.seller, o.id, 'reject', {}, 400);
  assert.match(missing.error, /文字/);
  let list = await f.req(f.buyer, '/orders');
  assert.equal(list[0].status, 'pending', '失败不改订单状态');
  assert.equal((await f.req(f.seller, '/products/' + pid)).status, 'reserved', '失败不改商品状态');

  await f.act(f.seller, o.id, 'reject', {reason: '已借给同学'});
  list = await f.req(f.buyer, '/orders');
  assert.equal(list[0].status, 'closed');
  assert.equal(list[0].reject_reason, '已借给同学');
  const ev = list[0].events.find(x => x.action === 'reject');
  assert.equal(ev.detail, '已借给同学', '原因可查');
  assert.equal(ev.actor_id, list[0].seller_id, '操作者可查');

  const exId = await f.publish({title: '交换用台灯', tradeType: 'exchange', price: null, expectation: '想换教材'});
  const exOrder = await f.req(f.buyer, '/orders', 'POST', {
    productId: exId, requestKey: 'exchange-key-01',
    offer: {title: '交换用教材', description: '内容完整', condition: '九成新', images: [png]},
    topup: 0
  }, 201);
  await f.act(f.seller, exOrder.id, 'accept');
  const baseDelivery = {location: '图书馆正门', note: '当面交换', occurredAt: f.now()};
  const partial = await f.act(f.seller, exOrder.id, 'deliver',
    {...baseDelivery, items: {seller: {delivered: true}}}, 400);
  assert.match(partial.error, /双方物品/);
  assert.equal((await f.req(f.buyer, '/orders'))[0].status, 'delivery', '遗漏一件时状态不变');

  await f.act(f.seller, exOrder.id, 'deliver',
    {...baseDelivery, items: {seller: {delivered: true}, buyer: {delivered: true}}});
  const ex = (await f.req(f.buyer, '/orders'))[0];
  assert.equal(ex.status, 'confirmation');
  const delivery = JSON.parse(ex.delivery);
  assert.equal(delivery.items.seller.title, '交换用台灯');
  assert.equal(delivery.items.seller.productId, exId, '目标项带 productId');
  assert.equal(delivery.items.buyer.title, '交换用教材');
  assert.equal(delivery.items.buyer.productId, null, '提供项不创建商品');
  assert.equal(delivery.items.seller.delivered, true);
  assert.equal(delivery.items.buyer.delivered, true);
  await f.act(f.seller, exOrder.id, 'deliver',
    {...baseDelivery, items: {seller: {delivered: true}, buyer: {delivered: true}}}, 409);
});

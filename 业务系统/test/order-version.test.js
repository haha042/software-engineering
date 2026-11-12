import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';

// B02：详情返回版本、下单校验版本、过期版本整体拒绝且不改数据。
// B06（后端部分）：同参数重试返回原订单，改参数复用请求标识被拒绝。
test('B02/B06 商品版本校验与下单重试幂等', async t => {
  const f = await fixture(t);
  const pid = await f.publish();
  const v1 = await f.req(f.buyer, '/products/' + pid);
  assert.equal(v1.version, 1);

  // 编辑重提 → 内容版本递增；审核通过本身不改版本（默认口径）。
  await f.req(f.seller, '/products/' + pid, 'PATCH', {title: '改名后的台灯', price: 60});
  await f.req(f.admin, '/admin/products/' + pid, 'POST', {action: 'approve'});
  const v2 = await f.req(f.buyer, '/products/' + pid);
  assert.equal(v2.version, 2);
  assert.equal(v2.title, '改名后的台灯');

  const stale = await f.req(f.buyer, '/orders', 'POST',
    {productId: pid, requestKey: 'stale-version-01', productVersion: 1}, 409);
  assert.equal(stale.code, 'PRODUCT_VERSION_STALE');
  assert.equal((await f.req(f.buyer, '/products/' + pid)).status, 'live', '商品状态不变');
  assert.deepEqual(await f.req(f.buyer, '/orders'), [], '不插入订单');

  const o = await f.req(f.buyer, '/orders', 'POST',
    {productId: pid, requestKey: 'valid-version-01', productVersion: 2}, 201);
  const list = await f.req(f.buyer, '/orders');
  assert.equal(list.length, 1);
  assert.equal(list[0].snapshot.version, 2);
  assert.equal(list[0].snapshot.title, '改名后的台灯');

  const again = await f.req(f.buyer, '/orders', 'POST',
    {productId: pid, requestKey: 'valid-version-01', productVersion: 2}, 201);
  assert.equal(again.id, o.id, '同参数重试返回原订单');
  const changed = await f.req(f.buyer, '/orders', 'POST',
    {productId: pid, requestKey: 'valid-version-01', productVersion: 1}, 409);
  assert.match(changed.error, /请求标识/);
  assert.equal((await f.req(f.buyer, '/orders')).length, 1, '仍只有一笔订单');
});

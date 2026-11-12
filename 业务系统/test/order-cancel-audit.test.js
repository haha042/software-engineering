import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/app.js';
import {fixture, requester} from './helpers.js';

// B05：取消申请编号、申请/回应时间、操作者完整留痕。
test('B05 协商取消审计与撤回后继续履约', async t => {
  const f = await fixture(t);
  const pid = await f.publish();
  const o = await f.order(pid, 'cancel-audit-001');
  await f.act(f.seller, o.id, 'accept');
  await f.act(f.buyer, o.id, 'request_cancel', {reason: '时间不合适'});
  let order = (await f.req(f.buyer, '/orders'))[0];
  assert.equal(order.cancelRequests.length, 1);
  const cr = order.cancelRequests[0];
  assert.ok(cr.id > 0, '有申请编号');
  assert.equal(cr.requested_by, order.buyer_id, '申请操作者可查');
  assert.equal(cr.reason, '时间不合适');
  assert.equal(cr.status, 'pending');
  assert.ok(cr.requested_at > 0, '申请时间可查');
  assert.equal(cr.responded_by, null);

  await f.act(f.seller, o.id, 'agree_cancel');
  order = (await f.req(f.buyer, '/orders'))[0];
  assert.equal(order.status, 'cancelled');
  assert.equal(order.cancelRequests[0].status, 'agreed');
  assert.equal(order.cancelRequests[0].responded_by, order.seller_id, '回应操作者可查');
  assert.ok(order.cancelRequests[0].responded_at >= order.cancelRequests[0].requested_at, '回应时间可查');
  assert.equal((await f.req(f.buyer, '/products/' + pid)).status, 'live');

  const pid2 = await f.publish({title: '第二盏台灯'});
  const o2 = await f.order(pid2, 'cancel-audit-002');
  await f.act(f.seller, o2.id, 'accept');
  await f.act(f.buyer, o2.id, 'request_cancel', {reason: '再想想'});
  await f.act(f.buyer, o2.id, 'withdraw_cancel');
  const second = (await f.req(f.buyer, '/orders'))[0];
  assert.equal(second.status, 'delivery', '撤回不结束订单');
  assert.equal(second.cancelRequests.length, 1);
  assert.equal(second.cancelRequests[0].status, 'withdrawn');
  assert.equal(second.cancelRequests[0].responded_by, second.buyer_id);
  await f.act(f.seller, o2.id, 'deliver', {location: '校门', note: '交付', occurredAt: f.now()});
  assert.equal((await f.req(f.buyer, '/orders'))[0].status, 'confirmation', '撤回后可继续履约');
});

// B05：两处独立数据库连接指向同一 SQLite 文件，验证接单/取消竞争与超时任务不重复生效。
test('B05 真实文件数据库多连接：状态竞争后订单与商品一致', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'campus-order-'));
  const dbPath = join(dir, 'campus.sqlite');
  const f = await fixture(t, {database: dbPath});
  const second = createApp({database: dbPath, adminPassword: 'AdminPassword123!', clock: () => f.now()});
  await new Promise(r => second.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => second.server.close(r)));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const reqB = requester('http://127.0.0.1:' + second.server.address().port);

  const pid = await f.publish();
  const o = await f.order(pid, 'concurrency-0001');
  const results = await Promise.allSettled([
    f.act(f.seller, o.id, 'accept', {}, null),
    reqB(f.buyer, '/orders/' + o.id + '/action', 'POST', {action: 'cancel'}, null)
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value?.ok === true).length, 1, '仅一个转换成功');

  const order = (await f.req(f.buyer, '/orders'))[0];
  assert.ok(['delivery', 'cancelled'].includes(order.status));
  assert.equal((await f.req(f.buyer, '/products/' + pid)).status,
    order.status === 'delivery' ? 'reserved' : 'live', '订单与商品状态一致');
  assert.equal(order.events.filter(x => ['accept', 'cancel'].includes(x.action)).length, 1, '不留半笔更新');

  f.advance(172800001);
  f.app.expire();
  await f.relogin();
  const after = (await f.req(f.buyer, '/orders'))[0];
  assert.equal(after.status, order.status, '超时任务不重复关闭已结束订单');
  assert.equal(after.events.filter(x => x.action === 'timeout').length, 0);

  const pid2 = await f.publish({title: '超时测试台灯'});
  const o2 = await f.order(pid2, 'concurrency-0002');
  f.advance(172800001);
  f.app.expire();
  await f.relogin();
  const timed = (await f.req(f.buyer, '/orders')).find(x => x.id === o2.id);
  assert.equal(timed.status, 'closed');
  assert.equal(timed.events.filter(x => x.action === 'timeout').length, 1);
  assert.equal((await f.req(f.buyer, '/products/' + pid2)).status, 'live');
});

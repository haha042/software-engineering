import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers.js';

const reviewPath = id => '/orders/' + id + '/reviews';

// B07：完成后 14 天内双方各评一次，1～5 星与文字校验，不可改删，仅被评价人回复一次。
test('B07 订单评价与一次回复的期限、唯一性与权限', async t => {
  const f = await fixture(t);
  const pid = await f.publish();
  const o = await f.order(pid, 'review-test-0001');
  await f.req(f.buyer, reviewPath(o.id), 'POST', {rating: 5, content: '很好'}, 409, '完成前不能评价');
  await f.complete(o.id);
  let list = await f.req(f.buyer, '/orders');
  assert.equal(list[0].status, 'completed');
  assert.ok(list[0].completed_at > 0, '记录完成时间作为评价期限起点');

  for (const rating of [0, 6, '5', 1.5]) {
    await f.req(f.buyer, reviewPath(o.id), 'POST', {rating, content: '评分边界'}, 400);
  }
  await f.req(f.buyer, reviewPath(o.id), 'POST', {rating: 1, content: '   '}, 400);

  const r1 = await f.req(f.buyer, reviewPath(o.id), 'POST', {rating: 1, content: '交付准时'}, 201);
  const r2 = await f.req(f.seller, reviewPath(o.id), 'POST', {rating: 5, content: '沟通顺畅'}, 201);
  await f.req(f.buyer, reviewPath(o.id), 'POST', {rating: 3, content: '改评价'}, 409, '每人每单一次');
  list = await f.req(f.buyer, '/orders');
  assert.equal(list[0].reviews.length, 2);
  const mine = list[0].reviews.find(x => x.id === r1.id);
  assert.equal(mine.reviewee_id, list[0].seller_id, '评价对象为另一方');
  assert.equal(mine.rating, 1);
  assert.equal(mine.reply, null);

  await f.req(f.third, '/orders/' + o.id + '/reviews/' + r1.id + '/reply', 'POST', {content: '插话'}, 403);
  await f.req(f.buyer, '/orders/' + o.id + '/reviews/' + r1.id + '/reply', 'POST', {content: '自回复'}, 403);
  await f.req(f.seller, '/orders/' + o.id + '/reviews/' + r1.id + '/reply', 'POST', {content: '谢谢反馈'});
  await f.req(f.seller, '/orders/' + o.id + '/reviews/' + r1.id + '/reply', 'POST', {content: '再回复'}, 409);
  const replied = (await f.req(f.buyer, '/orders'))[0].reviews.find(x => x.id === r1.id);
  assert.equal(replied.reply, '谢谢反馈');
  assert.ok(replied.reply_at > 0);

  // 没有修改/删除接口，原评价不可自行改删。
  assert.equal((await f.req(f.buyer, '/orders/' + o.id + '/reviews/' + r1.id, 'PUT', {rating: 5}, 404)).error, '接口不存在');
  await f.req(f.buyer, '/orders/' + o.id + '/reviews/' + r1.id, 'DELETE', undefined, 404);
  assert.equal((await f.req(f.buyer, '/orders'))[0].reviews.find(x => x.id === r1.id).rating, 1);
  assert.ok(r2.id > 0);

  const pid2 = await f.publish({title: '期限测试台灯'});
  const o2 = await f.order(pid2, 'review-test-0002');
  await f.complete(o2.id);
  f.advance(14 * 24 * 60 * 60 * 1000 + 1);
  await f.relogin();
  await f.req(f.buyer, reviewPath(o2.id), 'POST', {rating: 5, content: '超期评价'}, 409, '超过14天不可评价');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {placeOrder} from '../public/orders.js';

// B02/B06 前端逻辑：不需要 DOM，用替身验证版本随单提交与请求标识复用规则。
function storage() {
  const map = new Map();
  return {
    getItem: k => map.has(k) ? map.get(k) : null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k)
  };
}

function ctx({failOnPost = null, version = 1} = {}) {
  const calls = [];
  const store = storage();
  globalThis.sessionStorage = store;
  const api = async (path, method, data) => {
    calls.push({path, method, data});
    if (method === 'POST' && path === '/orders' && failOnPost) throw failOnPost;
    if (path === '/products/1') return {version, images: []};
    return {ok: true};
  };
  const args = {$: () => null, api, files: async () => [], toast: () => {}, navigate: () => {}, user: {id: 2}, selected: 1};
  const orderCall = () => calls.find(c => c.path === '/orders').data;
  return {args, store, orderCall};
}

test('B02 前端随下单提交详情返回的商品版本', async () => {
  const c = ctx({version: 7});
  await placeOrder(c.args);
  assert.equal(c.orderCall().productVersion, 7);
});

test('B06 响应不确定时保留请求标识，明确业务拒绝时清除', async () => {
  const first = ctx({failOnPost: new Error('网络连接失败，请检查本地服务是否已启动')});
  await assert.rejects(() => placeOrder(first.args));
  const firstKey = first.orderCall().requestKey;
  const saved = first.store.getItem('campus.orderIntent.1');
  assert.ok(saved, '网络失败后保留未确认的下单意图');
  assert.equal(JSON.parse(saved).requestKey, firstKey);

  const retry = ctx();
  retry.store.setItem('campus.orderIntent.1', saved);
  await placeOrder(retry.args);
  assert.equal(retry.orderCall().requestKey, firstKey, '同参数重试沿用原标识');
  assert.equal(retry.store.getItem('campus.orderIntent.1'), null, '成功后清除意图');

  const refused = ctx({failOnPost: new Error('商品版本已更新，请刷新后重新确认')});
  await assert.rejects(() => placeOrder(refused.args));
  assert.equal(refused.store.getItem('campus.orderIntent.1'), null, '明确业务拒绝不保留旧标识');

  const fresh = ctx();
  await placeOrder(fresh.args);
  assert.notEqual(fresh.orderCall().requestKey, firstKey, '重新发起时生成新标识');
});

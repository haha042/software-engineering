import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('C05 下架与重新上架：只有本人可操作，预订中被拒，公开列表随状态变化', async t => {
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

  const admin = client(), seller = client(), buyer = client(), other = client();
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  for (const [c, name, no] of [[seller, 'stateseller', 'S101'], [buyer, 'statebuyer', 'S102']]) {
    await req(c, '/register', 'POST', {username: name, password: 'Password123'}, 201);
    await req(c, '/login', 'POST', {username: name, password: 'Password123'});
    const cert = await req(c, '/certifications', 'POST', {realName: '测试学生', studentNo: no}, 201);
    await req(admin, '/admin/certifications/' + cert.id, 'POST', {action: 'approve', offlineVerified: true});
  }
  await req(other, '/register', 'POST', {username: 'statestranger', password: 'Password123'}, 201);
  await req(other, '/login', 'POST', {username: 'statestranger', password: 'Password123'});
  const otherCert = await req(other, '/certifications', 'POST', {realName: '干扰者', studentNo: 'S103'}, 201);
  await req(admin, '/admin/certifications/' + otherCert.id, 'POST', {action: 'approve', offlineVerified: true});

  const publish = async title => (await req(seller, '/products', 'POST', {
    title, category: '书籍教材', condition: '九成新', tradeType: 'sale', price: 20,
    description: title + '的描述', deliveryLocation: '图书馆正门', images: [png]
  }, 201)).id;
  const approve = async id => req(admin, '/admin/products/' + id, 'POST', {action: 'approve'});
  const visible = async id => (await req(buyer, '/products')).some(p => p.id === id);

  // 1) 在售 → 下架 → 从公开列表消失 → 重新上架 → 回到列表
  const id = await publish('可下架的书');
  await approve(id);
  assert.equal(await visible(id), true);
  assert.deepEqual(await req(seller, '/products/' + id + '/status', 'POST', {action: 'off'}), {id, status: 'off'});
  assert.equal(await visible(id), false, '下架后公开列表不再出现');
  assert.equal((await req(seller, '/products/' + id)).status, 'off');
  assert.deepEqual(await req(seller, '/products/' + id + '/status', 'POST', {action: 'relist'}), {id, status: 'live'});
  assert.equal(await visible(id), true, '重新上架后立刻回到列表');

  // 2) 别人不能下架或重提
  await req(other, '/products/' + id + '/status', 'POST', {action: 'off'}, 404);
  await req(seller, '/products/' + id + '/status', 'POST', {action: 'off'});
  await req(other, '/products/' + id + '/status', 'POST', {action: 'relist'}, 404);

  // 3) 状态不符时拒绝
  await req(seller, '/products/' + id + '/status', 'POST', {action: 'off'}, 409);      // 已下架不能再下架
  await req(seller, '/products/' + id + '/status', 'POST', {action: 'relist'});        // 回到在售
  await req(seller, '/products/' + id + '/status', 'POST', {action: 'relist'}, 409);   // 在售不能重提
  await req(seller, '/products/' + id + '/status', 'POST', {action: 'off'});           // 再次下架，后续配额用例要用
  await req(seller, '/products/' + id + '/status', 'POST', {action: 'publish'}, 400);
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  const pendingId = await publish('待审核的书');
  await req(seller, '/products/' + pendingId + '/status', 'POST', {action: 'off'}, 409);
  await req(seller, '/products/' + pendingId + '/status', 'POST', {action: 'relist'}, 409);

  // 4) 预订中的商品不能下架
  await approve(pendingId);
  await req(buyer, '/orders', 'POST', {requestKey: 'req-c05-0001', productId: pendingId}, 201);
  assert.equal((await req(seller, '/products/' + pendingId)).status, 'reserved');
  await req(seller, '/products/' + pendingId + '/status', 'POST', {action: 'off'}, 409);
  assert.equal(await visible(pendingId), false, '预订中的商品本来就不在公开列表');

  // 5) 未认证账号不能把已下架商品重新上架
  const lostId = await publish('认证失效后不能重提的书');
  await approve(lostId);
  await req(seller, '/products/' + lostId + '/status', 'POST', {action: 'off'});
  app.db.prepare('UPDATE users SET certified=0 WHERE id=(SELECT owner_id FROM products WHERE id=?)').run(lostId);
  const denied = await req(seller, '/products/' + lostId + '/status', 'POST', {action: 'relist'}, 403);
  assert.match(denied.error, /认证/);
  app.db.prepare('UPDATE users SET certified=1 WHERE id=(SELECT owner_id FROM products WHERE id=?)').run(lostId);
  await req(seller, '/products/' + lostId + '/status', 'POST', {action: 'relist'});

  // 6) 配额满时不能重提：先把商品下架腾出名额，再用别的物品把 20 件配额占满，此时重提必须被拒
  await req(seller, '/products/' + lostId + '/status', 'POST', {action: 'off'});
  for (let n = (await req(seller, '/products/mine')).filter(p => ['pending', 'live'].includes(p.status)).length; n < 20; n++) {
    await req(seller, '/products', 'POST', {
      title: '占配额 ' + n, category: '其他', condition: '全新', tradeType: 'gift',
      description: '占位', deliveryLocation: '楼下', images: [png]
    }, 201);
  }
  const full = await req(seller, '/products/' + lostId + '/status', 'POST', {action: 'relist'}, 409);
  assert.match(full.error, /20/);
});

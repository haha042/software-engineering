import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('C03 草稿：可保存、可恢复、不占配额、不出现在公开列表，提交后转待审核', async t => {
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

  const admin = client(), seller = client(), other = client();
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  await req(seller, '/register', 'POST', {username: 'draftseller', password: 'Password123'}, 201);
  await req(seller, '/login', 'POST', {username: 'draftseller', password: 'Password123'});
  const cert = await req(seller, '/certifications', 'POST', {realName: '测试学生', studentNo: 'D001'}, 201);
  await req(admin, '/admin/certifications/' + cert.id, 'POST', {action: 'approve', offlineVerified: true});
  await req(other, '/register', 'POST', {username: 'draftother', password: 'Password123'}, 201);
  await req(other, '/login', 'POST', {username: 'draftother', password: 'Password123'});

  // 未登录不能读写草稿
  await req(client(), '/products/draft', 'GET', undefined, 401);
  await req(client(), '/products/draft', 'PUT', {title: 'x'}, 401);

  // 一开始没有草稿
  assert.equal((await req(seller, '/products/draft')).draft, null);

  // 存一份不完整的草稿（只有标题和一半字段）也能存下
  const saved = await req(seller, '/products/draft', 'PUT', {
    title: '宿舍旧台灯', category: '生活用品', condition: '八成新', description: '', tradeType: 'sale', price: '12.5'
  });
  assert.ok(saved.id > 0);

  const draft = (await req(seller, '/products/draft')).draft;
  assert.equal(draft.id, saved.id);
  assert.equal(draft.title, '宿舍旧台灯');
  assert.equal(draft.price, 1250, '价格按分存储');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.images.length, 0);

  // 草稿不出现在公开列表，别人也看不到
  assert.deepEqual(await req(seller, '/products'), []);
  assert.deepEqual(await req(other, '/products'), []);
  await req(other, '/products/' + saved.id, 'GET', undefined, 404);
  // 但自己的「我的发布」里能看见
  const mine = await req(seller, '/products/mine');
  assert.deepEqual(mine.map(p => p.status), ['draft']);

  // 再存一次是覆盖，不会多出一条
  const again = await req(seller, '/products/draft', 'PUT', {
    title: '宿舍旧台灯（降价）', category: '生活用品', condition: '八成新', description: '灯罩有一点点划痕', tradeType: 'sale', price: '9.9', deliveryLocation: '3 号宿舍楼下', images: [png]
  });
  assert.equal(again.id, saved.id);
  const draft2 = (await req(seller, '/products/draft')).draft;
  assert.equal(draft2.title, '宿舍旧台灯（降价）');
  assert.equal(draft2.price, 990);
  assert.equal(draft2.images.length, 1);
  assert.equal((await req(seller, '/products/mine')).length, 1, '覆盖不产生新行');

  // 用草稿提交：变成待审核，草稿消失，图片保留
  const submitted = await req(seller, '/products', 'POST', {
    title: '宿舍旧台灯（降价）', category: '生活用品', condition: '八成新', description: '灯罩有一点点划痕', tradeType: 'sale', price: 9.9, expectation: '', deliveryLocation: '3 号宿舍楼下', draftId: saved.id
  }, 201);
  assert.equal(submitted.id, saved.id, '草稿就地转为待审核，不新建商品');
  assert.equal(submitted.status, 'pending');
  assert.equal((await req(seller, '/products/draft')).draft, null);
  const afterSubmit = (await req(seller, '/products/mine'))[0];
  assert.equal(afterSubmit.status, 'pending');
  assert.equal(afterSubmit.images.length, 1, '没重新选图时沿用草稿图片');
  // 待审核商品不该出现在公开列表
  assert.deepEqual(await req(other, '/products'), []);

  // 草稿已提交后再拿同一个 draftId 提交 → 400
  await req(seller, '/products', 'POST', {
    title: '重复提交', category: '生活用品', condition: '八成新', description: 'x', tradeType: 'gift', deliveryLocation: '楼下', draftId: saved.id
  }, 400);

  // 草稿不占发布配额：配额 20 件全部用于正式发布，草稿仍可保存
  const used = (await req(seller, '/products/mine')).filter(p => ['pending', 'live'].includes(p.status)).length;
  for (let n = used; n < 20; n++) {
    await req(seller, '/products', 'POST', {
      title: '配额测试 ' + n, category: '其他', condition: '全新', tradeType: 'gift', description: '配额占位', deliveryLocation: '楼下', images: [png]
    }, 201);
  }
  await req(seller, '/products', 'POST', {
    title: '超额发布', category: '其他', condition: '全新', tradeType: 'gift', description: '超出配额', deliveryLocation: '楼下', images: [png]
  }, 409);
  const spare = await req(seller, '/products/draft', 'PUT', {title: '配额满了也能存草稿', tradeType: 'gift'});
  assert.ok(spare.id > 0);
  assert.equal((await req(seller, '/products/draft')).draft.title, '配额满了也能存草稿');

  // 删除草稿
  assert.equal((await req(seller, '/products/draft', 'DELETE')).removed, true);
  assert.equal((await req(seller, '/products/draft')).draft, null);
  assert.equal((await req(seller, '/products/draft', 'DELETE')).removed, false, '反复删除不报错');
});

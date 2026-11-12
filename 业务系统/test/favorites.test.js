import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

test('C06 收藏：认证后才可用，倒序展示，重复收藏幂等，上限 100，失效商品仍展示', async t => {
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

  const admin = client(), seller = client(), buyer = client(), nocert = client();
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  for (const [c, name, no] of [[seller, 'favseller', 'F001'], [buyer, 'favbuyer', 'F002']]) {
    await req(c, '/register', 'POST', {username: name, password: 'Password123'}, 201);
    await req(c, '/login', 'POST', {username: name, password: 'Password123'});
    const cert = await req(c, '/certifications', 'POST', {realName: '测试学生', studentNo: no}, 201);
    await req(admin, '/admin/certifications/' + cert.id, 'POST', {action: 'approve', offlineVerified: true});
  }
  await req(nocert, '/register', 'POST', {username: 'favnocert', password: 'Password123'}, 201);
  await req(nocert, '/login', 'POST', {username: 'favnocert', password: 'Password123'});

  const publish = async (title, price = 10) => {
    const id = (await req(seller, '/products', 'POST', {
      title, category: '书籍教材', condition: '九成新', tradeType: 'sale', price,
      description: title + '的描述', deliveryLocation: '图书馆正门', images: [png]
    }, 201)).id;
    await req(admin, '/admin/products/' + id, 'POST', {action: 'approve'});
    return id;
  };

  const a = await publish('收藏第一本');
  const b = await publish('收藏第二本');

  // 1) 未认证不能收藏
  const denied = await req(nocert, '/products/' + a + '/favorite', 'POST', {}, 403);
  assert.match(denied.error, /认证/);

  // 2) 收藏成功、重复收藏幂等、列表倒序
  assert.equal((await req(buyer, '/products/' + a + '/favorite', 'POST', {}, 201)).favorited, true);
  const dup = await req(buyer, '/products/' + a + '/favorite', 'POST', {}, 200);
  assert.equal(dup.duplicated, true, '重复收藏不报错，返回 duplicated');
  await req(buyer, '/products/' + b + '/favorite', 'POST', {}, 201);
  let list = await req(buyer, '/favorites');
  assert.deepEqual(list.map(p => p.title), ['收藏第二本', '收藏第一本'], '按收藏时间倒序');
  assert.equal(list[0].available, true);

  // 3) 取消收藏幂等，且不影响别人
  await req(buyer, '/products/' + a + '/favorite', 'DELETE');
  await req(buyer, '/products/' + a + '/favorite', 'DELETE');
  list = await req(buyer, '/favorites');
  assert.deepEqual(list.map(p => p.title), ['收藏第二本']);
  assert.equal((await req(seller, '/favorites')).length, 0, '收藏是各人自己的');

  // 4) 商品失效后仍在收藏列表里，但标记 available=false
  const c = await publish('会被下架的书');
  await req(buyer, '/products/' + c + '/favorite', 'POST', {}, 201);
  await req(seller, '/products/' + c + '/status', 'POST', {action: 'off'});
  list = await req(buyer, '/favorites');
  const stale = list.find(p => p.id === c);
  assert.equal(stale.available, false, '失效商品仍展示但标记不可用');
  assert.equal(stale.status, 'off');

  // 5) 收藏不存在的商品 404
  await req(buyer, '/products/999999/favorite', 'POST', {}, 404);

  // 6) 100 件上限：直接写库把某人的收藏塞满 100 件，再走接口收藏第 101 件
  await req(nocert, '/logout', 'POST', {}, 200);
  const bulk = client();
  await req(bulk, '/register', 'POST', {username: 'favbulk', password: 'Password123'}, 201);
  await req(bulk, '/login', 'POST', {username: 'favbulk', password: 'Password123'});
  const bulkCert = await req(bulk, '/certifications', 'POST', {realName: '批量', studentNo: 'F009'}, 201);
  await req(admin, '/admin/certifications/' + bulkCert.id, 'POST', {action: 'approve', offlineVerified: true});

  const bulkId = app.db.prepare("SELECT id FROM users WHERE username='favbulk'").get().id;
  const sellerId = app.db.prepare("SELECT id FROM users WHERE username='favseller'").get().id;
  const insertProduct = app.db.prepare("INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,expectation,status,created_at,delivery_location) VALUES(?,?,?,'全新','占位','gift',0,'','live',?,'楼下')");
  const insertFav = app.db.prepare("INSERT INTO favorites(user_id,product_id,created_at) VALUES(?,?,?)");
  for (let n = 0; n < 100; n++) {
    const pid = insertProduct.run(sellerId, '批量物品 ' + n, '其他', Date.now()).lastInsertRowid;
    insertFav.run(bulkId, pid, Date.now() + n);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM favorites WHERE user_id=?').get(bulkId).n, 100);
  const extra = insertProduct.run(sellerId, '第 101 件', '其他', Date.now()).lastInsertRowid;
  const over = await req(bulk, '/products/' + extra + '/favorite', 'POST', {}, 409);
  assert.match(over.error, /100/);
  assert.equal((await req(bulk, '/favorites')).length, 100, '满额后收藏列表仍是 100 件');
});

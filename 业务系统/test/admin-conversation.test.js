import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';

test('管理员会话取证：只读、必填理由、分页与留痕', async t => {
  const app = createApp({database: ':memory:', adminPassword: 'AdminPassword123!'});
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => app.server.close(r)));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const client = () => ({cookie: '', csrf: ''});
  async function req(c, path, method = 'GET', body, status = 200) {
    const r = await fetch(base + '/api' + path, {method, headers: {cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
    if (r.headers.get('set-cookie')) c.cookie = r.headers.get('set-cookie').split(';')[0];
    const data = await r.json();
    assert.equal(r.status, status, JSON.stringify(data));
    if (data.csrf) c.csrf = data.csrf;
    return data;
  }
  const admin = client(), seller = client(), buyer = client();
  for (const [name, c] of [['seller', seller], ['buyer', buyer]]) {
    const u = await req(c, '/register', 'POST', {username: name, password: 'Password123'}, 201);
    app.db.prepare('UPDATE users SET certified=1 WHERE id=?').run(u.id);
    c.id = u.id;
    await req(c, '/login', 'POST', {username: name, password: 'Password123'});
  }
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  const productId = Number(app.db.prepare("INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,status,created_at) VALUES(?,'台灯','日用','九成新','测试','sale',1000,'live',?)").run(seller.id, Date.now()).lastInsertRowid);
  const chatId = (await req(buyer, '/conversations', 'POST', {productId})).id;
  await req(buyer, '/conversations/' + chatId + '/messages', 'POST', {content: '灯还能便宜点吗', requestKey: 'msg-0001'}, 201);
  await req(seller, '/conversations/' + chatId + '/messages', 'POST', {content: '最低八十五，可以自提', requestKey: 'msg-0002'}, 201);

  // 普通账号不能取证，管理员也必须写理由。
  await req(buyer, '/admin/conversations/' + chatId, 'GET', undefined, 403);
  await req(admin, '/admin/conversations/' + chatId, 'GET', undefined, 400);
  await req(admin, '/admin/conversations/' + chatId + '?reason=' + encodeURIComponent('短'), 'GET', undefined, 400);
  await req(admin, '/admin/conversations/' + chatId + '?reason=' + encodeURIComponent('字'.repeat(201)), 'GET', undefined, 400);
  await req(admin, '/admin/conversations/999999?reason=' + encodeURIComponent('处置纠纷取证'), 'GET', undefined, 404);

  // 正常取证：返回双方用户名与按时间正序的消息，不含手机号学号。
  const data = await req(admin, '/admin/conversations/' + chatId + '?reason=' + encodeURIComponent('受理纠纷，核对双方沟通记录'));
  assert.equal(data.id, chatId);
  assert.equal(data.buyer.username, 'buyer');
  assert.equal(data.seller.username, 'seller');
  assert.equal(data.product_title, '台灯');
  assert.equal(data.messages.length, 2);
  assert.equal(data.messages[0].content, '灯还能便宜点吗');
  assert.equal(data.hasMore, false);
  assert.equal(data.buyer.student_no, undefined);

  // 每次取证都留痕，理由写进审计详情。
  const logs = await req(admin, '/admin/audit?action=read_conversation');
  const record = logs.find(l => l.action === 'read_conversation' && String(l.target) === String(chatId));
  assert.ok(record, '应写入 read_conversation 审计');
  assert.ok(record.detail.includes('核对双方沟通记录'));
});

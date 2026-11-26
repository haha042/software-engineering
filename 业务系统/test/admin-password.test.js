import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';

test('管理员核验后重置密码：权限、校验、会话失效与留痕', async t => {
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
  const admin = client(), dave = client();
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  const daveId = (await req(dave, '/register', 'POST', {username: 'dave', password: 'Password123'}, 201)).id;
  await req(dave, '/login', 'POST', {username: 'dave', password: 'Password123'});

  // 普通账号不能重置别人的密码。
  await req(dave, '/admin/users/' + daveId + '/password', 'POST', {reason: '普通用户尝试重置', password: 'Hacked12345'}, 403);

  // 理由、密码强度、账号存在性都要校验。
  await req(admin, '/admin/users/' + daveId + '/password', 'POST', {reason: '短', password: 'NewPassword123'}, 400);
  await req(admin, '/admin/users/' + daveId + '/password', 'POST', {reason: '线下核验身份后重置', password: 'abcdefgh'}, 400);
  await req(admin, '/admin/users/' + daveId + '/password', 'POST', {reason: '线下核验身份后重置', password: 'abc123'}, 400);
  await req(admin, '/admin/users/999999/password', 'POST', {reason: '线下核验身份后重置', password: 'NewPassword123'}, 404);

  // 重置成功：旧会话立即失效，旧密码登不上，新密码可用。
  const done = await req(admin, '/admin/users/' + daveId + '/password', 'POST', {reason: '本人带学号到值班室核验后重置', password: 'NewPassword123'});
  assert.equal(done.id, daveId);
  assert.ok(done.sessionsRevoked >= 1, '应撤销已有会话');
  assert.equal((await req(dave, '/me')).user, null, '旧会话应失效');
  await req(client(), '/login', 'POST', {username: 'dave', password: 'Password123'}, 401);
  const fresh = client();
  await req(fresh, '/login', 'POST', {username: 'dave', password: 'NewPassword123'});

  // 留痕与通知。
  const logs = await req(admin, '/admin/audit?action=reset_password');
  assert.ok(logs.some(l => l.action === 'reset_password' && l.detail.includes('核验')));
  assert.ok((await req(fresh, '/notifications')).some(n => n.message.includes('重置了你的登录密码')));
});

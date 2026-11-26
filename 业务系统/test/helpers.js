// 订单模块测试脚手架：合成数据、无真实身份信息；与本目录既有测试口径一致。
import {createApp} from '../src/app.js';

export const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
// 仅改动数据区字节、保留 PNG 头与 IHDR，用于区分「原图版本」与「改图后的新图」。
export const pngAlt = (() => {
  const b = Buffer.from(png.split(',')[1], 'base64');
  const alt = Buffer.from(b);
  alt[alt.length - 5] ^= 0xff;
  return 'data:image/png;base64,' + alt.toString('base64');
})();

export const client = () => ({cookie: '', csrf: ''});

export function requester(base) {
  return async function req(c, path, method = 'GET', body, expected = 200) {
    const r = await fetch(base + '/api' + path, {
      method,
      headers: {cookie: c.cookie, 'x-csrf-token': c.csrf, 'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (r.headers.get('set-cookie')) c.cookie = r.headers.get('set-cookie').split(';')[0];
    const b = await r.json().catch(() => ({}));
    if (expected !== null && r.status !== expected) {
      throw new Error(`${method} ${path} 期望 ${expected} 实得 ${r.status}: ${JSON.stringify(b)}`);
    }
    if (b.csrf) c.csrf = b.csrf;
    return b;
  };
}

export async function fixture(t, {database = ':memory:', clock} = {}) {
  let time = Date.now();
  const now = clock || (() => time);
  const app = createApp({database, adminPassword: 'AdminPassword123!', clock: now});
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => app.server.close(r)));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const req = requester(base);
  const admin = client(), seller = client(), buyer = client(), third = client();
  await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
  for (const [name, c] of [['seller', seller], ['buyer', buyer], ['third', third]]) {
    await req(c, '/register', 'POST', {username: name, password: 'Password123'}, 201);
    await req(c, '/login', 'POST', {username: name, password: 'Password123'});
  }
  for (const [c, no] of [[seller, 'S001'], [buyer, 'S002']]) {
    const cert = await req(c, '/certifications', 'POST', {realName: '测试学生', studentNo: no}, 201);
    await req(admin, '/admin/certifications/' + cert.id, 'POST', {action: 'approve', offlineVerified: true});
  }
  const publish = async (overrides = {}) => {
    const p = await req(seller, '/products', 'POST', {
      title: '测试台灯', category: '生活用品', condition: '九成新', description: '功能正常',
      tradeType: 'sale', price: 50, deliveryLocation: '北校区图书馆正门', images: [png], ...overrides
    }, 201);
    await req(admin, '/admin/products/' + p.id, 'POST', {action: 'approve'});
    return p.id;
  };
  const order = async (productId, key = 'request-key-0001', extra = {}) =>
    req(buyer, '/orders', 'POST', {productId, requestKey: key, ...extra}, 201);
  const act = (c, id, action, data = {}, expected = 200) =>
    req(c, '/orders/' + id + '/action', 'POST', {action, ...data}, expected);
  // 时钟推进超过会话有效期后重新登录，避免把 401 误判成业务结果。
  const relogin = async () => {
    await req(admin, '/login', 'POST', {username: 'admin', password: 'AdminPassword123!'});
    for (const [name, c] of [['seller', seller], ['buyer', buyer], ['third', third]]) {
      await req(c, '/login', 'POST', {username: name, password: 'Password123'});
    }
  };
  // 走完 接单 → 交付 → 双方确认，返回订单 id；exchange 时自动带双方物品确认。
  const complete = async (id, {exchange = false} = {}) => {
    await act(seller, id, 'accept');
    const delivery = {location: '图书馆正门', note: '当面交付', occurredAt: time};
    if (exchange) delivery.items = {seller: {delivered: true}, buyer: {delivered: true}};
    await act(seller, id, 'deliver', delivery);
    await act(buyer, id, 'confirm');
    await act(seller, id, 'confirm');
    return id;
  };
  return {
    app, req, base, admin, seller, buyer, third, publish, order, act, complete, relogin,
    now: () => time,
    setTime: v => { time = v; },
    advance: ms => { time += ms; }
  };
}

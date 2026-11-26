const eventNames = {
  create: '创建订单', accept: '卖家接单', reject: '卖家拒绝', cancel: '买家取消',
  request_cancel: '申请取消', withdraw_cancel: '撤回取消申请', deny_cancel: '拒绝取消申请',
  agree_cancel: '同意取消', deliver: '记录交付', confirm: '提交本人确认', timeout: '超时关闭'
};
const REVIEW_WINDOW = 14 * 24 * 60 * 60 * 1000;
const CANCEL_RESULTS = {pending: '待回应', agreed: '已同意', denied: '已拒绝', withdrawn: '已撤回'};

function orderBtn(o, a, t) {
  return `<button data-order="${o.id}:${a}">${t}</button>`;
}

// 订单详情补充区块：目标图片、交换双方物品、取消申请审计、交付与评价。
// 图片优先读订单侧副本；旧订单无副本时明示「兼容视图」，不冒充历史原图版本。
async function detailExtras(o, {api, user, e}) {
  const parts = [];
  const legacy = o.snapshotImageSource === 'product_legacy';
  let urls = o.snapshotImages || [];
  if (legacy) {
    try { urls = (await api('/products/' + o.product_id)).images || []; } catch { urls = []; }
  }
  parts.push(`<div class="delivery-location"><strong>下单时的目标图片</strong>${legacy ? '<p class="muted">该订单创建时未固化图片，以下为商品现有图片的兼容视图，不代表历史原图版本。</p>' : ''}<div class="offer-gallery">${urls.length ? urls.map((url, i) => `<img src="${e(url)}" alt="目标图片${i + 1}" loading="lazy">`).join('') : '<p class="muted">暂无图片</p>'}</div></div>`);

  if (o.offer) {
    const seller = user.id === o.seller_id;
    const item = (p, images, condition) => `<section class="exchange-item"><div class="exchange-item-copy"><h2>${e(p.title)}</h2><p class="muted">成色：${e(condition)}</p><p class="offer-description">${e(p.description)}</p></div><div class="offer-gallery">${images.length ? images.map((url, i) => `<img src="${e(url)}" alt="${e(p.title)}，图片${i + 1}" loading="lazy">`).join('') : '<p class="muted">暂无物品图片</p>'}</div></section>`;
    parts.push(`<p class="exchange-intro">${seller ? '对方希望用：' : '您希望用：'}</p>${item(o.offer, o.offer.images, o.offer.condition)}<div class="exchange-divider"><span aria-hidden="true">⇅</span><strong>${seller ? '来交换您的' : '来交换对方的'}</strong></div>${item(o.snapshot, urls, o.snapshot.condition_text)}<p class="muted">物品文字信息以下单时保存的约定为准。</p>`);
  }

  if (o.delivery) {
    const d = JSON.parse(o.delivery);
    if (d.items) {
      parts.push(`<div class="delivery-location"><strong>交换交付的双方物品</strong><p>卖家交付：${e(d.items.seller.title)}（${e(d.items.seller.condition)}）</p><p>买家交付：${e(d.items.buyer.title)}（${e(d.items.buyer.condition)}）</p><small>${new Date(d.occurredAt).toLocaleString()}</small></div>`);
    }
  }

  if (o.cancelRequests?.length) {
    const rows = o.cancelRequests.map(cr => `<div>#${cr.id} · ${cr.requested_by === user.id ? '我' : '对方'}申请 · ${new Date(cr.requested_at).toLocaleString()} · ${e(cr.reason)} · ${e(CANCEL_RESULTS[cr.status] || cr.status)}${cr.responded_at ? ` · 回应于 ${new Date(cr.responded_at).toLocaleString()}` : ''}</div>`).join('');
    parts.push(`<div class="delivery-location"><strong>取消申请记录（编号 / 时间 / 操作者）</strong>${rows}</div>`);
  }

  if (o.status === 'completed') {
    const reviews = o.reviews || [];
    const cards = reviews.map(r => `<section class="panel review-card"><div class="row"><strong>${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</strong><span class="muted">${new Date(r.created_at).toLocaleString()}</span></div><p>${e(r.content)}</p>${r.reply ? `<p class="muted">对方回复：${e(r.reply)}</p>` : r.reviewee_id === user.id ? `<button data-order-reply="${o.id}:${r.id}">回复一次</button>` : ''}</section>`).join('');
    const mine = reviews.some(r => r.reviewer_id === user.id);
    const within = o.completed_at && Date.now() - o.completed_at <= REVIEW_WINDOW;
    parts.push(`<div class="delivery-location"><strong>交易评价</strong>${cards || '<p class="muted">暂无评价</p>'}${!mine && within ? `<div class="actions"><button data-order-review="${o.id}">评价对方</button></div>` : !mine ? '<p class="muted">已完成超过14天，不能再评价。</p>' : ''}</div>`);
  }
  return parts.join('');
}

export async function renderOrderPage({page, user, api, e, heading, emptyState, label, money}) {
  let html = '';
  if (page === 'notifications') {
    const ns = await api('/notifications');
    html = heading('站内通知') + `<section class="panel">${ns.map(n => `<div class="notice row"><div>${e(n.message)}<p class="muted">${new Date(n.created_at).toLocaleString()}</p></div><button data-read="${n.id}">${n.read_at ? '已读' : '标记已读'}</button></div>`).join('') || '暂无通知。'}</section>`;
  }
  if (page === 'orders' || /^orders\/\d+$/.test(page)) {
    const orders = await api('/orders');
    const detail = page !== 'orders';
    const os = detail ? orders.filter(o => o.id === Number(page.split('/')[1])) : orders;
    if (detail && !os.length) throw Error('订单不存在或你无权查看');
    html = detail
      ? heading('订单详情', '核对交换物品与交易约定，再决定是否接单。') + `<div class="actions"><button data-page="orders">返回订单列表</button></div>`
      : heading('交易订单');
    const extras = detail ? await detailExtras(os[0], {api, user, e}) : '';
    html += os.map(o => `<section class="panel order-card ${detail && o.offer ? 'exchange-pair' : ''}" ${!detail ? `data-order-detail="${o.id}" tabindex="0" role="group" aria-label="订单${o.id}，${e(o.snapshot.title)}，按回车查看详情"` : ''}><div class="row"><h2>#${o.id} ${e(o.snapshot.title)}</h2><span class="badge" data-status="${e(o.status)}">${o.status === 'pending' ? '待卖家确认' : label(o.status)}</span></div>${extras}<p>我是${user.id === o.buyer_id ? '买家' : '卖家'} · ${money(o.snapshot.price)}</p>${o.offer && !detail ? `<p>交换提供：${e(o.offer.title)} · 差价${money(o.topup)} · ${o.topup === 0 ? '无须补差价' : o.payer === 'seller' ? '卖家付款' : '买家付款'}</p>` : ''}<div class="delivery-location"><strong>建议交货地点</strong><p>${e(o.snapshot.delivery_location || '尚未填写，请与对方协商')}</p></div>${o.delivery ? `<div class="delivery-location"><strong>实际交付记录</strong><p>${e(JSON.parse(o.delivery).location)}</p><p>${e(JSON.parse(o.delivery).note)}</p><small>${new Date(JSON.parse(o.delivery).occurredAt).toLocaleString()}</small></div>` : ''}<p class="muted">截止：${new Date(o.deadline).toLocaleString()}；买家${o.buyer_confirmed ? '已' : '未'}确认 / 卖家${o.seller_confirmed ? '已' : '未'}确认</p>${o.cancel_status ? `<p>取消申请：${e(CANCEL_RESULTS[o.cancel_status] || o.cancel_status)} · ${e(o.cancel_reason)}</p>` : ''}${o.reject_reason ? `<p>拒单原因：${e(o.reject_reason)}</p>` : ''}<div class="actions ${detail ? 'order-detail-actions' : ''}"><button data-contact-order="${o.id}">联系对方</button>${o.status === 'pending' ? user.id === o.seller_id ? orderBtn(o, 'accept', '接单') + orderBtn(o, 'reject', '拒绝（需填原因）') : orderBtn(o, 'cancel', '取消') : ''}${o.status === 'delivery' ? o.cancel_status === 'pending' ? user.id === o.cancel_by ? orderBtn(o, 'withdraw_cancel', '撤回申请') : orderBtn(o, 'agree_cancel', '同意取消') + orderBtn(o, 'deny_cancel', '拒绝取消') : orderBtn(o, 'request_cancel', '申请取消') + (user.id === o.seller_id ? orderBtn(o, 'deliver', '记录交付') : '') : ''}${o.status === 'confirmation' ? orderBtn(o, 'confirm', '提交本人完成确认') : ''}</div><div class="muted order-events" aria-label="订单操作记录">${o.events.map(ev => `<div>${e(eventNames[ev.action] || ev.action)} · ${e(ev.detail)} · ${new Date(ev.created_at).toLocaleString()}</div>`).join('')}</div></section>`).join('');
    if (!os.length) html += emptyState('每一笔流转，都从发现开始', '目前没有交易订单。先去发现闲置，找到需要的物品。');
  }
  return html;
}

export async function readNotification(id, {api, render}) {
  await api('/notifications/' + id + '/read', 'POST');
  return render();
}

export async function updateOrder(order, {api, toast, render}) {
  const [id, action] = order.split(':');
  const data = {action};
  if (action === 'reject') {
    data.reason = prompt('请填写拒绝原因（必填）');
    if (!data.reason || !data.reason.trim()) { toast('拒绝原因不能为空', 'error'); return; }
  }
  if (action === 'request_cancel') {
    data.reason = prompt('取消原因');
    if (!data.reason) return;
  }
  if (action === 'deliver') {
    data.location = prompt('实际交付地点');
    if (!data.location) return;
    data.note = prompt('交付说明，交换须说明全部物品');
    if (!data.note) return;
    data.occurredAt = Date.now();
    const current = (await api('/orders')).find(x => x.id === Number(id));
    if (current?.offer) {
      if (!confirm('请逐件确认：卖家物品「' + current.snapshot.title + '」已当面交付？')) return;
      if (!confirm('请逐件确认：买家提供的「' + current.offer.title + '」已当面交付？')) return;
      data.items = {seller: {delivered: true}, buyer: {delivered: true}};
    }
  }
  await api('/orders/' + id + '/action', 'POST', data);
  toast('订单已更新');
  return render();
}

// B02/B06：详情版本随下单提交；同一商品的未完成下单意图复用同一 requestKey，
// 网络失败或服务异常（响应不确定）时保留，明确业务拒绝时清除。
export async function placeOrder({$, api, files, toast, navigate, user, selected}) {
  if (!user) return navigate('auth');
  const storageKey = 'campus.orderIntent.' + selected;
  let intent = null;
  try { intent = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch {}
  const key = intent?.requestKey || crypto.randomUUID();
  if (intent) toast('沿用上次未确认的请求标识重试');
  const data = {productId: selected, requestKey: key};
  try {
    const detail = await api('/products/' + selected);
    if (Number.isInteger(detail.version)) data.productVersion = detail.version;
  } catch { /* 详情不可用时由后端按缺省版本口径处理，不猜测版本 */ }
  if ($('#offerform')) {
    if (!$('#offerform').reportValidity()) return;
    data.offer = {
      title: $('#offerTitle').value,
      description: $('#offerDescription').value,
      condition: $('#offerCondition').value,
      images: await files('#offerImages')
    };
    data.topup = Number($('#topup').value);
    data.payer = $('#payer').value;
  }
  try {
    await api('/orders', 'POST', data);
  } catch (err) {
    const uncertain = err instanceof TypeError || /网络连接失败|服务异常|操作未完成/.test(err.message || '');
    try {
      if (uncertain) sessionStorage.setItem(storageKey, JSON.stringify({requestKey: key, productId: selected}));
      else sessionStorage.removeItem(storageKey);
    } catch {}
    if (uncertain) toast('下单结果未确认，请保持原参数重试；改用其他参数会被拒绝', 'error');
    throw err;
  }
  try { sessionStorage.removeItem(storageKey); } catch {}
  toast('下单成功，目标已锁定');
  return navigate('orders');
}

export async function submitOrderReview(id, {api, toast, render}) {
  const raw = prompt('评分（1～5 星，提交后不可修改或删除）');
  if (raw === null) return;
  const rating = Number(raw);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) { toast('评分须为 1～5 的整数', 'error'); return; }
  const content = prompt('评价内容（必填）');
  if (!content || !content.trim()) { toast('评价内容不能为空', 'error'); return; }
  await api('/orders/' + id + '/reviews', 'POST', {rating, content});
  toast('评价已提交');
  return render();
}

export async function replyOrderReview(value, {api, toast, render}) {
  const [orderId, reviewId] = value.split(':');
  const content = prompt('回复内容（每条评价仅可回复一次）');
  if (!content || !content.trim()) { toast('回复内容不能为空', 'error'); return; }
  await api('/orders/' + orderId + '/reviews/' + reviewId + '/reply', 'POST', {content});
  toast('回复已提交');
  return render();
}

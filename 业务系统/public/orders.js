const eventNames={
  create:'创建订单',accept:'卖家接单',reject:'卖家拒绝',cancel:'买家取消',request_cancel:'申请取消',withdraw_cancel:'撤回取消申请',deny_cancel:'拒绝取消申请',agree_cancel:'同意取消',deliver:'记录交付',confirm:'提交本人确认',timeout:'超时关闭'
}
;

function orderBtn(o,a,t){
  return `<button data-order="${o.id}:${a}">${t}</button>`
}

export async function renderOrderPage({page, user, api, e, heading, emptyState, label, money}) {
  let html = '';
  if(page==='notifications'){
    const ns=await api('/notifications');
    html=heading('站内通知')+`<section class="panel">${ns.map(n=>`<div class="notice row"><div>${e(n.message)}<p class="muted">${new Date(n.created_at).toLocaleString()}</p></div><button data-read="${n.id}">${n.read_at?'已读':'标记已读'}</button></div>`).join('')||'暂无通知。'}</section>`
  }
  if(page==='orders'||/^orders\/\d+$/.test(page)){
    const orders=await api('/orders');
    const detail=page!=='orders';
    const os=detail?orders.filter(o=>o.id===Number(page.split('/')[1])):orders;
    if(detail&&!os.length)throw Error('订单不存在或你无权查看');
    html=detail?heading('订单详情','核对交换物品与交易约定，再决定是否接单。')+`<div class="actions"><button data-page="orders">返回订单列表</button></div>`:heading('交易订单');
    let exchangeContent='';
    if(detail&&os[0].offer){
      const o=os[0],seller=user.id===o.seller_id;
      const target=await api('/products/'+o.product_id);
      const item=(p,images,condition)=>`<section class="exchange-item"><div class="exchange-item-copy"><h2>${e(p.title)}</h2><p class="muted">成色：${e(condition)}</p><p class="offer-description">${e(p.description)}</p></div><div class="offer-gallery">${images.length?images.map((url,i)=>`<img src="${e(url)}" alt="${e(p.title)}，图片${i+1}" loading="lazy">`).join(''):'<p class="muted">暂无物品图片</p>'}</div></section>`;
      exchangeContent=`<p class="exchange-intro">${seller?'对方希望用：':'您希望用：'}</p>${item(o.offer,o.offer.images,o.offer.condition)}<div class="exchange-divider"><span aria-hidden="true">⇅</span><strong>${seller?'来交换您的':'来交换对方的'}</strong></div>${item(o.snapshot,target.images,o.snapshot.condition_text)}<p class="exchange-topup">${o.topup===0?'双方无须补差价':`${o.payer==='seller'?'卖家向买家':'买家向卖家'}补差价 ${money(o.topup)}`}</p><p class="muted">物品文字信息以下单时保存的约定为准。</p>`;
    }
    html+=os.map(o=>`<section class="panel order-card ${exchangeContent?'exchange-pair':''}" ${!detail?`data-order-detail="${o.id}" tabindex="0" role="group" aria-label="订单${o.id}，${e(o.snapshot.title)}，按回车查看详情"`:""}><div class="row"><h2>#${o.id} ${e(o.snapshot.title)}</h2><span class="badge" data-status="${e(o.status)}">${o.status==='pending'?'待卖家确认':label(o.status)}</span></div>${exchangeContent}<p>我是${user.id===o.buyer_id?'买家':'卖家'} · ${money(o.snapshot.price)}</p>${o.offer&&!detail?`<p>交换提供：${e(o.offer.title)} · 差价${money(o.topup)} · ${o.topup===0?'无须补差价':o.payer==='seller'?'卖家付款':'买家付款'}</p>`:''}<div class="delivery-location"><strong>建议交货地点</strong><p>${e(o.snapshot.delivery_location||'尚未填写，请与对方协商')}</p></div>${o.delivery?`<div class="delivery-location"><strong>实际交付记录</strong><p>${e(JSON.parse(o.delivery).location)}</p><p>${e(JSON.parse(o.delivery).note)}</p><small>${new Date(JSON.parse(o.delivery).occurredAt).toLocaleString()}</small></div>`:''}<p class="muted">截止：${new Date(o.deadline).toLocaleString()}；买家${o.buyer_confirmed?'已':'未'}确认 / 卖家${o.seller_confirmed?'已':'未'}确认</p>${o.cancel_status?`<p>取消申请：${({pending:'待回应',agreed:'已同意',denied:'已拒绝',withdrawn:'已撤回'})[o.cancel_status]} · ${e(o.cancel_reason)}</p>`:''}<div class="actions ${detail?'order-detail-actions':''}"><button data-contact-order="${o.id}">联系对方</button>${o.status==='pending'?user.id===o.seller_id?orderBtn(o,'accept','接单')+orderBtn(o,'reject','拒绝'):orderBtn(o,'cancel','取消'):''}${o.status==='delivery'?o.cancel_status==='pending'?user.id===o.cancel_by?orderBtn(o,'withdraw_cancel','撤回申请'):orderBtn(o,'agree_cancel','同意取消')+orderBtn(o,'deny_cancel','拒绝取消'):orderBtn(o,'request_cancel','申请取消')+(user.id===o.seller_id?orderBtn(o,'deliver','记录交付'):''):''}${o.status==='confirmation'?orderBtn(o,'confirm','提交本人完成确认'):''}</div><div class="muted order-events" aria-label="订单操作记录">${o.events.map(ev=>`<div>${e(eventNames[ev.action]||ev.action)} · ${e(ev.detail)} · ${new Date(ev.created_at).toLocaleString()}</div>`).join('')}</div></section>`).join('');
    if(!os.length)html+=emptyState('每一笔流转，都从发现开始','目前没有交易订单。先去发现闲置，找到需要的物品。')
  }
  return html;
}

export async function readNotification(id, {api, render}) {
  await api('/notifications/'+id+'/read','POST');
  return render()
}

export async function updateOrder(order, {api, toast, render}) {
  const [id,action]=order.split(':');
  const data={action};
  if(action==='reject'){data.reason=prompt('请填写拒绝原因（必填）');if(!data.reason||!data.reason.trim()){toast('拒绝原因不能为空','error');return}}
  if(action==='request_cancel'){
    data.reason=prompt('取消原因');
    if(!data.reason)return
  }
  if(action==='deliver'){
    data.location=prompt('实际交付地点');
    if(!data.location)return;
    data.note=prompt('交付说明，交换须说明全部物品');
    if(!data.note)return;
    data.occurredAt=Date.now();
    const current=(await api('/orders')).find(x=>x.id===Number(id));
    if(current?.offer){
      if(!confirm('请逐件确认：卖家物品「'+current.snapshot.title+'」已当面交付？'))return;
      if(!confirm('请逐件确认：买家提供的「'+current.offer.title+'」已当面交付？'))return;
      data.items={seller:{delivered:true},buyer:{delivered:true}};
    }
  }
  await api('/orders/'+id+'/action','POST',data);
  toast('订单已更新');
  return render()
}

export async function placeOrder({$, api, files, toast, navigate, user, selected}) {
  if(!user){
    return navigate('auth');
  }
  const data={productId:selected,requestKey:crypto.randomUUID()};
  try{const detail=await api('/products/'+selected);if(Number.isInteger(detail.version))data.productVersion=detail.version}catch{}
  if($('#offerform')){
    if(!$('#offerform').reportValidity())return;
    data.offer={
      title:$('#offerTitle').value,description:$('#offerDescription').value,condition:$('#offerCondition').value,images:await files('#offerImages')
    }
    ;
    data.topup=Number($('#topup').value);
    data.payer=$('#payer').value
  }
  await api('/orders','POST',data);
  toast('下单成功，目标已锁定');
  return navigate('orders');
}

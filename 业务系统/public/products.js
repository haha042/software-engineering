function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
}

function categoryField(cats) {
  if (!cats.length) return '<div class="field"><label for="categoryId">分类</label><select id="categoryId" required disabled><option value="">暂无可用分类</option></select><small>管理员尚未维护分类，请联系管理员后再发布。</small></div>';
  const options = cats.map(c => '<option value="' + c.id + '">' + escapeText(c.name) + '</option>').join('');
  return '<div class="field"><label for="categoryId">分类</label><select id="categoryId" required>' + options + '</select></div>';
}

export async function renderProductPage({page, user, selected, api, e, btn, field, heading, emptyState, card, label, money}) {
  let html = '';
  if(page==='market'){
    const ps=await api('/products');
    let emptyAction='',emptyHint='过段时间再来看看，也欢迎分享你的闲置。';
    if(!user)emptyAction=btn('auth','登录，发布闲置','primary');
    else if(user.role==='student')emptyAction=user.certified?'<button data-page="publish" class="primary">发布我的闲置</button>':'<button data-page="cert" class="primary">前往身份认证</button>';
    else if(user.role==='admin')emptyHint='新的校园好物正在等待上架，稍后再来看看吧。';
    const empty=`<section class="empty-state market-empty"><div class="empty-illustration" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none"><path d="M14 23h36v29H14zM10 23l9-12h26l9 12M32 12v11M25 34c2 5 12 5 14 0"/><path d="M48 6v8M44 10h8"/></svg></div><h2>好物暂时歇个脚</h2><p>目前暂无在售闲置。<br>${emptyHint}</p>${emptyAction}</section>`;
    html=heading('让闲置继续发光','发布前人工审核，下单即锁定物品，交付后双方确认完成。')+`<div class="grid">${ps.map(card).join('')||empty}</div>`
  }
  else if(page==='detail'){
    const p=await api('/products/'+selected);
    html=heading(p.title)+`<div class="twocol"><section class="panel">${p.images.map(url=>`<img src="${url}" alt="商品图片" class="product-image">`).join('')}<p>${e(p.description)}</p><span class="badge" data-status="${e(p.status)}">${label(p.status)}</span><p>${e(p.owner_name)} · ${e(p.condition_text)}</p><span class="price">${money(p.price)}</span></section><section class="panel"><h2>核对交易约定</h2><div class="delivery-location"><strong>建议交货地点</strong><p>${e(p.delivery_location||'尚未填写，请与卖家协商')}</p><small>最终地点由双方协商确认</small></div><p>资金双方线下处理，平台不验证到账。</p>${p.trade_type==='exchange'?`<form id="offerform">${field('offerTitle','提供物品名称','text','required')}${field('offerCondition','成色','text','required')}<div class="field"><label for="offerDescription">提供物品描述</label><textarea id="offerDescription" required></textarea></div>${field('offerImages','1～6张物品图片','file','accept="image/png,image/jpeg" multiple required')}${field('topup','差价（元）','number','value="0" min="0" max="99999.99" step="0.01"')}<div class="field"><label for="payer">差价付款方向</label><select id="payer"><option value="buyer">买家付给卖家</option><option value="seller">卖家付给买家</option></select></div></form>`:''}${p.status==='live'&&user?.id!==p.owner_id?`<button data-contact-product="${p.id}">联系卖家</button>`:''}${p.status==='live'?btn('buy','确认下单','primary'):'<p>物品暂不可交易。</p>'}<p class="muted">卖家48小时内接单，约定变更须结束原单后重新下单。</p></section></div>`
  }
    const cats = page==='publish' ? await api('/categories') : [];
    if(page==='publish')html=heading('发布校园闲置','1～6张JPG/PNG，每张不超过5 MiB，提交后等待审核。')+`<section class="panel"><form id="publishform">${field('title','标题','text','required maxlength="80"')}<div class="formgrid">$${categoryField(cats)}${field('condition','成色','text','required')}<div class="field"><label for="tradeType">交易方式</label><select id="tradeType"><option value="sale">出售</option><option value="gift">免费转让</option><option value="exchange">以物易物</option></select></div>${field('price','出售价格（元）','number','value="1" min="0" max="99999.99" step="0.01"')}</div><div class="field"><label for="description">描述</label><textarea id="description" required></textarea></div>${field('deliveryLocation','建议交货地点','text','required maxlength="200" placeholder="如：北校区图书馆正门"')}<p class="muted">填写校内公共地点，具体交付时间与地点可由双方协商。</p>${field('expectation','期望交换条件（交换必填）')}${field('images','图片','file','accept="image/png,image/jpeg" multiple required')}<button class="primary">提交审核</button></form></section>`;
    if(page==='mine'){
      const ps=await api('/products/mine');
      html=heading('我的发布')+`<div class="grid">${ps.map(card).join('')||emptyState('还没有发布物品','整理书桌和宿舍，让闲置物品开启下一段使用旅程。')}</div>`
    }
  return html;
}

export async function publishProduct({$, api, files, toast, navigate}) {
  await api('/products','POST',{
    title:$('#title').value,categoryId:Number($('#categoryId').value),condition:$('#condition').value,description:$('#description').value,tradeType:$('#tradeType').value,price:Number($('#price').value),expectation:$('#expectation').value,deliveryLocation:$('#deliveryLocation').value,images:await files('#images')
  }
  );
  toast('物品已提交审核');
  await navigate('mine');
}

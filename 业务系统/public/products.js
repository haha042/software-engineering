// 市场页筛选状态：跨渲染保留，重置时回到默认列表。
const DEFAULT_SORT = 'latest';
const filters = {q: '', category: '', tradeType: '', condition: '', minPrice: '', maxPrice: '', sort: DEFAULT_SORT};
const active = () => Object.entries(filters).filter(([k, v]) => v !== '' && !(k === 'sort' && v === DEFAULT_SORT));
export function resetFilters() {
  Object.assign(filters, {q: '', category: '', tradeType: '', condition: '', minPrice: '', maxPrice: '', sort: DEFAULT_SORT});
}
export async function applyFilters({$, navigate}) {
  const form = $('#filterform');
  if (!form) return;
  filters.q = form.elements.q.value.trim();
  filters.category = form.elements.category.value;
  filters.tradeType = form.elements.tradeType.value;
  filters.condition = form.elements.condition.value;
  filters.minPrice = form.elements.minPrice.value.trim();
  filters.maxPrice = form.elements.maxPrice.value.trim();
  filters.sort = form.elements.sort.value;
  return navigate('market');
}
const options = (values, current) => ['<option value="">全部</option>'].concat(values.map(v => `<option value="${escapeAttr(v)}"${v === current ? ' selected' : ''}>${escapeAttr(v)}</option>`)).join('');
const escapeAttr = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
function filterBar(facets) {
  return `<form id="filterform" class="filter-bar" role="search" aria-label="筛选在售物品">
<div class="field"><label for="q">关键词</label><input id="q" name="q" type="search" value="${escapeAttr(filters.q)}" placeholder="标题或描述"></div>
<div class="field"><label for="category">分类</label><select id="category" name="category">${options(facets.categories, filters.category)}</select></div>
<div class="field"><label for="tradeType">交易方式</label><select id="tradeType" name="tradeType">${['<option value="">全部</option>', `<option value="sale"${filters.tradeType === 'sale' ? ' selected' : ''}>出售</option>`, `<option value="gift"${filters.tradeType === 'gift' ? ' selected' : ''}>免费转让</option>`, `<option value="exchange"${filters.tradeType === 'exchange' ? ' selected' : ''}>以物易物</option>`].join('')}</select></div>
<div class="field"><label for="condition">成色</label><select id="condition" name="condition">${options(facets.conditions, filters.condition)}</select></div>
<div class="field price-range"><label for="minPrice">价格区间（元）</label><div class="range-inputs"><input id="minPrice" name="minPrice" type="number" min="0" max="99999.99" step="0.01" value="${escapeAttr(filters.minPrice)}" placeholder="最低" aria-label="最低价"><span aria-hidden="true">～</span><input id="maxPrice" name="maxPrice" type="number" min="0" max="99999.99" step="0.01" value="${escapeAttr(filters.maxPrice)}" placeholder="最高" aria-label="最高价"></div></div>
<div class="field sort-field"><label for="sort">排序</label><select id="sort" name="sort">${[['latest', '最新发布'], ['oldest', '最早发布'], ['price_asc', '价格从低到高'], ['price_desc', '价格从高到低']].map(([v, t]) => `<option value="${v}"${filters.sort === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
<div class="filter-actions"><button class="primary">筛选</button><button type="button" data-action="reset-filters">重置</button></div>
</form>`;
}
export async function renderProductPage({page, user, selected, api, e, btn, field, heading, emptyState, card, label, money}) {
  let html = '';
  if(page==='market'){
    const facets=await api('/products/facets');
    const query=new URLSearchParams(active()).toString();
    const ps=await api('/products'+(query?'?'+query:''));
    let emptyAction='',emptyHint='过段时间再来看看，也欢迎分享你的闲置。';
    if(!user)emptyAction=btn('auth','登录，发布闲置','primary');
    else if(user.role==='student')emptyAction=user.certified?'<button data-page="publish" class="primary">发布我的闲置</button>':'<button data-page="cert" class="primary">前往身份认证</button>';
    else if(user.role==='admin')emptyHint='新的校园好物正在等待上架，稍后再来看看吧。';
    const filtered=active().length>0;
    const empty=`<section class="empty-state market-empty"><div class="empty-illustration" aria-hidden="true"><svg viewBox="0 0 64 64" fill="none"><path d="M14 23h36v29H14zM10 23l9-12h26l9 12M32 12v11M25 34c2 5 12 5 14 0"/><path d="M48 6v8M44 10h8"/></svg></div><h2>${filtered?'没有符合条件的物品':'好物暂时歇个脚'}</h2><p>${filtered?'换个关键词、放宽价格区间，或者清空筛选条件再看一次。':'目前暂无在售闲置。<br>'+emptyHint}</p>${filtered?'<button data-action="reset-filters" class="primary">清空筛选条件</button>':emptyAction}</section>`;
    const summary=filtered?`<p class="filter-summary" role="status">筛选到 ${ps.length} 件在售物品</p>`:'';
    html=heading('让闲置继续发光','发布前人工审核，下单即锁定物品，交付后双方确认完成。')+filterBar(facets)+summary+`<div class="grid">${ps.map(card).join('')||empty}</div>`
  }
  else if(page==='detail'){
    const p=await api('/products/'+selected);
    if(user){const favs=await api('/favorites').catch(()=>[]);p.favorited=favs.some(f=>f.id===p.id);}
    html=heading(p.title)+`<div class="twocol"><section class="panel">${p.images.map(url=>`<img src="${url}" alt="商品图片" class="product-image">`).join('')}<p>${e(p.description)}</p><span class="badge" data-status="${e(p.status)}">${label(p.status)}</span><p>${e(p.owner_name)} · ${e(p.condition_text)}</p><span class="price">${money(p.price)}</span></section><section class="panel"><h2>核对交易约定</h2><div class="delivery-location"><strong>建议交货地点</strong><p>${e(p.delivery_location||'尚未填写，请与卖家协商')}</p><small>最终地点由双方协商确认</small></div><p>资金双方线下处理，平台不验证到账。</p>${p.trade_type==='exchange'?`<form id="offerform">${field('offerTitle','提供物品名称','text','required')}${field('offerCondition','成色','text','required')}<div class="field"><label for="offerDescription">提供物品描述</label><textarea id="offerDescription" required></textarea></div>${field('offerImages','1～6张物品图片','file','accept="image/png,image/jpeg" multiple required')}${field('topup','差价（元）','number','value="0" min="0" max="99999.99" step="0.01"')}<div class="field"><label for="payer">差价付款方向</label><select id="payer"><option value="buyer">买家付给卖家</option><option value="seller">卖家付给买家</option></select></div></form>`:''}${p.status==='live'&&user?.id!==p.owner_id?`<button data-contact-product="${p.id}">联系卖家</button>`:''}${(p.status==='live'||p.status==='rejected')&&user&&user.id===p.owner_id?`<button class="ghost" data-edit="${p.id}">修改并重新提交</button>`:''}${p.status==='live'&&user&&user.id===p.owner_id?`<button class="ghost" data-product-state="off" data-product="${p.id}">下架</button>`:''}${p.status==='off'&&user&&user.id===p.owner_id?`<button class="ghost" data-product-state="relist" data-product="${p.id}">重新上架</button>`:''}${user?`<button class="ghost" data-favorite="${p.id}">${p.favorited?'已收藏':'收藏'}</button>`:''}${p.status==='live'?btn('buy','确认下单','primary'):'<p>物品暂不可交易。</p>'}<p class="muted">卖家48小时内接单，约定变更须结束原单后重新下单。</p></section></div>`
  }
    if(page==='publish'||page==='edit'){
      const editing=page==='edit';
      const loaded=editing?(await api('/products/'+selected)):(await api('/products/draft').catch(()=>null)).draft||null;
      const d=loaded||null;
      const values=d?toFormValues(d):null;
      html=heading(editing?'修改物品':'发布校园闲置',editing?'改完会重新进入审核，审核期间不会出现在市场列表。':'1～6张JPG/PNG，每张不超过5 MiB。草稿只有你自己可见，提交后才进入审核。')
        +`<section class="panel"><form id="${editing?'editform':'publishform'}" data-draft-id="${editing?'':(d?d.id:'')}">`
        +'<input type="hidden" id="draftId" value="'+(editing?'':(d?d.id:''))+'">'
        +(editing?'<p class="muted">当前状态：'+e(statusLabel(d&&d.status))+'。</p>':'')
        +`<div class="draft-bar"><span class="draft-hint">${editing?'修改标题、描述、价格、图片等都会重新审核':'已恢复上次保存的草稿，继续编辑后可以直接提交'}</span>`
        +(editing?'':'<button type="button" class="ghost" data-action="save-draft">保存草稿</button>')+'</div>'
        +fieldsHtml(values,e,editing)
        +`<button class="primary">${editing?'保存并重新提交':'提交审核'}</button></form></section>`;
      if(!editing)watchUnsaved();
    }
    if(page==='favorites'){
      const list=await api('/favorites');
      html=heading('我的收藏','最多 100 件，失效的物品会标注出来，可以随时取消收藏。')
        +`<div class="grid">${list.map(p=>`<div class="favitem">${card(p)}<button class="ghost" data-favorite="${p.id}" data-favorited="1">取消收藏</button></div>`).join('')||emptyState('还没有收藏','在物品详情页点“收藏”，这里就能找到它。')}</div>`;
    }
    if(page==='mine'){
      const ps=await api('/products/mine');
      html=heading('我的发布')+`<div class="grid">${ps.map(card).join('')||emptyState('还没有发布物品','整理书桌和宿舍，让闲置物品开启下一段使用旅程。')}</div>`
    }
  return html;
}

function statusLabel(status) {
  return { draft: '草稿', pending: '待审核', live: '在售', reserved: '预订中', sold: '已成交', rejected: '审核驳回', off: '已下架' }[status] || status || '';
}

function toFormValues(row) {
  if (!row) return {};
  return {
    title: row.title,
    category: row.category,
    condition: row.condition === undefined ? row.condition_text : row.condition,
    description: row.description,
    tradeType: row.tradeType === undefined ? row.trade_type : row.tradeType,
    price: row.price,
    expectation: row.expectation,
    deliveryLocation: row.deliveryLocation === undefined ? row.delivery_location : row.deliveryLocation
  };
}

function fieldsHtml(d, e, editing) {
  const v = k => e(d && d[k] !== null && d[k] !== undefined ? String(d[k]) : '');
  const yuan = k => (d && d[k] !== null && d[k] !== undefined && d.tradeType !== 'exchange') ? String(Number(d[k]) / 100) : '';
  const sel = t => (d && d.tradeType === t) ? ' selected' : '';
  return ''
    + `<div class="field"><label for="title">标题</label><input id="title" name="title" maxlength="80" value="${v('title')}"></div>`
    + `<div class="formgrid">`
    + `<div class="field"><label for="category">分类</label><input id="category" name="category" placeholder="如：书籍教材" value="${v('category')}"></div>`
    + `<div class="field"><label for="condition">成色</label><input id="condition" name="condition" placeholder="如：九成新" value="${v('condition')}"></div>`
    + `<div class="field"><label for="tradeType">交易方式</label><select id="tradeType"><option value="sale"${sel('sale')}>出售</option><option value="gift"${sel('gift')}>免费转让</option><option value="exchange"${sel('exchange')}>以物易物</option></select></div>`
    + `<div class="field"><label for="price">出售价格（元）</label><input id="price" name="price" type="number" min="0" max="99999.99" step="0.01" value="${yuan('price')}"></div>`
    + `</div>`
    + `<div class="field"><label for="description">描述</label><textarea id="description" name="description">${v('description')}</textarea></div>`
    + `<div class="field"><label for="deliveryLocation">建议交货地点</label><input id="deliveryLocation" name="deliveryLocation" maxlength="200" placeholder="如：北校区图书馆正门" value="${v('deliveryLocation')}"></div>`
    + `<p class="muted">填写校内公共地点，具体交付时间与地点可由双方协商。</p>`
    + `<div class="field"><label for="expectation">期望交换条件（交换必填）</label><input id="expectation" name="expectation" value="${v('expectation')}"></div>`
    + `<div class="field"><label for="images">图片${editing ? '（不选则保留原图）' : '（重新选择会替换草稿里的图片）'}</label><input id="images" name="images" type="file" accept="image/png,image/jpeg" multiple></div>`;
}

const payloadOf = $ => ({
  title: $('#title').value.trim(),
  category: $('#category').value.trim(),
  condition: $('#condition').value.trim(),
  description: $('#description').value.trim(),
  tradeType: $('#tradeType').value,
  price: $('#price').value,
  expectation: $('#expectation').value.trim(),
  deliveryLocation: $('#deliveryLocation').value.trim()
});

const REQUIRED = [['title', '标题'], ['category', '分类'], ['condition', '成色'], ['description', '描述'], ['deliveryLocation', '建议交货地点']];
const CLEARABLE = ['title', 'category', 'condition', 'description', 'deliveryLocation', 'price', 'expectation'];

function clearInvalid($) { for (const key of CLEARABLE) $('#'.concat(key)).classList.remove('invalid'); }
function markInvalid($, key, message) {
  const input = $('#' + key);
  input.classList.add('invalid');
  input.focus();
  input.scrollIntoView({ block: 'center' });
  return message;
}

let unsaved = false;
function watchUnsaved() {
  unsaved = false;
  const form = document.querySelector('#publishform');
  if (!form) return;
  form.addEventListener('input', () => { unsaved = true; });
  form.addEventListener('submit', () => { unsaved = false; });
  if (!window.__ccUnsaved) {
    window.__ccUnsaved = true;
    window.addEventListener('beforeunload', ev => {
      if (!unsaved) return;
      ev.preventDefault();
      ev.returnValue = '发布内容还没有保存为草稿，确定离开吗？';
      return ev.returnValue;
    });
  }
}

export async function saveDraft({ $, api, files, toast, silent = false }) {
  const payload = payloadOf($);
  const picked = document.querySelector('#images').files.length ? await files('#images') : null;
  if (picked) payload.images = picked;
  const saved = await api('/products/draft', 'PUT', payload);
  const hidden = $('#draftId');
  if (hidden) hidden.value = saved.id;
  const form = document.querySelector('#publishform');
  if (form) form.dataset.draftId = String(saved.id);
  unsaved = false;
  if (!silent) toast('草稿已保存，下次进来还能接着写');
  return saved.id;
}

export async function publishProduct({ $, api, files, toast, navigate }) {
  const payload = payloadOf($);
  clearInvalid($);
  const missing = REQUIRED.find(([key]) => !payload[key]);
  if (missing) {
    toast(markInvalid($, missing[0], missing[1] + '不能为空'));
    return;
  }
  if (payload.tradeType === 'exchange' && !payload.expectation) {
    toast(markInvalid($, 'expectation', '以物易物需要写清期望条件'));
    return;
  }
  if (payload.tradeType === 'sale' && !(Number(payload.price) > 0)) {
    toast(markInvalid($, 'price', '出售价格须大于 0'));
    return;
  }
  const draftId = $('#draftId').value;
  const picked = document.querySelector('#images').files.length ? await files('#images') : null;
  if (!draftId && !picked) {
    toast(markInvalid($, 'images', '请至少上传一张图片'));
    return;
  }
  const body = { ...payload, draftId: draftId || undefined };
  if (picked) body.images = picked;
  await api('/products', 'POST', body);
  if (draftId) await api('/products/draft', 'DELETE').catch(() => {});
  unsaved = false;
  toast('物品已提交审核');
  await navigate('mine');
}

export async function saveProductEdit({ $, api, files, toast, navigate, selected }) {
  const payload = payloadOf($);
  clearInvalid($);
  const missing = REQUIRED.find(([key]) => !payload[key]);
  if (missing) {
    toast(markInvalid($, missing[0], missing[1] + '不能为空'));
    return;
  }
  if (payload.tradeType === 'exchange' && !payload.expectation) {
    toast(markInvalid($, 'expectation', '以物易物需要写清期望条件'));
    return;
  }
  if (payload.tradeType === 'sale' && !(Number(payload.price) > 0)) {
    toast(markInvalid($, 'price', '出售价格须大于 0'));
    return;
  }
  const picked = document.querySelector('#images').files.length ? await files('#images') : null;
  if (picked) payload.images = picked;
  await api('/products/' + selected, 'PATCH', payload);
  toast('已提交，等待重新审核');
  await navigate('mine');
}

export async function changeProductState({ api, toast, navigate, id, action }) {
  try {
    const r = await api('/products/' + id + '/status', 'POST', { action });
    toast(r.status === 'off' ? '已下架，市场上看不到这件物品了' : '已重新上架');
    await navigate('mine');
  } catch (err) {
    toast(err.message || '操作失败');
  }
}

export async function toggleFavorite({ api, toast, render, id, favorite }) {
  try {
    if (favorite) await api('/products/' + id + '/favorite', 'DELETE');
    else await api('/products/' + id + '/favorite', 'POST');
    toast(favorite ? '已取消收藏' : '已加入收藏');
    await render();
  } catch (err) {
    toast(err.message || '操作失败');
  }
}

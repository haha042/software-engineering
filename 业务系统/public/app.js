import {createMessages} from './messages.js';
import {renderAccountPage, createAccountActions} from './accounts.js';
import {renderAdminPage, filterAccounts, reviewItem} from './admin.js';
import {renderOrderPage, placeOrder, readNotification, updateOrder} from './orders.js';
import {renderProductPage, publishProduct, saveDraft, saveProductEdit, changeProductState, toggleFavorite, applyFilters, resetFilters} from './products.js';

const $=s=>document.querySelector(s),e=s=>String(s??'').replace(/[&<>"']/g,c=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}
[c]));
let user=null,csrf='',page=location.hash.slice(1)||'market',selected=null,loading=false;
const labels={
  pending:'待审核',approved:'通过',rejected:'驳回',live:'在售',reserved:'已预订',sold:'已成交',off:'已下架',delivery:'待交付',confirmation:'待双方确认',completed:'已完成',cancelled:'已取消',closed:'已关闭',sale:'出售',gift:'免费转让',exchange:'以物易物'
}
;
const label=s=>labels[s]||s;
const money=p=>p===null?'交换':p===0?'免费':'¥ '+(p/100).toFixed(2);
const btn=(a,t,cls='')=>`<button data-action="${a}" class="${cls}">${t}</button>`;
let toastTimer;
function toast(t, tone = 'success') {
  clearTimeout(toastTimer);
  const notice = $('#toast');
  notice.textContent = t;
  notice.dataset.tone = tone;
  notice.style.display = 'block';
  toastTimer = setTimeout(() => notice.style.display = 'none', 6500);
}
function formError(error, form = $('#app form')) {
  if (!form) return toast(error.message, 'error');
  let summary = form.querySelector('.form-error');
  if (!summary) {
    summary = document.createElement('div');
    summary.className = 'form-error';
    summary.setAttribute('role', 'alert');
    summary.tabIndex = -1;
    form.prepend(summary);
  }
  summary.textContent = error.message + '。请检查输入后重试，已填写内容将保留。';
  summary.focus();
}
function emptyState(title, detail, action = '') {
  return `<section class="empty-state"><h2>${title}</h2><p>${detail}</p>${action}</section>`;
}
let focusedPage = null;
async function api(path, method = 'GET', data, background = false) {
  const controls = method === 'GET' || background ? [] : [...document.querySelectorAll('#app button, #account button')].filter(b => !b.disabled);
  controls.forEach(b => {
    b.disabled = true;
    b.setAttribute('aria-busy', 'true');
  }
  );
  try {
    const r = await fetch('/api' + path, {
      method,
      headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': csrf
      }
      ,
      body: data === undefined ? undefined : JSON.stringify(data)
    }
    );
    const b = await r.json();
    if (!r.ok) throw Error(b.error || '请求失败');
    return b;
  }
  catch (error) {
    if (error instanceof TypeError) throw Error('网络连接失败，请检查本地服务是否已启动');
    throw error;
  }
  finally {
    controls.forEach(b => {
      b.disabled = false;
      b.removeAttribute('aria-busy');
    }
    );
  }
}
const field=(name,title,type='text',extra='')=>{
  const input=`<input id="${name}" name="${name}" type="${type}" ${extra}>`;
  return `<div class="field"><label for="${name}">${title}</label>${type==='password'?`<div class="password-control">${input}<button type="button" class="password-toggle" data-password-toggle="${name}" aria-controls="${name}" aria-label="显示${title}" aria-pressed="false">显示</button></div>`:input}</div>`;
};
function heading(t,s=''){
  return `<div class="title"><div><span class="eyebrow">CAMPUS CIRCULAR</span><h1>${e(t)}</h1><p class="muted">${e(s)}</p></div></div>`
}
function card(p){
  return `<article class="card" data-detail="${p.id}" role="button" tabindex="0" aria-label="查看${e(p.title)}详情">${p.images[0]?`<img src="${p.images[0]}" alt="${e(p.title)}" class="card-image" width="600" height="450" loading="lazy">`:''}<div class="cardbody"><span class="badge" data-status="${e(p.status)}">${label(p.status)} · ${label(p.trade_type)}</span><h3>${e(p.title)}</h3><p class="muted">${e(p.category)} · ${e(p.condition_text)}</p><div class="row"><span class="price">${money(p.price)}</span></div>${p.review_reason?`<p>${e(p.review_reason)}</p>`:''}</div></article>`
}
const messages = createMessages({
  $, api, e, emptyState, heading, peerAvatar,
  getUser: () => user,
  getPage: () => page,
});
function peerAvatar(id,name,version,cls=''){
  return version?`<img class="avatar ${cls}" src="/api/users/${id}/avatar?v=${encodeURIComponent(version)}" alt="${e(name)}的头像">`:`<span class="avatar avatar-default ${cls}" aria-label="默认头像">${e(name.slice(0,1).toUpperCase())}</span>`;
}
function avatarMarkup(cls=''){
  return user.avatarVersion?`<img class="avatar ${cls}" src="/api/profile/avatar?v=${encodeURIComponent(user.avatarVersion)}" alt="我的头像">`:`<span class="avatar avatar-default ${cls}" aria-label="默认头像">${e(user.username.slice(0,1).toUpperCase())}</span>`;
}
function setSession(session) {
  user = session.user;
  csrf = session.csrf;
}

function navigate(next, {replaceHash = false, refreshSession = false} = {}) {
  page = next;
  if (replaceHash) history.replaceState(null, '', '#' + next);
  return refreshSession ? refresh() : render();
}

const accountActions = createAccountActions({
  $, api, e, toast, render, navigate, getUser: () => user, setSession,
});
const productActions = {$, api, files, toast, navigate};
const orderActions = {...productActions, render};
const adminActions = {api, toast, render};

async function render(){
  if(loading)return;
  loading=true;
  $('#app').setAttribute('aria-busy','true');
  if(focusedPage!==page)$('#app').innerHTML='<div class="loading-state" role="status">正在加载页面…</div>';
  try{
    $('#account').innerHTML=user?`${e(user.username)} · ${user.role==='admin'?'管理员':user.certified?'已认证学生':'未认证'} <button data-page="profile" class="account-profile">${avatarMarkup()}<span>我的</span></button> ${btn('logout','退出')}`:btn('auth','登录 / 注册');
    $('[data-page="admin"]').hidden=user?.role!=='admin';
    document.querySelectorAll('[data-page]').forEach(b=>{
      const active=b.dataset.page===page||(b.dataset.page==='messages'&&page.startsWith('messages/'));
      b.classList.toggle('active',active);
      if(active)b.setAttribute('aria-current','page');
      else b.removeAttribute('aria-current');
    }
    );
    let html='';
    const context = {page, user, api, e, heading, emptyState};
    const accountContext = {...context, field, avatarMarkup, peerAvatar, card, resetAvatarEditor: accountActions.resetAvatarEditor};
    const productContext = {...context, selected, btn, field, card, label, money};

    if (page === 'auth' || page === 'register') {
      html = await renderAccountPage(accountContext);
    } else if (page === 'market' || page === 'detail') {
      html = await renderProductPage(productContext);
    } else if (!user) {
      page = 'auth';
      loading = false;
      return render();
    } else if (page === 'messages' || /^messages\/\d+$/.test(page)) {
      html = await messages.renderPage(page);
    } else if (['profile', 'profile-edit', 'cert'].includes(page) || /^users\/\d+$/.test(page)) {
      html = await renderAccountPage(accountContext);
    } else if (page === 'publish' || page === 'mine') {
      html = await renderProductPage(productContext);
    } else if (page === 'notifications' || page === 'orders' || /^orders\/\d+$/.test(page)) {
      html = await renderOrderPage({...context, label, money});
    } else if (page === 'admin' || page === 'admin-users' || /^admin-users\/\d+$/.test(page)) {
      html = await renderAdminPage({...context, label, money});
    }
    $('#app').innerHTML=html;
    messages.afterRender();
    if(focusedPage!==page){
      $('#app').focus({
        preventScroll:true
      }
      );
      focusedPage=page;
    }
  }
  catch(err){
    $('#app').innerHTML=heading('暂时无法显示')+`<section class="panel">${e(err.message)}</section>`;
    toast(err.message,'error')
  }
  finally{
    loading=false;
    $('#app').setAttribute('aria-busy','false');
  }
}
async function refresh(){
  const m=await api('/me');
  user=m.user;
  csrf=m.csrf||'';
  await render()
}
async function files(id){
  const fs=[...$(id).files];
  if(fs.length<1||fs.length>6)throw Error('图片须1～6张');
  return Promise.all(fs.map(f=>{
    if(f.size>5242880)throw Error('每张图片最多5 MiB');
    return new Promise((resolve,reject)=>{
      const r=new FileReader;
      r.onload=()=>resolve(r.result);
      r.onerror=reject;
      r.readAsDataURL(f)
    }
    )
  }
  ))
}
document.addEventListener('submit',async ev=>{
  ev.preventDefault();
  try{
    if(ev.target.id==='messageform')return await messages.sendMessage();
    if (ev.target.id === 'authform') return await accountActions.login();
    if (ev.target.id === 'registerform') return await accountActions.register();
    if (ev.target.id === 'profileform') return await accountActions.saveProfile();
    if (ev.target.id === 'certform') return await accountActions.certify();
    if (ev.target.id === 'publishform') return await publishProduct(productActions);
    if (ev.target.id === 'editform') return await saveProductEdit({...productActions, selected});
    if (ev.target.id === 'filterform') return await applyFilters(productActions);
  }
  catch(err){
    formError(err,ev.target)
  }
}
);
document.addEventListener('keydown',ev=>{
  const card=ev.target.closest('.card[data-detail], .order-card[data-order-detail]');
  if(card&&ev.target===card&&(ev.key==='Enter'||ev.key===' ')){
    ev.preventDefault();
    card.click();
  }
});
document.addEventListener('click',async ev=>{
  const b=ev.target.closest('button, [data-detail], [data-order-detail]');
  if(!b)return;
  if (b.dataset.passwordToggle) return accountActions.togglePassword(b);
  try{
    if(b.dataset.contactProduct||b.dataset.contactOrder){
      if(!user){page='auth';history.replaceState(null,'','#auth');return render();}
      const body=b.dataset.contactOrder?{orderId:Number(b.dataset.contactOrder)}:{productId:Number(b.dataset.contactProduct)};
      page=await messages.openConversation(body);history.replaceState(null,'','#'+page);return render();
    }
    if(b.dataset.action==='older-messages'){await messages.syncChat(true);return;}
    if(b.dataset.action==='reset-filters'){resetFilters();await navigate('market');return;}
    if (accountActions.handleAvatarClick(b)) return;
    if(b.dataset.page){
      page=b.dataset.page;
      history.replaceState(null,'','#'+page);
      return render()
    }
    if(b.dataset.orderDetail){
      page='orders/'+b.dataset.orderDetail;
      history.replaceState(null,'','#'+page);
      return render();
    }
    if(b.dataset.favorite){await toggleFavorite({...productActions,render,id:+b.dataset.favorite,favorite:b.dataset.favorited==='1'});return;}
    if(b.dataset.productState){await changeProductState({...productActions,id:+b.dataset.product,action:b.dataset.productState});return;}
    if(b.dataset.edit){selected=+b.dataset.edit;page='edit';history.replaceState(null,'','#edit');return render();}
    if(b.dataset.detail){
      selected=+b.dataset.detail;
      page='detail';
      return render()
    }
    if (b.dataset.review) return await reviewItem(b.dataset.review, adminActions);
    if (b.dataset.read) return await readNotification(b.dataset.read, orderActions);
    if (b.dataset.order) return await updateOrder(b.dataset.order, orderActions);
    if(b.dataset.action==='auth'){
      page='auth';
      history.replaceState(null,'','#auth');
      return render()
    }
    if(b.dataset.action==='logout'){
      await api('/logout','POST');
      page='market';
      history.replaceState(null,'','#market');
      return refresh()
    }
    if (b.dataset.action === 'buy') return await placeOrder({...orderActions, user, selected});
  }
  catch(err){
    if(['register','buy'].includes(b.dataset.action))formError(err);
    else toast(err.message,'error')
  }
}
);
window.addEventListener('hashchange',()=>{
  page=location.hash.slice(1)||'market';
  render()
}
);
setInterval(()=>{if(!loading)messages.poll();},5000);
refresh().catch(error=>{
  $('#app').innerHTML=emptyState('暂时无法连接服务','请确认本地服务器正在运行，然后刷新页面重试。');
  toast(error.message,'error')
}
);

document.addEventListener('input',ev=>{
 if(ev.target.id!=='accountSearch')return;
 filterAccounts(ev.target, $);
});

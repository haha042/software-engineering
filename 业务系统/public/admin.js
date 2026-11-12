export async function renderAdminPage({page, user, api, e, heading, emptyState, label, money}) {
  let html = '';
  if(page==='admin-users'){
    const {users}=await api('/admin/users');
    html=heading('账号管理',`共 ${users.length} 个账号，包含管理员和未认证学生。`)+`<section class="panel"><a href="#admin">返回管理工作台</a><div class="field"><label for="accountSearch">搜索用户名或昵称</label><input id="accountSearch" type="search" placeholder="输入用户名或昵称"></div><div id="accountList">${users.map(u=>`<article class="notice" data-account-name="${e((u.username+' '+u.nickname).toLowerCase())}"><div class="row"><h2>${e(u.nickname||u.username)}</h2><a href="#admin-users/${u.id}">查看账号详情</a></div><p>账号 #${u.id} · ${e(u.username)} · ${u.role==='admin'?'管理员':'学生'} · ${u.certified?'已认证':label(u.certification_status||'未申请认证')}</p><p class="muted">注册于 ${new Date(u.created_at).toLocaleString()} · 发布 ${u.product_count} 件 · 订单 ${u.order_count} 笔</p></article>`).join('')}</div><p id="accountSearchEmpty" hidden role="status">没有匹配的账号。</p></section>`;
  }
  if(/^admin-users\/\d+$/.test(page)){
    const {account:a,certifications,counts}=await api('/admin/users/'+Number(page.split('/')[1]));
    html=heading('账号详情',a.username)+`<section class="panel"><a href="#admin-users">返回账号列表</a><h2>基本资料</h2>${a.avatar?`<img class="avatar avatar-large" src="${e(a.avatar)}" alt="${e(a.username)}的头像">`:' <p>尚未设置头像</p>'}<dl><dt>账号编号</dt><dd>${a.id}</dd><dt>用户名</dt><dd>${e(a.username)}</dd><dt>昵称</dt><dd>${e(a.nickname||'未填写')}</dd><dt>简介</dt><dd>${e(a.bio||'未填写')}</dd><dt>角色</dt><dd>${a.role==='admin'?'管理员':'学生'}</dd><dt>校园认证</dt><dd>${a.certified?'已认证':'未认证'}</dd><dt>注册时间</dt><dd>${new Date(a.created_at).toLocaleString()}</dd><dt>登录状态</dt><dd>${a.locked_until>Date.now()?'登录锁定至 '+new Date(a.locked_until).toLocaleString():'未锁定'} · 连续失败 ${a.failed_attempts} 次</dd><dt>密码</dt><dd>已设置</dd><dt>业务记录</dt><dd>发布 ${counts.products} 件 · 订单 ${counts.orders} 笔</dd></dl><p class="muted">手机号、邮箱尚未采集。当前页面提供信息查看。</p></section><section class="panel"><h2>认证申请历史</h2>${certifications.map(c=>`<article class="notice"><h3>${e(c.real_name)} · ${e(c.student_no)}</h3><p>${label(c.status)} · 申请于 ${new Date(c.created_at).toLocaleString()}</p><p>审核人：${e(c.reviewer_name||'尚未审核')} ${c.reviewed_at?' · '+new Date(c.reviewed_at).toLocaleString():''}</p>${c.reason?`<p>审核理由：${e(c.reason)}</p>`:''}</article>`).join('')||'<p>暂无认证申请。</p>'}</section>`;
  }
  if(page==='admin'){
    if(user.role!=='admin')throw Error('需要管理员权限');
    const q=await api('/admin/queue');
    html=`<section class="panel"><a href="#admin-users">账号管理 · 查看所有账号 →</a> <a href="#admin-categories">分类维护 →</a></section>`+heading('人工审核工作台','请在线下核验身份后审核。审核操作在服务端验证管理员权限。')+`<section class="panel"><h2>身份审核</h2>${q.certifications.map(c=>`<div class="notice"><b>${e(c.real_name)} · ${e(c.student_no)}</b><p>${e(c.username)}</p><button data-review="certifications:${c.id}:approve">已线下核验，通过</button> <button data-review="certifications:${c.id}:reject">驳回</button></div>`).join('')||'暂无待审申请'}</section><section class="panel"><h2>商品审核</h2>${q.products.map(p=>`<div class="notice"><h3>${e(p.title)}</h3><p>${e(p.description)}</p>${p.images.map(url=>`<img src="${url}" alt="审核图片" class="review-image" loading="lazy">`).join('')}<p>${label(p.trade_type)} · ${money(p.price)}</p><button data-review="products:${p.id}:approve">通过</button> <button data-review="products:${p.id}:reject">驳回</button></div>`).join('')||'暂无待审商品'}</section>`
  }
  if(page==='admin-categories'){
    if(user.role!=='admin')throw Error('需要管理员权限');
    const {categories}=await api('/admin/categories');
    html=heading('分类维护','单级分类。停用后旧商品仍保留原分类名，只是发布和编辑时不能再选。')+`<section class="panel"><a href="#admin">返回管理工作台</a></section><section class="panel"><h2>新增分类</h2><form id="categoryform"><div class="field"><label for="categoryName">分类名称</label><input id="categoryName" name="name" maxlength="20" required placeholder="如：书籍教材"></div><div class="field"><label for="categorySort">排序值（小的排前面）</label><input id="categorySort" name="sort" type="number" value="0" min="0" max="9999"></div><button type="submit">新增分类</button></form></section><section class="panel"><h2>全部分类</h2>${categories.map(c=>`<article class="notice"><div class="row"><h3>${e(c.name)}</h3><span class="badge">${c.status==='active'?'启用中':'已停用'}</span></div><p class="muted">排序 ${c.sort} · 关联商品 ${c.product_count} 件${c.disabled_at?' · 停用于 '+new Date(c.disabled_at).toLocaleString():''}</p><button data-cat="rename:${c.id}">重命名</button> <button data-cat="${c.status==='active'?'disable':'enable'}:${c.id}">${c.status==='active'?'停用':'启用'}</button></article>`).join('')||'<p>还没有分类，先新增一个。</p>'}</section>`;
  }
  return html;
}

export async function saveCategory({$,api,toast,render}) {
  const name=$('#categoryName').value.trim();
  const sort=Number($('#categorySort').value||0);
  if(!name)throw Error('请填写分类名称');
  await api('/admin/categories','POST',{name,sort});
  toast('分类已新增');
  return render();
}

export async function categoryAction(spec, {api, toast, render}) {
  const [action,id]=spec.split(':');
  if(action==='rename'){
    const name=prompt('新的分类名称（1～20 个字符）');
    if(!name)return;
    await api('/admin/categories/'+id,'PATCH',{name});
    toast('已重命名');
    return render();
  }
  await api('/admin/categories/'+id,'PATCH',{status:action==='disable'?'disabled':'active'});
  toast(action==='disable'?'已停用，旧商品不受影响':'已启用');
  return render();
}

export async function reviewItem(review, {api, toast, render}) {
  const [kind,id,action]=review.split(':');
  const reason=action==='reject'?prompt('驳回理由'):'';
  if(action==='reject'&&!reason)return;
  if(kind==='certifications'&&action==='approve'&&!confirm('确认你已在线下核验该学生的姓名、学号及在读身份？'))return;
  await api(`/admin/${kind}/${id}`,'POST',{
    action,reason,offlineVerified:kind==='certifications'&&action==='approve'
  }
  );
  toast('审核已保存');
  return render()
}

export function filterAccounts(target, $) {
  const query=target.value.trim().toLowerCase();let visible=0;
  document.querySelectorAll('[data-account-name]').forEach(row=>{row.hidden=!row.dataset.accountName.includes(query);if(!row.hidden)visible++;});
  $('#accountSearchEmpty').hidden=visible>0;
}

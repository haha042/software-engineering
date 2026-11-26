export async function renderAdminPage({page, user, api, e, heading, emptyState, label, money}) {
  let html = '';
  if(page==='admin-audit'){
    const qs=new URLSearchParams({limit:'50'});
    if(auditFilter.action)qs.set('action',auditFilter.action);
    if(auditFilter.actor)qs.set('actor',auditFilter.actor);
    const rows=await api('/admin/audit?'+qs.toString());
    html=heading('审计留痕','只读记录：管理员的操作与关键查询都会写在这里，不可删除。')+`<section class="panel"><a href="#admin">返回管理工作台</a><form id="auditfilter" class="filters"><div class="field"><label for="auditAction">动作</label><input id="auditAction" name="action" value="${e(auditFilter.action)}" placeholder="如 ban_account"></div><div class="field"><label for="auditActor">操作人</label><input id="auditActor" name="actor" value="${e(auditFilter.actor)}" placeholder="用户名"></div><button type="submit">查询</button> <button type="button" data-audit-reset>清空条件</button></form>${rows.length?`<table class="table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${e(r.actor||'系统')}</td><td>${e(r.action)}</td><td>${e(String(r.target??''))}</td><td>${e(r.detail||'')}</td></tr>`).join('')}</tbody></table>`:'<p>没有匹配的审计记录。</p>'}</section>`;
  }
  if(page==='admin-users'){
    const {users}=await api('/admin/users');
    html=heading('账号管理',`共 ${users.length} 个账号，包含管理员和未认证学生。`)+`<section class="panel"><a href="#admin">返回管理工作台</a><div class="field"><label for="accountSearch">搜索用户名或昵称</label><input id="accountSearch" type="search" placeholder="输入用户名或昵称"></div><div id="accountList">${users.map(u=>`<article class="notice" data-account-name="${e((u.username+' '+u.nickname).toLowerCase())}"><div class="row"><h2>${e(u.nickname||u.username)}</h2><a href="#admin-users/${u.id}">查看账号详情</a></div><p>账号 #${u.id} · ${e(u.username)} · ${u.role==='admin'?'管理员':'学生'} · ${u.certified?'已认证':label(u.certification_status||'未申请认证')}</p><p class="muted">注册于 ${new Date(u.created_at).toLocaleString()} · 发布 ${u.product_count} 件 · 订单 ${u.order_count} 笔</p></article>`).join('')}</div><p id="accountSearchEmpty" hidden role="status">没有匹配的账号。</p></section>`;
  }
  if(/^admin-users\/\d+$/.test(page)){
    const {account:a,certifications,counts}=await api('/admin/users/'+Number(page.split('/')[1]));
    html=heading('账号详情',a.username)+`<section class="panel"><a href="#admin-users">返回账号列表</a><h2>基本资料</h2>${a.avatar?`<img class="avatar avatar-large" src="${e(a.avatar)}" alt="${e(a.username)}的头像">`:' <p>尚未设置头像</p>'}<dl><dt>账号编号</dt><dd>${a.id}</dd><dt>用户名</dt><dd>${e(a.username)}</dd><dt>昵称</dt><dd>${e(a.nickname||'未填写')}</dd><dt>简介</dt><dd>${e(a.bio||'未填写')}</dd><dt>角色</dt><dd>${a.role==='admin'?'管理员':'学生'}</dd><dt>校园认证</dt><dd>${a.certified?'已认证':'未认证'}</dd><dt>注册时间</dt><dd>${new Date(a.created_at).toLocaleString()}</dd><dt>登录状态</dt><dd>${a.locked_until>Date.now()?'登录锁定至 '+new Date(a.locked_until).toLocaleString():'未锁定'} · 连续失败 ${a.failed_attempts} 次</dd><dt>密码</dt><dd>已设置</dd><dt>业务记录</dt><dd>发布 ${counts.products} 件 · 订单 ${counts.orders} 笔</dd></dl><p class="muted">手机号、邮箱尚未采集。当前页面提供信息查看。</p></section><section class="panel"><h2>认证申请历史</h2>${certifications.map(c=>`<article class="notice"><h3>${e(c.real_name)} · ${e(c.student_no)}</h3><p>${label(c.status)} · 申请于 ${new Date(c.created_at).toLocaleString()}</p><p>审核人：${e(c.reviewer_name||'尚未审核')} ${c.reviewed_at?' · '+new Date(c.reviewed_at).toLocaleString():''}</p>${c.reason?`<p>审核理由：${e(c.reason)}</p>`:''}</article>`).join('')||'<p>暂无认证申请。</p>'}</section><section class="panel"><h2>权限与账号恢复</h2><p class="muted">授权变更立即生效；撤销与恢复都需要填写原因，操作会写入审计留痕。</p>${a.role==='admin'?`<button data-grant="${a.id}:revoke">撤销管理员权限</button>`:`<button data-grant="${a.id}:grant">设为管理员</button>`} ${a.locked_until>Date.now()?`<button data-unlock="${a.id}">解除登录锁定</button>`:'<span class="muted">当前未处于登录锁定状态。</span>'}</section>`;
  }
  if(page==='admin'){
    if(user.role!=='admin')throw Error('需要管理员权限');
    const q=await api('/admin/queue');
    html=`<section class="panel"><a href="#admin-users">账号管理 · 查看所有账号 →</a> · <a href="#admin-audit">审计留痕 · 只读记录 →</a></section>`+heading('人工审核工作台','请在线下核验身份后审核。审核操作在服务端验证管理员权限。')+`<section class="panel"><h2>身份审核</h2>${q.certifications.map(c=>`<div class="notice"><b>${e(c.real_name)} · ${e(c.student_no)}</b><p>${e(c.username)}</p><button data-review="certifications:${c.id}:approve">已线下核验，通过</button> <button data-review="certifications:${c.id}:reject">驳回</button></div>`).join('')||'暂无待审申请'}</section><section class="panel"><h2>商品审核</h2>${q.products.map(p=>`<div class="notice"><h3>${e(p.title)}</h3><p>${e(p.description)}</p>${p.images.map(url=>`<img src="${url}" alt="审核图片" class="review-image" loading="lazy">`).join('')}<p>${label(p.trade_type)} · ${money(p.price)}</p><button data-review="products:${p.id}:approve">通过</button> <button data-review="products:${p.id}:reject">驳回</button></div>`).join('')||'暂无待审商品'}</section>`
  }
  return html;
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

// A08：管理员授权、账号恢复与审计查询的前端入口。
const auditFilter={action:'',actor:''};

export async function grantAction(target,{api,toast,render}){
  const [id,action]=target.split(':');
  const asking=action==='grant'?'授权备注（可留空）':'撤销原因（可留空）';
  const note=prompt(asking);
  if(note===null)return;
  if(action==='revoke'&&!confirm('确认撤销该账号的管理员权限？撤销后对方立即失去后台权限。'))return;
  await api(`/admin/users/${id}/grant`,'POST',{action,note});
  toast(action==='grant'?'已授予管理员权限':'已撤销管理员权限');
  return render();
}

export async function unlockAccount(id,{api,toast,render}){
  const reason=prompt('恢复原因（至少 5 个字，会写入审计留痕）');
  if(!reason)return;
  await api(`/admin/users/${id}/restore`,'POST',{reason});
  toast('账号已恢复，可以重新登录');
  return render();
}

export async function applyAuditFilter({api,toast,render}){
  auditFilter.action=(document.getElementById('auditAction')?.value||'').trim();
  auditFilter.actor=(document.getElementById('auditActor')?.value||'').trim();
  await render();
}

export async function resetAuditFilter({api,toast,render}){
  auditFilter.action='';
  auditFilter.actor='';
  await render();
}
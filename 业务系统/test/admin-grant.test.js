import test from 'node:test';import assert from 'node:assert/strict';import {createApp} from '../src/app.js';
test('管理员授权、撤销、账号恢复与审计查询',async t=>{
 let time=Date.now();const app=createApp({database:':memory:',adminPassword:'AdminPassword123!',clock:()=>time});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+app.server.address().port;
 const client=()=>({cookie:'',csrf:''});async function req(c,path,method='GET',body,expected=200){const r=await fetch(base+'/api'+path,{method,headers:{cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))c.cookie=r.headers.get('set-cookie').split(';')[0];const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));if(b.csrf)c.csrf=b.csrf;return b}

 const admin=client(),alice=client(),bobby=client();await req(admin,'/login','POST',{username:'admin',password:'AdminPassword123!'});
 for(const [name,c] of [['alice',alice],['bobby',bobby]]){await req(c,'/register','POST',{username:name,password:'Password123'},201);await req(c,'/login','POST',{username:name,password:'Password123'});}
 const aliceId=(await req(alice,'/me')).user.id,bobbyId=(await req(bobby,'/me')).user.id;

 // 普通用户不能授权、不能恢复、不能查审计。
 await req(alice,'/admin/users/'+bobbyId+'/grant','POST',{action:'grant'},403);
 await req(alice,'/admin/users/'+bobbyId+'/restore','POST',{reason:'普通用户尝试恢复账号'},403);
 await req(alice,'/admin/audit','GET',undefined,403);

 // 授权后立即生效：被授权账号能访问管理接口。
 assert.equal((await req(alice,'/admin/users/'+bobbyId+'/grant','POST',{action:'grant',note:'协助处理举报'},403)).error,'需要管理员权限');
 const granted=await req(admin,'/admin/users/'+aliceId+'/grant','POST',{action:'grant',note:'协助处理举报'});
 assert.equal(granted.role,'admin');
 await req(alice,'/admin/users','GET');
 await req(alice,'/admin/users/'+aliceId+'/grant','POST',{action:'grant'},409);

 // 稳定限制：不能撤销自己、不能撤销最后一名管理员、动作与备注长度受控。
 await req(alice,'/admin/users/'+aliceId+'/grant','POST',{action:'revoke'},409);
 await req(admin,'/admin/users/'+aliceId+'/grant','POST',{action:'revoke'});
 await req(admin,'/admin/users/'+aliceId+'/grant','POST',{action:'revoke'},409);
 await req(admin,'/admin/users/'+bobbyId+'/grant','POST',{action:'promote'},400);
 await req(admin,'/admin/users/'+bobbyId+'/grant','POST',{action:'grant',note:'字'.repeat(201)},400);
 await req(admin,'/admin/users/999999/grant','POST',{action:'grant'},404);
 // 撤销后立即失去权限。
 await req(admin,'/admin/users/'+bobbyId+'/grant','POST',{action:'grant'});
 await req(admin,'/admin/users/'+bobbyId+'/grant','POST',{action:'revoke'});
 await req(bobby,'/admin/users','GET',undefined,403);

 // 连续登录失败被锁 → 管理员恢复后可重新登录，且恢复需要依据。
 for(let i=0;i<5;i++)await req(bobby,'/login','POST',{username:'bobby',password:'WrongPassword'},401);
 await req(bobby,'/login','POST',{username:'bobby',password:'Password123'},429);
 await req(admin,'/admin/users/'+bobbyId+'/restore','POST',{reason:'短'},400);
 await req(admin,'/admin/users/999999/restore','POST',{reason:'账号不存在也要拒绝'},404);
 const restored=await req(admin,'/admin/users/'+bobbyId+'/restore','POST',{reason:'用户来电核实身份后解除锁定'});
 assert.equal(restored.locked,false);
 await req(bobby,'/login','POST',{username:'bobby',password:'Password123'});
 assert.ok((await req(bobby,'/notifications')).some(n=>n.message.includes('账号已恢复')));

 // 审计查询：分页上限、按动作与操作人过滤、读取本身也留痕。
 await req(admin,'/admin/audit?limit=500','GET',undefined,400);
 await req(admin,'/admin/audit?limit=abc','GET',undefined,400);
 const all=await req(admin,'/admin/audit?limit=200');
 assert.ok(all.length>=4);assert.ok(all.some(r=>r.action==='grant_admin'));assert.ok(all.some(r=>r.action==='restore_account'));
 const onlyGrant=await req(admin,'/admin/audit?action=grant_admin');
 assert.ok(onlyGrant.length>=2);assert.ok(onlyGrant.every(r=>r.action==='grant_admin'));
 const byActor=await req(admin,'/admin/audit?actor=admin&limit=20');
 assert.ok(byActor.every(r=>r.actor==='admin'));
 assert.ok((await req(admin,'/admin/audit?action=none_such')).length===0);
 const readAudit=await req(admin,'/admin/audit?limit=5');
 assert.ok(readAudit.some(r=>r.action==='read_audit'),'审计查询本身要留痕');
});

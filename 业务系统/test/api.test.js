import test from 'node:test';import assert from 'node:assert/strict';import {createApp} from '../src/app.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('HTTP业务闭环、权限、认证唯一性、锁定、取消及超时',async t=>{let time=Date.now();const app=createApp({database:':memory:',adminPassword:'AdminPassword123!',clock:()=>time});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+app.server.address().port;
 const client=()=>({cookie:'',csrf:''});async function req(c,path,method='GET',body,expected=200){const r=await fetch(base+'/api'+path,{method,headers:{cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))c.cookie=r.headers.get('set-cookie').split(';')[0];const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));if(b.csrf)c.csrf=b.csrf;return b}
 const admin=client(),seller=client(),buyer=client(),third=client();await req(admin,'/login','POST',{username:'admin',password:'AdminPassword123!'});
 const categoryId=(await req(admin,'/admin/categories','POST',{name:'生活用品'},201)).id;
 for(const [name,c] of [['seller',seller],['buyer',buyer],['third',third]]){await req(c,'/register','POST',{username:name,password:'Password123'},201);await req(c,'/login','POST',{username:name,password:'Password123'});}
 await req(client(),'/profile/avatar','GET',undefined,401);
 await req(buyer,'/profile/avatar','PUT',{avatar:png});
 assert.ok((await req(buyer,'/me')).user.avatarVersion);
 const avatarResponse=await fetch(base+'/api/profile/avatar',{headers:{cookie:buyer.cookie}});
 assert.equal(avatarResponse.status,200);assert.equal(avatarResponse.headers.get('content-type'),'image/png');
 assert.deepEqual(Buffer.from(await avatarResponse.arrayBuffer()),Buffer.from(png.split(',')[1],'base64'));
 await req(seller,'/profile/avatar','GET',undefined,404);
 await req(buyer,'/profile/avatar','PUT',{avatar:'data:image/svg+xml;base64,PHN2Zz4='},400);
 await req(buyer,'/profile/avatar','PUT',{avatar:'x'.repeat(2800001)},400);
 const avatarBad=client();avatarBad.cookie=buyer.cookie;await req(avatarBad,'/profile/avatar','PUT',{avatar:''},403);
 assert.ok((await req(buyer,'/me')).user.avatarVersion);
 await req(buyer,'/profile/avatar','PUT',{avatar:''});assert.equal((await req(buyer,'/me')).user.avatarVersion,null);
 await req(buyer,'/profile/avatar','GET',undefined,404);
 await req(buyer,'/profile','PUT',{nickname:'一起保存',bio:'简介与头像',avatar:png});
 assert.equal((await req(buyer,'/profile')).nickname,'一起保存');assert.ok((await req(buyer,'/me')).user.avatarVersion);
 await req(buyer,'/profile','PUT',{nickname:'不能部分保存',bio:'无效头像',avatar:'invalid'},400);
 assert.equal((await req(buyer,'/profile')).nickname,'一起保存');assert.ok((await req(buyer,'/me')).user.avatarVersion);
 await req(buyer,'/profile','PUT',{nickname:'只改文字',bio:''});assert.ok((await req(buyer,'/me')).user.avatarVersion);
 await req(buyer,'/profile','PUT',{nickname:'恢复默认',bio:'',avatar:''});assert.equal((await req(buyer,'/me')).user.avatarVersion,null);
 await req(client(),'/profile','GET',undefined,401);
 await req(buyer,'/profile','PUT',{nickname:'校园买家',bio:'喜欢读书'});
 assert.equal((await req(buyer,'/profile')).nickname,'校园买家');
 assert.equal((await req(seller,'/profile')).nickname,'');
 await req(buyer,'/profile','PUT',{nickname:'伪造',bio:'',certified:1,role:'admin'},400);
 await req(buyer,'/profile','PUT',{nickname:'长'.repeat(41),bio:''},400);
 const noCsrf=client();noCsrf.cookie=buyer.cookie;
 await req(noCsrf,'/profile','PUT',{nickname:'非法修改',bio:''},403);
 assert.equal((await req(buyer,'/profile')).certified,0);
 assert.equal((await req(buyer,'/profile')).nickname,'校园买家');
 await req(buyer,'/products','POST',{},403);await req(buyer,'/admin/queue','GET',undefined,403);
 // 同一学号在尚未通过认证时可进入人工核验；审核时仍须阻止重复绑定。
 const pendingThird=await req(third,'/certifications','POST',{realName:'测试学生',studentNo:'S002'},201);
 for(const [c,no] of [[seller,'S001'],[buyer,'S002']]){const cert=await req(c,'/certifications','POST',{realName:'测试学生',studentNo:no},201);await req(admin,'/admin/certifications/'+cert.id,'POST',{action:'approve',offlineVerified:true});}
 await req(admin,'/admin/certifications/'+pendingThird.id,'POST',{action:'approve',offlineVerified:true},409);
 // 新申请立即被拦截，学号前后空格不能绕过校验，且不产生待审记录。
 const duplicate=client();await req(duplicate,'/register','POST',{username:'duplicate',password:'Password123'},201);await req(duplicate,'/login','POST',{username:'duplicate',password:'Password123'});
 for(const studentNo of ['S002',' S002 ']){const error=await req(duplicate,'/certifications','POST',{realName:'测试学生',studentNo},409);assert.equal(error.error,'该学号已完成认证，无法重复申请');}
 assert.deepEqual(await req(duplicate,'/certifications'),[]);
 assert.equal((await req(admin,'/admin/queue')).certifications.length,1);
 const validCert=await req(duplicate,'/certifications','POST',{realName:'测试学生',studentNo:'S004'},201);assert.ok(validCert.id);
 await req(duplicate,'/certifications','POST',{realName:'测试学生',studentNo:'S005'},409);
 for(const deliveryLocation of [undefined,'   ','地'.repeat(201)]){await req(seller,'/products','POST',{title:'无效地点测试',categoryId,condition:'九成新',description:'功能正常',tradeType:'sale',price:50,deliveryLocation,images:[png]},400);}
 const prod=async()=>{const p=await req(seller,'/products','POST',{title:'测试台灯',categoryId,condition:'九成新',description:'功能正常',tradeType:'sale',price:50,deliveryLocation:'北校区图书馆正门',images:[png]},201);await req(admin,'/admin/products/'+p.id,'POST',{action:'approve'});return p.id};
 const pid=await prod();assert.equal((await req(buyer,'/products/'+pid)).delivery_location,'北校区图书馆正门');await req(seller,'/orders','POST',{productId:pid,requestKey:'self-request'},403);const [r1,r2]=await Promise.all([req(buyer,'/orders','POST',{productId:pid,requestKey:'request-001'},201),req(buyer,'/orders','POST',{productId:pid,requestKey:'request-001'},201)]);assert.equal(r1.id,r2.id);await req(buyer,'/orders','POST',{productId:pid,requestKey:'request-002'},409);const id=r1.id;assert.equal((await req(buyer,'/orders'))[0].snapshot.delivery_location,'北校区图书馆正门');
 await req(third,'/orders/'+id+'/action','POST',{action:'accept'},403);await req(seller,'/orders/'+id+'/action','POST',{action:'accept'});await req(buyer,'/orders/'+id+'/action','POST',{action:'request_cancel',reason:'时间不合适'});await req(buyer,'/orders/'+id+'/action','POST',{action:'agree_cancel'},409);await req(seller,'/orders/'+id+'/action','POST',{action:'deliver',location:'校门',note:'交付',occurredAt:time},409);await req(buyer,'/orders/'+id+'/action','POST',{action:'withdraw_cancel'});await req(seller,'/orders/'+id+'/action','POST',{action:'deliver',location:'校门',note:'已交付',occurredAt:time});await req(buyer,'/orders/'+id+'/action','POST',{action:'confirm'});let os=await req(buyer,'/orders');assert.equal(os[0].status,'confirmation');await req(seller,'/orders/'+id+'/action','POST',{action:'confirm'});os=await req(buyer,'/orders');assert.equal(os[0].status,'completed');await req(buyer,'/orders/'+id+'/action','POST',{action:'confirm'},409);
 const p2=await prod();const o2=await req(buyer,'/orders','POST',{productId:p2,requestKey:'request-003'},201);time+=172800000;await req(seller,'/login','POST',{username:'seller',password:'Password123'});await req(buyer,'/login','POST',{username:'buyer',password:'Password123'});await req(seller,'/orders/'+o2.id+'/action','POST',{action:'accept'},409);app.expire();os=await req(buyer,'/orders');assert.equal(os.find(o=>o.id===o2.id).status,'closed');assert.equal((await req(buyer,'/products/'+p2)).status,'live');
 const bad=client();bad.cookie=buyer.cookie;await req(bad,'/orders','POST',{productId:p2,requestKey:'csrf-request'},403);
});

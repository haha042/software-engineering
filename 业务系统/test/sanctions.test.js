import test from 'node:test';import assert from 'node:assert/strict';import {createApp} from '../src/app.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const DAY=24*60*60*1000;
test('账号处置：7 天限制、30 天封禁、到期恢复与存量履约',async t=>{
 let time=Date.now();const app=createApp({database:':memory:',adminPassword:'AdminPassword123!',clock:()=>time});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+app.server.address().port;
 const client=()=>({cookie:'',csrf:''});async function req(c,path,method='GET',body,expected=200){const r=await fetch(base+'/api'+path,{method,headers:{cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))c.cookie=r.headers.get('set-cookie').split(';')[0];const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));if(b.csrf)c.csrf=b.csrf;return b}

 const admin=client(),seller=client(),buyer=client();await req(admin,'/login','POST',{username:'admin',password:'AdminPassword123!'});
 for(const [name,c,n] of [['seller',seller,'SA01'],['buyer',buyer,'SA02']]){await req(c,'/register','POST',{username:name,password:'Password123'},201);await req(c,'/login','POST',{username:name,password:'Password123'});const cert=await req(c,'/certifications','POST',{realName:'测试学生',studentNo:n},201);await req(admin,'/admin/certifications/'+cert.id,'POST',{action:'approve',offlineVerified:true});}
 const sellerId=(await req(seller,'/me')).user.id,buyerId=(await req(buyer,'/me')).user.id;
 const product=await req(seller,'/products','POST',{title:'测试自行车',category:'生活用品',condition:'八成新',description:'用于处置测试的商品',tradeType:'sale',price:200,deliveryLocation:'北校区图书馆正门',images:[png]},201);await req(admin,'/admin/products/'+product.id,'POST',{action:'approve'});
 const order=await req(buyer,'/orders','POST',{productId:product.id,requestKey:'sanction-test-01'},201);

 // 普通用户不能处置，也不能看处置列表。
 await req(buyer,'/admin/users/'+sellerId+'/sanction','POST',{action:'limit',reason:'普通用户尝试处置账号'},403);
 await req(buyer,'/admin/sanctions','GET',undefined,403);
 await req(admin,'/admin/users/'+sellerId+'/sanction','POST',{action:'freeze',reason:'动作非法应被拒绝'},400);
 await req(admin,'/admin/users/'+sellerId+'/sanction','POST',{action:'limit',reason:'短'},400);
 await req(admin,'/admin/users/999999/sanction','POST',{action:'limit',reason:'账号不存在应拒绝'},404);
 const adminId=(await req(admin,'/me')).user.id;
 await req(admin,'/admin/users/'+adminId+'/sanction','POST',{action:'limit',reason:'不能处置管理员账号'},409);

 // 7 天限制：不能发布、不能下单，但可以继续履行存量订单。
 const limited=await req(admin,'/admin/users/'+sellerId+'/sanction','POST',{action:'limit',reason:'商品描述与实物不符，多次被举报'});
 assert.equal(limited.state,'limited');assert.equal(limited.until,time+7*DAY);
 await req(seller,'/products','POST',{title:'限制期不能发布',category:'生活用品',condition:'九成新',description:'限制期发布应被拒绝',tradeType:'sale',price:10,deliveryLocation:'北校区图书馆正门',images:[png]},403);
 await req(admin,'/admin/users/'+buyerId+'/sanction','POST',{action:'limit',reason:'买家被限制用于验证下单'});
 await req(buyer,'/orders','POST',{productId:product.id,requestKey:'sanction-test-02'},403);
 // 限制中的卖家仍可接单，限制中的买家仍可取消：存量履约不受影响。
 await req(seller,'/orders/'+order.id+'/action','POST',{action:'accept'});
 await req(buyer,'/orders/'+order.id+'/action','POST',{action:'request_cancel',reason:'临时有事不想要了'});
 const list=await req(admin,'/admin/sanctions');
 assert.equal(list.length,2);assert.ok(list.every(u=>u.state==='limited'));
 await req(admin,'/admin/users/'+buyerId+'/sanction','POST',{action:'limit',reason:'重复限制应被拒绝'},409);

 // 到期惰性恢复：8 天后自动回到 normal，可以再次发布/下单。
 time+=8*DAY;
 await req(admin,'/login','POST',{username:'admin',password:'AdminPassword123!'});
 await req(seller,'/login','POST',{username:'seller',password:'Password123'});
 await req(buyer,'/login','POST',{username:'buyer',password:'Password123'});
 await req(seller,'/products','POST',{title:'恢复后可以发布',category:'生活用品',condition:'九成新',description:'限制到期后恢复发布权限',tradeType:'sale',price:10,deliveryLocation:'北校区图书馆正门',images:[png]},201);
 assert.equal((await req(admin,'/admin/sanctions')).length,0);

 // 30 天封禁：立即踢下线、拒绝登录，到期后恢复。
 const banned=await req(admin,'/admin/users/'+buyerId+'/sanction','POST',{action:'ban',reason:'发布虚假信息并辱骂他人'});
 assert.equal(banned.state,'banned');assert.equal(banned.until,time+30*DAY);
 assert.equal((await req(buyer,'/me','GET')).user,null);
 await req(buyer,'/login','POST',{username:'buyer',password:'Password123'},403);
 await req(admin,'/admin/users/'+buyerId+'/sanction','POST',{action:'ban',reason:'重复封禁应被拒绝'},409);
 time+=30*DAY+1000;
 await req(admin,'/login','POST',{username:'admin',password:'AdminPassword123!'});
 await req(buyer,'/login','POST',{username:'buyer',password:'Password123'});
 await req(buyer,'/orders');

 // 解除与留痕。
 await req(admin,'/admin/users/'+sellerId+'/sanction','POST',{action:'limit',reason:'再次限制用于验证解除'});
 const lifted=await req(admin,'/admin/users/'+sellerId+'/sanction','POST',{action:'lift',reason:'申诉复核通过，提前解除'});
 assert.equal(lifted.state,'normal');
 const audit=await req(admin,'/admin/audit?limit=200');
 for(const action of ['limit_account','ban_account','lift_sanction'])assert.ok(audit.some(r=>r.action===action),action);
 assert.ok((await req(buyer,'/notifications')).some(n=>n.message.includes('封禁')));
});

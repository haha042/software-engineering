import test from 'node:test';import assert from 'node:assert/strict';import {createApp} from '../src/app.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('异常订单处置：违规下架、暂停恢复与终止释放',async t=>{
 let time=Date.now();const app=createApp({database:':memory:',adminPassword:'AdminPassword123!',clock:()=>time});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+app.server.address().port;
 const client=()=>({cookie:'',csrf:''});async function req(c,path,method='GET',body,expected=200){const r=await fetch(base+'/api'+path,{method,headers:{cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))c.cookie=r.headers.get('set-cookie').split(';')[0];const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));if(b.csrf)c.csrf=b.csrf;return b}

 const admin=client(),seller=client(),buyer=client();
 await req(admin,'/login','POST',{username:'admin',password:'AdminPassword123!'});
 for(const [name,c,n] of [['modseller',seller,'MD01'],['modbuyer',buyer,'MD02']]){
  await req(c,'/register','POST',{username:name,password:'Password123'},201);
  await req(c,'/login','POST',{username:name,password:'Password123'});
  const cert=await req(c,'/certifications','POST',{realName:'测试学生',studentNo:n},201);
  await req(admin,'/admin/certifications/'+cert.id,'POST',{action:'approve',offlineVerified:true});
 }
 const sellerId=(await req(seller,'/me')).user.id,buyerId=(await req(buyer,'/me')).user.id;
 const categoryId=(await req(admin,'/admin/categories','POST',{name:'运动器材'},201)).id;
 const product=(await req(seller,'/products','POST',{title:'测试帐篷',categoryId,condition:'八成新',description:'用于异常订单处置测试的商品',tradeType:'sale',price:120,deliveryLocation:'北校区图书馆正门',images:[png]},201));
 await req(admin,'/admin/products/'+product.id,'POST',{action:'approve'});
 const order=await req(buyer,'/orders','POST',{productId:product.id,productVersion:1,requestKey:'moderation-test-01'},201);

 // 权限与参数
 await req(buyer,'/admin/moderation','GET',undefined,403);
 await req(buyer,'/admin/orders/'+order.id+'/control','POST',{action:'pause',reason:'普通用户尝试暂停订单'},403);
 await req(admin,'/admin/products/999999/violation','POST',{reason:'不存在的商品应被拒绝'},404);
 await req(admin,'/admin/orders/'+order.id+'/control','POST',{action:'freeze',reason:'动作非法应被拒绝'},400);
 await req(admin,'/admin/orders/'+order.id+'/control','POST',{action:'pause',reason:'短'},400);

 // 违规下架：商品终态 + 进行中订单同步暂停 + 双方通知
 const takedown=await req(admin,'/admin/products/'+product.id+'/violation','POST',{reason:'描述与实际物品严重不符，多次被举报'});
 assert.equal(takedown.status,'violation');assert.equal(takedown.pausedOrders,1);
 await req(admin,'/admin/products/'+product.id+'/violation','POST',{reason:'重复下架应被拒绝'},409);
 const hidden=await req(admin,'/products/'+product.id);
 assert.equal(hidden.status,'violation');
 const board=await req(admin,'/admin/moderation');
 assert.equal(board.orders.length,1);assert.equal(board.orders[0].paused_stage,'pending');
 assert.equal(board.products.length,1);assert.equal(board.products[0].id,product.id);
 const sellerNotes=await req(seller,'/notifications');
 assert.ok(sellerNotes.some(n=>n.message.includes('因违规被下架')));
 const buyerNotes=await req(buyer,'/notifications');
 assert.ok(buyerNotes.some(n=>n.message.includes('暂停')));

 // 暂停期间参与者不能推进
 await req(seller,'/orders/'+order.id+'/action','POST',{action:'accept'},409);
 await req(admin,'/admin/orders/'+order.id+'/control','POST',{action:'pause',reason:'重复暂停应被拒绝'},409);

 // 违规下架为终态，卖家不能通过编辑重提，订单保持暂停。
 await req(seller,'/products/'+product.id,'PATCH',{title:'尝试改名重新送审'},409);
 await req(admin,'/admin/orders/'+order.id+'/control','POST',{action:'resume',reason:'违规下架订单不可恢复'},409);
 assert.equal((await req(admin,'/products/'+product.id)).status,'violation');
 assert.equal((await req(buyer,'/orders'))[0].paused,1);

 // 终止：订单关闭并写明原因，商品因为已是违规终态而不会被释放
 const terminated=await req(admin,'/admin/orders/'+order.id+'/control','POST',{action:'terminate',reason:'商品违规已下架，订单不再继续'});
 assert.equal(terminated.status,'closed');assert.equal(terminated.productStatus,'violation');
 await req(seller,'/orders/'+order.id+'/action','POST',{action:'deliver',occurredAt:time,location:'北校区图书馆',note:'尝试继续推进已终止的订单'},409);
 await req(admin,'/admin/orders/'+order.id+'/control','POST',{action:'pause',reason:'已结束的订单不能再处置'},409);

 // 非违规商品终止后回到在售（卖家已认证、配额未满）
 const second=await req(seller,'/products','POST',{title:'测试睡袋',categoryId,condition:'九成新',description:'用于终止释放的第二个商品',tradeType:'sale',price:80,deliveryLocation:'北校区图书馆正门',images:[png]},201);
 await req(admin,'/admin/products/'+second.id,'POST',{action:'approve'});
 const secondOrder=await req(buyer,'/orders','POST',{productId:second.id,productVersion:1,requestKey:'moderation-test-02'},201);
 await req(admin,'/admin/orders/'+secondOrder.id+'/control','POST',{action:'pause',reason:'买家反馈交货地点有争议，先暂停'});
 const resumed=await req(admin,'/admin/orders/'+secondOrder.id+'/control','POST',{action:'resume',reason:'核实后举报不成立，恢复正常流程'});
 assert.equal(resumed.paused,false);assert.equal(resumed.stage,'pending');
 assert.equal(resumed.deadline,time+48*60*60*1000);
 await req(seller,'/orders/'+secondOrder.id+'/action','POST',{action:'accept'});
 const closed=await req(admin,'/admin/orders/'+secondOrder.id+'/control','POST',{action:'terminate',reason:'双方协商一致，订单终止'});
 assert.equal(closed.productStatus,'live');
 assert.equal((await req(admin,'/products/'+second.id)).status,'live');

 // 留痕：三次处置都能在审计里按动作查到
 for(const action of ['pause_order','resume_order','terminate_order','read_moderation']){
  const rows=await req(admin,'/admin/audit?action='+action+'&limit=20');
  assert.ok(rows.length>=1,action+' 应有审计记录');
 }
});

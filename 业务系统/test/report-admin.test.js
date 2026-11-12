import test from 'node:test';import assert from 'node:assert/strict';import {createApp} from '../src/app.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('后台举报处置：权限、依据必填、结果通知与记录保留',async t=>{
 let time=Date.now();const app=createApp({database:':memory:',adminPassword:'AdminPassword123!',clock:()=>time});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+app.server.address().port;
 const client=()=>({cookie:'',csrf:''});async function req(c,path,method='GET',body,expected=200){const r=await fetch(base+'/api'+path,{method,headers:{cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))c.cookie=r.headers.get('set-cookie').split(';')[0];const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));if(b.csrf)c.csrf=b.csrf;return b}

 const admin=client(),seller=client(),reporter=client();await req(admin,'/login','POST',{username:'admin',password:'AdminPassword123!'});
 for(const [name,c] of [['seller',seller],['reporter',reporter]]){await req(c,'/register','POST',{username:name,password:'Password123'},201);await req(c,'/login','POST',{username:name,password:'Password123'});}
 const cert=await req(seller,'/certifications','POST',{realName:'测试卖家',studentNo:'AD01'},201);await req(admin,'/admin/certifications/'+cert.id,'POST',{action:'approve',offlineVerified:true});
 const product=await req(seller,'/products','POST',{title:'被举报商品',category:'生活用品',condition:'九成新',description:'用于后台处置测试',tradeType:'sale',price:30,deliveryLocation:'北校区图书馆正门',images:[png]},201);await req(admin,'/admin/products/'+product.id,'POST',{action:'approve'});
 const report=await req(reporter,'/reports','POST',{targetType:'product',targetId:product.id,reasonType:'虚假信息',reason:'图片与实物不符，实际是破损件',evidence:[{type:'text',content:'附聊天记录'}]},201);

 // 普通用户不能读队列、不能处置。
 await req(reporter,'/admin/reports','GET',undefined,403);
 await req(reporter,'/admin/reports/'+report.id,'POST',{action:'uphold',result:'恶意举报尝试'},403);

 // 管理端列表带举报人、对象与证据条数。
 const pending=await req(admin,'/admin/reports');
 assert.equal(pending.length,1);assert.equal(pending[0].id,report.id);assert.equal(pending[0].reporter,'reporter');assert.equal(pending[0].evidence_count,1);assert.equal(pending[0].target.user_id,(await req(seller,'/me')).user.id);
 await req(admin,'/admin/reports?status=unknown','GET',undefined,400);

 // 依据必填且长度受控。
 await req(admin,'/admin/reports/'+report.id,'POST',{action:'uphold'},400);
 await req(admin,'/admin/reports/'+report.id,'POST',{action:'uphold',result:'短'},400);
 await req(admin,'/admin/reports/'+report.id,'POST',{action:'settle',result:'动作受控'},400);
 await req(admin,'/admin/reports/999999','POST',{action:'uphold',result:'不存在应返回四零四'},404);

 // 处置成立：举报人收到结果通知，处置记录落库。
 const done=await req(admin,'/admin/reports/'+report.id,'POST',{action:'uphold',result:'图片与描述不符，已要求卖家整改',notifyTarget:true});
 assert.equal(done.status,'handled');
 const reporterNotices=await req(reporter,'/notifications');
 assert.ok(reporterNotices.some(n=>n.message.includes('举报结果：成立')));
 const sellerNotices=await req(seller,'/notifications');
 assert.ok(sellerNotices.some(n=>n.message.includes('经核实成立')));
 assert.ok(sellerNotices.every(n=>!n.message.includes('reporter')),'不应向被举报方透露举报人');

 // 已处置的举报不能再处置，也不能追加证据；记录仍在列表中。
 await req(admin,'/admin/reports/'+report.id,'POST',{action:'dismiss',result:'重复处置应被拒绝'},409);
 await req(reporter,'/reports/'+report.id+'/evidence','POST',{evidence:[{type:'text',content:'已处理后补充'}]},409);
 const handled=await req(admin,'/admin/reports?status=handled');
 assert.equal(handled.length,1);assert.equal(handled[0].result,'图片与描述不符，已要求卖家整改');
 assert.equal((await req(admin,'/admin/reports?status=pending')).length,0);
 const evidence=await req(reporter,'/reports/mine');
 assert.equal(evidence[0].status,'handled');

 // 举报人仍可看到自己的处置结果。
 assert.ok((await req(reporter,'/reports/mine'))[0].result.includes('整改'));
});

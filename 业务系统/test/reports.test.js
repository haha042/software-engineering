import test from 'node:test';import assert from 'node:assert/strict';import {createApp} from '../src/app.js';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
test('举报提交与追加证据：合并、越权与已处理约束',async t=>{
 let time=Date.now();const app=createApp({database:':memory:',adminPassword:'AdminPassword123!',clock:()=>time});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>app.server.close(r)));const base='http://127.0.0.1:'+app.server.address().port;
 const client=()=>({cookie:'',csrf:''});async function req(c,path,method='GET',body,expected=200){const r=await fetch(base+'/api'+path,{method,headers:{cookie:c.cookie,'x-csrf-token':c.csrf,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.headers.get('set-cookie'))c.cookie=r.headers.get('set-cookie').split(';')[0];const b=await r.json();assert.equal(r.status,expected,JSON.stringify(b));if(b.csrf)c.csrf=b.csrf;return b}

 const admin=client(),seller=client(),reporter=client(),other=client();await req(admin,'/login','POST',{username:'admin',password:'AdminPassword123!'});
 for(const [name,c] of [['seller',seller],['reporter',reporter],['other',other]]){await req(c,'/register','POST',{username:name,password:'Password123'},201);await req(c,'/login','POST',{username:name,password:'Password123'});}
 const cert=await req(seller,'/certifications','POST',{realName:'测试卖家',studentNo:'R001'},201);await req(admin,'/admin/certifications/'+cert.id,'POST',{action:'approve',offlineVerified:true});
 const created=await req(seller,'/products','POST',{title:'测试商品',category:'生活用品',condition:'九成新',description:'用于举报测试',tradeType:'sale',price:50,deliveryLocation:'北校区图书馆正门',images:[png]},201);await req(admin,'/admin/products/'+created.id,'POST',{action:'approve'});
 const sellerId=(await req(seller,'/me')).user.id,otherId=(await req(other,'/me')).user.id;

 // 未登录不能举报；未认证用户可以举报（只要求登录）。
 await req(client(),'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'虚假信息',reason:'描述与实物不符，图片是网图'},401);
 const first=await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'虚假信息',reason:'描述与实物不符，图片是网图',evidence:[{type:'text',content:'聊天记录截图见附件'},{type:'image',content:png}]},201);
 assert.equal(first.merged,false);assert.equal(first.status,'pending');assert.equal(first.evidenceCount,2);

 // 7 天内同人同对象同原因合并，并把新证据并入原举报。
 const merged=await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'虚假信息',reason:'再补充一点细节',evidence:[{type:'text',content:'又发现一处不符'}]},200);
 assert.equal(merged.id,first.id);assert.equal(merged.merged,true);assert.equal(merged.evidenceCount,3);

 // 换一个原因不合并。
 const otherReason=await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'欺诈',reason:'卖家要求先付定金再发货'},201);
 assert.notEqual(otherReason.id,first.id);

 // 空白与越权：不能举报自己、不能举报自己的商品、对象必须存在、原因类型受控。
 await req(reporter,'/reports','POST',{targetType:'user',targetId:(await req(reporter,'/me')).user.id,reasonType:'人身攻击',reason:'测试自举报应被拒绝'},400);
 await req(seller,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'虚假信息',reason:'举报自己的商品应被拒绝'},400);
 await req(seller,'/reports','POST',{targetType:'user',targetId:sellerId,reasonType:'人身攻击',reason:'举报自己应被拒绝'},400);
 await req(reporter,'/reports','POST',{targetType:'product',targetId:999999,reasonType:'虚假信息',reason:'对象不存在应返回四零四'},404);
 await req(reporter,'/reports','POST',{targetType:'order',targetId:created.id,reasonType:'虚假信息',reason:'对象类型受控'},400);
 await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'随便写',reason:'原因类型受控'},400);
 await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'虚假信息',reason:'短'},400);

 // 证据校验：类型、魔数、大小与条数。
 await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'其他',reason:'证据类型非法应被拒绝',evidence:[{type:'video',content:'x'}]},400);
 await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'其他',reason:'图片魔数不符应被拒绝',evidence:[{type:'image',content:'data:image/png;base64,PHN2Zz4='}]},400);
 await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'其他',reason:'图片过大应被拒绝',evidence:[{type:'image',content:'data:image/png;base64,'+'A'.repeat(2800000)}]},400);
 await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'其他',reason:'证据条数超限应被拒绝',evidence:Array.from({length:7},()=>({type:'text',content:'重复证据'}))},400);

 // 追加证据：仅本人、仅待处理。
 await req(other,'/reports/'+first.id+'/evidence','POST',{evidence:[{type:'text',content:'路人补充'}]},403);
 const appended=await req(reporter,'/reports/'+first.id+'/evidence','POST',{evidence:[{type:'text',content:'追加一条'}]},201);
 assert.equal(appended.evidenceCount,4);
 app.db.prepare("UPDATE reports SET status='handled',result='成立',handled_at=? WHERE id=?").run(time,first.id);
 await req(reporter,'/reports/'+first.id+'/evidence','POST',{evidence:[{type:'text',content:'已处理后再补充'}]},409);

 // 合并窗口之外重新建一条（时间前跳后会话已过期，需要重新登录）。
 time+=8*24*60*60*1000;
 await req(reporter,'/login','POST',{username:'reporter',password:'Password123'});
 const later=await req(reporter,'/reports','POST',{targetType:'product',targetId:created.id,reasonType:'虚假信息',reason:'过了合并窗口再次举报'},201);
 assert.equal(later.merged,false);assert.notEqual(later.id,first.id);

 // 只能看到自己的举报。
 await req(other,'/login','POST',{username:'other',password:'Password123'});
 const mine=await req(reporter,'/reports/mine');
 assert.equal(mine.length,3);
 assert.ok(mine.every(r=>r.reporter_id!==otherId));
 await req(other,'/reports/mine').then(rows=>assert.equal(rows.length,0));
 await req(client(),'/reports/mine','GET',undefined,401);
});

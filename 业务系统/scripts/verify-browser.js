import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../src/app.js';

const executable=process.argv[2];
if(!executable)throw Error('请传入 Chrome 可执行文件路径');
const {server,db}=createApp({database:':memory:',adminPassword:'DemoPassword123!'});
db.exec(`INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,status,created_at)
VALUES(1,'回归台灯','生活用品','九成新','演示数据','sale',1000,'live',0),
(1,'回归书本','书籍','九成新','演示数据','sale',1000,'live',0)`);
await new Promise((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r)});
const base='http://127.0.0.1:'+server.address().port;
const profile=await mkdtemp(join(tmpdir(),'campus-chrome-'));
const chrome=spawn(executable,[
'--headless','--remote-debugging-port=0','--user-data-dir='+profile,'--no-first-run','about:blank'],{stdio:'ignore'});
const exited=new Promise(resolve=>{chrome.once('exit',resolve);chrome.once('error',resolve);});
let ws;
try{
 let port;
 for(let i=0;i<120&&!port;i++){
   try{port=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]}catch{await delay(100)}
 }
 const debug='http://127.0.0.1:'+port;
 const version=await (await fetch(debug+'/json/version')).json();
 const [tab]=await (await fetch(debug+'/json/list')).json();
 ws=new WebSocket(tab.webSocketDebuggerUrl);
 await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j)});
 let id=0;
 const pending=new Map();
 ws.addEventListener('message',event=>{
   const m=JSON.parse(event.data);
   const pair=pending.get(m.id);
   if(pair){pending.delete(m.id);m.error?pair[1](new Error(m.error.message)):pair[0](m.result)}
 });
 const call=(method,params={})=>new Promise((r,j)=>{
   pending.set(++id,[r,j]);ws.send(JSON.stringify({id,method,params}));
 });
 const js=async expression=>{
   const {result,exceptionDetails}=await call('Runtime.evaluate',{expression,returnByValue:true});
   if(exceptionDetails)throw Error(JSON.stringify(exceptionDetails));
   return result.value;
 };
 async function until(expression){
   for(let i=0;i<80;i++){if(await js(expression))return;await delay(60)}
   throw Error(expression+' '+await js('document.body.innerText.slice(0,800)'));
 }
 const results=[];
 for(const [width,height,mobile] of [[1280,720,false],[1440,900,false],[390,844,true]]){
   await call('Network.clearBrowserCookies');
   await call('Emulation.setDeviceMetricsOverride',{width,height,mobile,deviceScaleFactor:1});
   await call('Page.navigate',{url:base+'/#market'});
   await until("document.querySelector('#filterform') && document.body.innerText.includes('回归台灯') && document.body.innerText.includes('回归书本')");
   await js("document.querySelector('#filterform').elements.q.value='回归台灯';document.querySelector('#filterform').requestSubmit()");
   await until("document.body.innerText.includes('回归台灯') && !document.querySelector('#app').innerText.includes('回归书本')");
   await js("location.hash='auth'");
   await until("document.querySelector('#authform')");
   await js("const form=document.querySelector('#authform');form.elements.username.value='admin';form.elements.password.value='DemoPassword123!';form.requestSubmit()");
   await until("document.querySelector('#account').innerText.includes('管理员')");
   await js("location.hash='publish'");
   await until("document.querySelector('#app').innerText.includes('使用已认证的学生账号发布物品')");
   await js("location.hash='admin'");
   await until("document.querySelector('a[href=\"#admin-statistics\"]')");
   await js("document.querySelector('a[href=\"#admin-statistics\"]').click()");
   await until("document.querySelector('a[href=\"#admin-statistics\"][aria-current=\"page\"]') && document.querySelectorAll('tbody tr').length===7");
   await js("document.querySelector('a[href=\"#admin-statistics/week\"]').click()");
   await until("document.querySelectorAll('tbody tr').length===4");
   assert.ok(await js('document.documentElement.scrollWidth <= innerWidth'));
   results.push({width,height,mobile,search:true,login:true,statisticsDayWeek:true,horizontalOverflow:false});
   await call('Page.navigate',{url:'about:blank'});
   await until("location.href==='about:blank'");
 }
 const adminHash=db.prepare("SELECT password_hash FROM users WHERE id=1").get().password_hash;
 const insertUser=db.prepare("INSERT INTO users(username,password_hash,certified,created_at) VALUES(?,?,1,?)");
 const seller=Number(insertUser.run('browserseller',adminHash,Date.now()).lastInsertRowid);
 const buyer=Number(insertUser.run('browserbuyer',adminHash,Date.now()).lastInsertRowid);
 const insertProduct=db.prepare(`INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,status,created_at)
   VALUES(?,?,'生活用品','九成新','演示数据',?,?,'live',?)`);
 const sale=Number(insertProduct.run(seller,'版本回归商品','sale',1000,Date.now()).lastInsertRowid);
 const exchange=Number(insertProduct.run(seller,'交换回归商品','exchange',null,Date.now()).lastInsertRowid);
 const count=()=>db.prepare('SELECT count(*) n FROM orders WHERE buyer_id=?').get(buyer).n;
 await call('Network.clearBrowserCookies');
 await call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,mobile:false,deviceScaleFactor:1});
 await call('Page.navigate',{url:base+'/#auth'});
 await until("document.querySelector('#authform')");
 await js("const form=document.querySelector('#authform');form.elements.username.value='browserbuyer';form.elements.password.value='DemoPassword123!';form.requestSubmit()");
 await until("document.querySelector('#account').innerText.includes('browserbuyer')");
 await js("location.hash='publish'");
 await until("document.querySelector('#publishform') && document.querySelector('#draftId').value===''");
 await js(`location.hash='detail/${sale}'`);
 await until("document.querySelector('[data-product-version=\"1\"]')");
 db.prepare('UPDATE products SET price=2000,version=2 WHERE id=?').run(sale);
 await js("document.querySelector('[data-action=buy]').click()");
 await until("document.querySelector('[data-product-version=\"2\"]')");
 assert.equal(count(),0);
 await js("document.querySelector('[data-action=buy]').click()");
 await until("document.querySelector('[data-order-detail]')");
 assert.equal(count(),1);
 const recorded=db.prepare('SELECT snapshot FROM orders WHERE product_id=?').get(sale);
 assert.equal(JSON.parse(recorded.snapshot).price,2000);

 await js(`location.hash='detail/${exchange}'`);
 await until("document.querySelector('#offerform')");
 await js(`(() => {
   const originalSet=Storage.prototype.setItem;
   Storage.prototype.setItem=function(key,value){
     if(key.startsWith('campus.orderIntent.'))throw new DOMException('forced quota','QuotaExceededError');
     return originalSet.call(this,key,value);
   };
   const originalFetch=window.fetch;
   window.fetch=async (url,options)=>{
     const response=await originalFetch(url,options);
     if(url==='/api/orders'&&options?.method==='POST'&&response.ok)throw new TypeError('simulated lost response');
     return response;
   };
   document.querySelector('#offerTitle').value='交换教材';
   document.querySelector('#offerCondition').value='九成新';
   document.querySelector('#offerDescription').value='演示图片随原请求重试';
   const transfer=new DataTransfer();
   const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
   transfer.items.add(new File([png],'fixture.png',{type:'image/png'}));
   document.querySelector('#offerImages').files=transfer.files;
   const buy=document.querySelector('[data-action=buy]');
   buy.click();buy.click();
 })()`);
 await until("document.querySelector('.form-error')?.innerText.includes('网络连接失败')");
 assert.equal(count(),2);
 const original=db.prepare('SELECT id,request_key,offer FROM orders WHERE product_id=?').get(exchange);
 assert.equal(JSON.parse(original.offer).images.length,1);
 await call('Page.reload');
 await until("document.querySelector('[data-action=buy]')?.textContent.includes('重试下单')");
 await js("document.querySelector('[data-action=buy]').click()");
 await until("document.querySelectorAll('[data-order-detail]').length===2");
 assert.equal(count(),2);
 assert.deepEqual(db.prepare('SELECT id,request_key,offer FROM orders WHERE product_id=?').get(exchange),original);
 const orderScenarios={staleVersion:true,retryAfterLostResponse:true,exchangeImageAfterReload:true,storageQuotaFallback:true};
 console.log(JSON.stringify({browser:version.Browser,results,orderScenarios},null,2));
}finally{
 ws?.close();
 chrome.kill();
 await exited;
 await new Promise(r=>server.close(r));
 await rm(profile,{recursive:true,force:true});
}

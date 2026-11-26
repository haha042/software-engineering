import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {arch, cpus, release, totalmem} from 'node:os';
import {createApp} from '../src/app.js';

const clock = Date.parse('2026-11-25T12:00:00+08:00');
const monday = Date.parse('2026-11-23T00:00:00+08:00');
const wednesday = Date.parse('2026-11-25T00:00:00+08:00');
const threshold = {search: 2000, day: 3000, week: 3000};
const {server, db} = createApp({
  database: ':memory:', adminPassword: 'demo-admin-only', clock: () => clock
});
const user = db.prepare(`
  INSERT INTO users(username,password_hash,certified,created_at) VALUES(?,'fixture',?,?)
`);
for (let i = 0; i < 99; i++) {
  user.run('student-'+i, i % 2, i < 2 ? wednesday : monday - 1);
}
const product = db.prepare(`
  INSERT INTO products(owner_id,title,category,condition_text,description,trade_type,price,status,created_at)
  VALUES(2,?,'生活用品','九成新','测试数据','sale',100,?,?)
`);
const order = db.prepare(`
  INSERT INTO orders(product_id,buyer_id,seller_id,status,snapshot,request_key,deadline,created_at)
  VALUES(?,3,2,?,'{}',?,?,?)
`);
for (let i = 1; i <= 1000; i++) {
  const status = i <= 600 ? 'live' : i <= 900 ? 'reserved' : 'pending';
  product.run(i % 10 === 0 ? '验收台灯' : '验收书本', status, monday);
}
const states = ['pending', 'delivery', 'confirmation', 'completed', 'closed', 'cancelled'];
for (let i = 0; i < 300; i++) {
  order.run(601+i, states[i % states.length], 'fixture-'+i, clock, i < 6 ? wednesday : monday);
}

const session = db.prepare('INSERT INTO sessions VALUES(?,?,?,?)');
function cookie(token, userId) {
  session.run(createHash('sha256').update(token).digest('hex'), userId, 'fixture', clock+60_000);
  return 'campus_session='+token;
}
const admins = Array.from({length:10}, (_, i)=>cookie('admin-fixture-'+i, 1));
const student = cookie('student-fixture', 2);

await new Promise((resolve, reject)=>{
  server.once('error', reject);
  server.listen(0,'127.0.0.1',resolve);
});
const base = 'http://127.0.0.1:'+server.address().port;
const stats = '/api/admin/statistics';
try {
  assert.equal((await fetch(base+stats)).status, 401);
  assert.equal((await fetch(base+stats,{headers:{cookie:student}})).status, 403);
  assert.equal((await fetch(base+stats+'?period=month',{headers:{cookie:admins[0]}})).status, 400);
  const cases = [
    ['search', '/api/products?q='+encodeURIComponent('验收台灯'), data=>{
      assert.equal(data.length,60);
      assert.deepEqual(data.map(row=>row.id),Array.from({length:60},(_,i)=>600-10*i));
      assert.ok(data.every(row=>row.status==='live'));
    }],
    ...['day','week'].map(period=>[period,stats+'?period='+period,data=>{
      assert.equal(data.period,period);
      assert.equal(data.buckets.length,period==='day'?7:4);
      assert.deepEqual(data.products.statuses.map(row=>row.count),[600,100,300]);
      assert.deepEqual(data.products.categories,[{name:'生活用品',count:1000}]);
      assert.deepEqual(data.products.tradeTypes,[{name:'sale',count:1000}]);
      const latest=data.buckets.at(-1);
      const daily=period==='day';
      assert.equal(latest.date,daily?'2026-11-25':'2026-11-23');
      assert.equal(latest.orders,daily?6:300);
      assert.deepEqual(latest.orderStatuses.map(row=>row.status),[...states].sort());
      assert.ok(latest.orderStatuses.every(row=>row.count===(daily?1:50)));
      assert.equal(latest.registered,2);
      assert.equal(latest.certified,1);
      assert.equal(latest.banned,null);
      assert.equal(data.buckets.at(-2).registered,daily?0:97);
    }])
  ];
  const results = {};
  for (const [name,path,verify] of cases) {
    const run = async (cookie)=>{
      const start=performance.now();
      try {
        const response=await fetch(base+path,{headers:{cookie},signal:AbortSignal.timeout(10_000)});
        const data=await response.json();
        const ms=performance.now()-start;
        assert.equal(response.status,200);
        verify(data);
        return {ms};
      } catch (error) {
        return {ms:performance.now()-start,error:error.message,timeout:error.name==='TimeoutError'};
      }
    };
    const warmup=await Promise.all(admins.map(run));
    const samples=[];
    for(let batch=0;batch<10;batch++) samples.push(...await Promise.all(admins.map(run)));
    const sorted=samples.map(sample=>sample.ms).sort((a,b)=>a-b);
    const p95=sorted[Math.ceil(sorted.length*0.95)-1];
    results[name]={p95,thresholdMs:threshold[name],
      failures:samples.filter(sample=>sample.error).length,
      timeouts:samples.filter(sample=>sample.timeout).length,
      warmupFailures:warmup.filter(sample=>sample.error).length,samples};
  }
  process.stdout.write(JSON.stringify({
    environment:{node:process.version,sqlite:db.prepare('SELECT sqlite_version() AS version').get().version,
      os:process.platform,release:release(),arch:arch(),cpu:cpus()[0].model,memoryBytes:totalmem(),
      deployment:'HTTP loopback, in-memory SQLite'},
    load:{users:100,products:1000,live:600,orders:300,sessions:10,warmupRequests:10},
    results
  },null,2)+'\n');
  if(Object.values(results).some(r=>r.failures||r.warmupFailures||r.p95>r.thresholdMs))process.exitCode=1;
} finally {
  await new Promise(resolve=>server.close(resolve));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/database.js';
import {backupDirectory, restoreBackup, scheduleBackups} from '../src/backups.js';

test('D05 每日备份保留七份，独立恢复核对订单和历史', async t=>{
  const root = await mkdtemp(join(tmpdir(),'campus-backup-'));
  const source = join(root,'source.sqlite');
  const db = openDatabase(source);
  t.after(async ()=>{
    db.close();
    await rm(root,{recursive:true,force:true});
  });
  const day = 86_400_000;
  let now = Date.parse('2026-11-17T00:00:00Z');
  const directory = backupDirectory(source);
  const run = scheduleBackups(db,directory,()=>now);
  db.exec(`
    INSERT INTO users(id,username,password_hash,created_at)
    VALUES(1,'demo-seller','fixture',0),(2,'demo-buyer','fixture',0);
    INSERT INTO products(id,owner_id,title,category,condition_text,description,trade_type,status,created_at)
    VALUES(1,1,'样例书','书籍','九成新','演示商品','free','sold',0);
    INSERT INTO orders(id,product_id,buyer_id,seller_id,status,snapshot,request_key,deadline,created_at,buyer_confirmed,seller_confirmed)
    VALUES(1,1,2,1,'completed','{"title":"历史书名"}','fixture-order',0,0,1,1);
    INSERT INTO events(order_id,actor_id,action,detail,created_at)
    VALUES(1,2,'confirm','买家确认',1),(1,1,'confirm','卖家确认',2);
    INSERT INTO audit(actor_id,action,target,detail,created_at)
    VALUES(1,'demo_dispute_resolution','1','演示处置记录',3);
  `);
  const audit = db.prepare("INSERT INTO audit(action,target,created_at) VALUES('demo_change','1',?)");
  for(let i=0;i<9;i++){
    await Promise.all([run(),run()]);
    audit.run(now+1);
    now+=day;
  }
  const names = (await readdir(directory)).sort();
  assert.equal(names.length,7);
  assert.equal(names[0],'campus-2026-11-19.sqlite');
  assert.equal(names.at(-1),'campus-2026-11-25.sqlite');
  const snapshot = join(directory,names.at(-1));
  const target = join(root,'restored.sqlite');
  const started = performance.now();
  await restoreBackup(snapshot,target);
  const restoreMs = performance.now()-started;
  await assert.rejects(restoreBackup(snapshot,target),{code:'EEXIST'});

  const restored = new DatabaseSync(target,{readOnly:true});
  try {
    assert.equal(restored.prepare('SELECT count(*) AS n FROM users').get().n,2);
    const restoredOrder = restored.prepare(`
      SELECT o.snapshot,o.buyer_confirmed,o.seller_confirmed,p.title,b.username AS buyer,s.username AS seller
      FROM orders o JOIN products p ON p.id=o.product_id
      JOIN users b ON b.id=o.buyer_id JOIN users s ON s.id=o.seller_id
    `).get();
    assert.deepEqual({...restoredOrder},{
      snapshot:'{"title":"历史书名"}',buyer_confirmed:1,seller_confirmed:1,
      title:'样例书',buyer:'demo-buyer',seller:'demo-seller'
    });
    assert.deepEqual(restored.prepare('SELECT detail FROM events ORDER BY id').all().map(row=>row.detail),['买家确认','卖家确认']);
    assert.equal(restored.prepare("SELECT detail FROM audit WHERE action='demo_dispute_resolution'").get().detail,'演示处置记录');
    assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get().n-restored.prepare('SELECT count(*) AS n FROM audit').get().n,1);
    const recoveryPointHours = (now-Date.parse(names.at(-1).slice(7,17)+'T00:00:00Z'))/3_600_000;
    assert.equal(recoveryPointHours,24);
    assert.ok(restoreMs<4*3_600_000);
    t.diagnostic(`独立副本恢复 ${restoreMs.toFixed(2)} 毫秒，模拟恢复点间隔 ${recoveryPointHours} 小时，丢失 1 条备份后写入。`);
  } finally {
    restored.close();
  }
});

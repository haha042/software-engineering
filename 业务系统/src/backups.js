import {backup, DatabaseSync} from 'node:sqlite';
import {copyFile, link, mkdir, readdir, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {basename, dirname, join, resolve} from 'node:path';

const dayMs = 86_400_000;
const snapshotName = /^campus-\d{4}-\d{2}-\d{2}\.sqlite$/;

export function backupDirectory(database) {
  const source = resolve(database);
  return join(dirname(source), basename(source) + '.backups');
}

export function scheduleBackups(db, directory, clock = Date.now) {
  let running;
  async function snapshot() {
    const date = new Date(clock()).toISOString().slice(0, 10);
    const name = 'campus-' + date + '.sqlite';
    await mkdir(directory, {recursive:true, mode:0o700});
    if (!(await readdir(directory)).includes(name)) {
      const temporary = join(directory, randomUUID() + '.partial');
      try {
        await backup(db, temporary);
        try {
          await link(temporary, join(directory, name));
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
        }
      } finally {
        await rm(temporary, {force:true});
      }
    }
    const snapshots = (await readdir(directory)).filter(file=>snapshotName.test(file)).sort();
    for (const stale of snapshots.slice(0, -7)) {
      await rm(join(directory, stale), {force:true});
    }
  }

  return function runBackup() {
    running ??= snapshot().finally(()=>{running = undefined;});
    return running;
  };
}

export function startBackups(db, database, clock = Date.now) {
  const run = scheduleBackups(db, backupDirectory(database), clock);
  const tick = ()=>run().catch(error=>console.error('database backup failed', error.message));
  const timer = setInterval(tick, dayMs / 1440);
  timer.unref();
  void tick();
  return ()=>clearInterval(timer);
}

export async function restoreBackup(snapshot, destination) {
  const db = new DatabaseSync(snapshot, {readOnly:true});
  try {
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0].integrity_check !== 'ok' ||
        db.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('备份完整性校验失败');
    }
    db.prepare('SELECT id FROM orders LIMIT 1').get();
  } finally {
    db.close();
  }
  await copyFile(snapshot, destination, constants.COPYFILE_EXCL);
}

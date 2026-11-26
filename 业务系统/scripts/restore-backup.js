import {restoreBackup} from '../src/backups.js';

const [snapshot, destination] = process.argv.slice(2);
if (!snapshot || !destination) {
  console.error('用法 npm run restore -- <备份文件> <新数据库路径>');
  process.exitCode = 1;
} else {
  await restoreBackup(snapshot, destination);
  console.log('备份已恢复到新数据库文件');
}

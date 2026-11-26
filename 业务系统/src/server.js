import {createApp} from './app.js';
import {startBackups} from './backups.js';
import {existsSync} from 'node:fs';
if(existsSync('.env'))process.loadEnvFile('.env');
const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
const database=process.env.DATABASE_PATH||'data/campus.sqlite';
const {server,db}=createApp({database,adminPassword:process.env.ADMIN_PASSWORD});
if(database!==':memory:'){
  server.on('listening',()=>server.once('close',startBackups(db,database)));
}
server.listen(port,host,()=>console.log(`校园流转：http://${host}:${port}（管理员：admin）`));

import {createServer} from 'node:http';
import {randomBytes,createHash,scryptSync,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAccountRoutes} from './accounts.js';
import {createProductRoutes} from './products.js';
import {createAdminRoutes} from './admin.js';
import {createCategoryRoutes} from './categories.js';
import {createOrderRoutes} from './orders.js';
import {createConversationRoutes} from './conversations.js';
import {openDatabase} from './database.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
function passwordHash(p){const salt=randomBytes(16).toString('hex');return `${salt}:${scryptSync(p,salt,64).toString('hex')}`;}
function verify(p,stored){const [salt,h]=stored.split(':');return timingSafeEqual(scryptSync(p,salt,64),Buffer.from(h,'hex'));}
class Failure extends Error{constructor(status,message){super(message);this.status=status;}}
const fail=(s,m)=>{throw new Failure(s,m)};
const text=(x,min=1,max=2000)=>{if(typeof x!=='string'||x.trim().length<min||x.trim().length>max)fail(400,`文字须为${min}～${max}字符`);return x.trim()};
function amount(v){if(typeof v!=='number'||!Number.isFinite(v)||v<0||v>99999.99||Math.abs(v*100-Math.round(v*100))>1e-6)fail(400,'金额范围0～99999.99，最多两位小数');return Math.round(v*100)}
function images(value){if(!Array.isArray(value)||value.length<1||value.length>6)fail(400,'须提供1～6张图片');return value.map(v=>{if(typeof v!=='string')fail(400,'图片格式错误');const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);if(!match)fail(400,'仅允许PNG/JPEG图片');const b=Buffer.from(match[2],'base64');const png=b.length>=24&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&b.subarray(12,16).toString()==='IHDR'&&b.readUInt32BE(16)>0&&b.readUInt32BE(20)>0;const jpeg=b.length>=4&&b[0]===255&&b[1]===216&&b.at(-2)===255&&b.at(-1)===217;if(b.length>5242880||!(match[1]==='png'?png:jpeg))fail(400,'图片内容或大小不合要求');return v})}
export function createApp({database='data/campus.sqlite',adminPassword,clock=Date.now}={}){
 const db=openDatabase(database);const now=()=>clock();
 if(!db.prepare("SELECT id FROM users WHERE role='admin'").get()){if(!adminPassword||adminPassword.length<12)throw new Error('首次启动须设置至少12字符ADMIN_PASSWORD');db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,'admin',?)").run('admin',passwordHash(adminPassword),now());}
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}};
 const audit=(u,action,target,detail='')=>db.prepare('INSERT INTO audit(actor_id,action,target,detail,created_at) VALUES(?,?,?,?,?)').run(u,action,String(target),detail,now());
 const notice=(u,m)=>db.prepare('INSERT INTO notifications(user_id,message,created_at) VALUES(?,?,?)').run(u,m,now());
 const quota=u=>db.prepare("SELECT COUNT(*) n FROM products WHERE owner_id=? AND status IN ('pending','live')").get(u).n;
 async function body(req){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>44*1024*1024)fail(413,'请求内容过大');chunks.push(chunk);}
  let data;
  try{data=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{fail(400,'JSON格式错误');}
  if(data===null||typeof data!=='object'||Array.isArray(data))fail(400,'请求内容必须为JSON对象');
  return data;
 }
 const session=req=>{const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('campus_session='));if(!cookie)return null;return db.prepare('SELECT s.csrf,s.token_hash,u.id,u.username,u.role,u.certified,u.avatar FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hash(cookie.slice(15)),now())};
 function auth(req,role){const u=session(req);if(!u)fail(401,'请先登录');if(role==='admin'&&u.role!=='admin')fail(403,'需要管理员权限');if(role==='student'&&(u.role!=='student'||!u.certified))fail(403,'需要已认证学生身份');if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==u.csrf)fail(403,'请求校验失败，请刷新登录');return u}
 const publicProduct=p=>({...p,images:db.prepare('SELECT id FROM product_images WHERE product_id=?').all(p.id).map(x=>`/api/images/${x.id}`)});
 const shared = {db, now, auth, body, fail, text};
 const {handleOrderRequest, expire} = createOrderRoutes({...shared, images, amount, tx, quota, notice});
 const routes = [
  createAccountRoutes({...shared, session, images, hash, passwordHash, verify, randomBytes, publicProduct}),
  createConversationRoutes({...shared, hash}),
  createProductRoutes({...shared, session, images, amount, tx, quota, publicProduct}),
  createCategoryRoutes({...shared, tx, audit}),
  createAdminRoutes({...shared, tx, audit, notice, publicProduct}),
  handleOrderRequest,
 ];
 const server=createServer(async(req,res)=>{const send=(status,data,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data))};try{
  const url=new URL(req.url,'http://localhost');const path=url.pathname;const method=req.method;
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  if(!path.startsWith('/api/')){if(method!=='GET')fail(405,'不支持的请求');const files={'/':'index.html','/app.js':'app.js','/messages.js':'messages.js','/accounts.js':'accounts.js','/products.js':'products.js','/orders.js':'orders.js','/admin.js':'admin.js','/style.css':'style.css'};if(!files[path])fail(404,'页面不存在');const ext=files[path].split('.').pop();res.writeHead(200,{'Content-Type':{html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8'}[ext]});res.end(readFileSync(fileURLToPath(new URL('../public/'+files[path],import.meta.url))));return}
  for (const handleRequest of routes) {
   await handleRequest(req, url, send, res);
   if (res.writableEnded) return;
  }
  fail(404,'接口不存在');
 }catch(e){if(e instanceof Failure)return send(e.status,{error:e.message});console.error(e);send(500,{error:'服务异常，操作未完成'})}});
 const interval=setInterval(()=>{try{expire()}catch(e){console.error('timeout job failed',e)}},60000);interval.unref();server.on('close',()=>{clearInterval(interval);db.close()});return {server,db,expire};
}

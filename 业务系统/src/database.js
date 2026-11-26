import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
export function openDatabase(path){if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path);db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'student',certified INTEGER NOT NULL DEFAULT 0,failed_attempts INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS certifications(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),real_name TEXT NOT NULL,student_no TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reason TEXT,reviewed_by INTEGER REFERENCES users(id),created_at INTEGER NOT NULL,reviewed_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_cert ON certifications(user_id) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS unique_student_identity ON certifications(student_no) WHERE status='approved';
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL REFERENCES users(id),title TEXT NOT NULL,category TEXT NOT NULL,condition_text TEXT NOT NULL,description TEXT NOT NULL,trade_type TEXT NOT NULL,price INTEGER,expectation TEXT,status TEXT NOT NULL DEFAULT 'pending',review_reason TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS product_images(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),data_url TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),buyer_id INTEGER NOT NULL REFERENCES users(id),seller_id INTEGER NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'pending',paused INTEGER NOT NULL DEFAULT 0,snapshot TEXT NOT NULL,offer TEXT,topup INTEGER NOT NULL DEFAULT 0,payer TEXT,request_key TEXT NOT NULL,deadline INTEGER NOT NULL,created_at INTEGER NOT NULL,delivery TEXT,buyer_confirmed INTEGER NOT NULL DEFAULT 0,seller_confirmed INTEGER NOT NULL DEFAULT 0,cancel_by INTEGER REFERENCES users(id),cancel_status TEXT,cancel_reason TEXT,UNIQUE(buyer_id,request_key));
CREATE UNIQUE INDEX IF NOT EXISTS one_active_order ON orders(product_id) WHERE status IN ('pending','delivery','confirmation');
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,order_id INTEGER NOT NULL REFERENCES orders(id),actor_id INTEGER REFERENCES users(id),action TEXT NOT NULL,detail TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),message TEXT NOT NULL,read_at INTEGER,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor_id INTEGER REFERENCES users(id),action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversations(id INTEGER PRIMARY KEY,product_id INTEGER NOT NULL REFERENCES products(id),buyer_id INTEGER NOT NULL REFERENCES users(id),seller_id INTEGER NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,UNIQUE(product_id,buyer_id,seller_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,conversation_id INTEGER NOT NULL REFERENCES conversations(id),sender_id INTEGER NOT NULL REFERENCES users(id),content TEXT NOT NULL,request_key TEXT NOT NULL,created_at INTEGER NOT NULL,read_at INTEGER,UNIQUE(sender_id,request_key));
CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id,id);
CREATE INDEX IF NOT EXISTS conversation_buyer ON conversations(buyer_id);
CREATE INDEX IF NOT EXISTS conversation_seller ON conversations(seller_id);
`);
  db.exec(`CREATE TABLE IF NOT EXISTS favorites(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, product_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS favorites_user ON favorites(user_id, id DESC)');
// —— 订单模块（B02～B07）：订单侧图片副本、协商取消申请、交易评价 ——
// 订单图片副本与商品图片解耦：商品编辑删图后历史订单仍读得到下单时的原图。
db.exec(`CREATE TABLE IF NOT EXISTS order_images(
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  source_image_id INTEGER,
  data_url TEXT NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS order_images_order ON order_images(order_id, id)');
// 一次申请一行：编号、申请人和时间、回应人和时间、结果与理由完整留痕。
db.exec(`CREATE TABLE IF NOT EXISTS cancel_requests(
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  responded_by INTEGER REFERENCES users(id),
  responded_at INTEGER
)`);
db.exec('CREATE INDEX IF NOT EXISTS cancel_requests_order ON cancel_requests(order_id, id)');
// 每单每人一条评价；被评价人可回复一次，原评价不可改删。
db.exec(`CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  reviewee_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reply TEXT,
  reply_at INTEGER,
  UNIQUE(order_id, reviewer_id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS reviews_order ON reviews(order_id, id)');
// 兼容已有数据库，保留旧商品，未填写地点时由页面明确提示。
if(!db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='delivery_location')){
 db.exec("ALTER TABLE products ADD COLUMN delivery_location TEXT NOT NULL DEFAULT ''");
}
const userColumns=db.prepare('PRAGMA table_info(users)').all();
for(const name of ['nickname','bio','avatar'])if(!userColumns.some(c=>c.name===name))db.exec(`ALTER TABLE users ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
// 商品内容版本：新建商品为 v1；内容变更（编辑/重提）由 products.js 递增；审核只改状态不改版本。
if(!db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='version')){
 db.exec('ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
}
const orderColumns=db.prepare('PRAGMA table_info(orders)').all();
if(!orderColumns.some(c=>c.name==='completed_at')){
 db.exec('ALTER TABLE orders ADD COLUMN completed_at INTEGER');
 // 已有完成订单按最后一次本人确认事件回填评价期限起点；无事件时保持空值，不伪装完成时间。
 db.exec("UPDATE orders SET completed_at=(SELECT MAX(e.created_at) FROM events e WHERE e.order_id=orders.id AND e.action='confirm') WHERE status='completed'");
}
if(!orderColumns.some(c=>c.name==='reject_reason'))db.exec('ALTER TABLE orders ADD COLUMN reject_reason TEXT');
return db;}

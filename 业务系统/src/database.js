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
CREATE TABLE IF NOT EXISTS categories(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'active',sort INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,disabled_at INTEGER);
CREATE INDEX IF NOT EXISTS message_conversation ON messages(conversation_id,id);
CREATE INDEX IF NOT EXISTS conversation_buyer ON conversations(buyer_id);
CREATE INDEX IF NOT EXISTS conversation_seller ON conversations(seller_id);
`);
// 兼容已有数据库，保留旧商品，未填写地点时由页面明确提示。
if(!db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='delivery_location')){
 db.exec("ALTER TABLE products ADD COLUMN delivery_location TEXT NOT NULL DEFAULT ''");
}
// 分类改为单级表 + 商品引用 id；旧 category 文本保留作历史快照（见 docs/分类字段与历史商品兼容规则.md）。
if(!db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='category_id')){
 db.exec('ALTER TABLE products ADD COLUMN category_id INTEGER');
}
db.exec(`INSERT OR IGNORE INTO categories(name,status,sort,created_at)
 SELECT DISTINCT category,'active',0,${Date.now()} FROM products WHERE TRIM(category)<>'';
 UPDATE products SET category_id=(SELECT id FROM categories c WHERE c.name=products.category)
 WHERE category_id IS NULL AND TRIM(category)<>'';`);
const userColumns=db.prepare('PRAGMA table_info(users)').all();
for(const name of ['nickname','bio','avatar'])if(!userColumns.some(c=>c.name===name))db.exec(`ALTER TABLE users ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
return db;}

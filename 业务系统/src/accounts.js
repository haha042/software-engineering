export function createAccountRoutes({db, now, auth, body, fail, text, session, images, hash, passwordHash, verify, randomBytes, publicProduct}) {
  const safeUser=u=>({id:u.id,username:u.username,role:u.role,certified:!!u.certified,avatarVersion:u.avatar?hash(u.avatar).slice(0,16):null});

  return async function handleAccountRequest(req, url, send, res) {
    const path = url.pathname;
    const method = req.method;
    if(path==='/api/register'&&method==='POST'){const b=await body(req);const username=text(b.username,4,20);if(!/^[A-Za-z0-9_]+$/.test(username))fail(400,'用户名仅限字母数字下划线');const p=text(b.password,8,128);if(!/[A-Za-z]/.test(p)||!/[0-9]/.test(p))fail(400,'密码须包含字母和数字');try{const r=db.prepare('INSERT INTO users(username,password_hash,created_at) VALUES(?,?,?)').run(username,passwordHash(p),now());return send(201,{id:Number(r.lastInsertRowid)})}catch(e){if(e.code?.includes('SQLITE'))fail(409,'用户名已存在');throw e}}
    if(path==='/api/login'&&method==='POST'){const b=await body(req);const name=text(b.username,1,20),p=text(b.password,1,128);const u=db.prepare('SELECT * FROM users WHERE username=?').get(name);if(u?.locked_until>now())fail(429,'登录失败次数过多，账号锁定30分钟');if(u?.status==='banned'&&u.banned_until>now())fail(403,'账号已被封禁，无法登录');if(!u||!verify(p,u.password_hash)){if(u)db.prepare('UPDATE users SET failed_attempts=failed_attempts+1,locked_until=? WHERE id=?').run(u.failed_attempts+1>=5?now()+1800000:0,u.id);fail(401,'用户名或密码错误')}db.prepare('UPDATE users SET failed_attempts=0,locked_until=0 WHERE id=?').run(u.id);const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash(token),u.id,csrf,now()+86400000);return send(200,{user:safeUser(u),csrf},{'Set-Cookie':`campus_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${process.env.COOKIE_SECURE==='1'?'; Secure':''}`})}
    if(path==='/api/me'&&method==='GET'){const u=session(req);return send(200,u?{user:safeUser(u),csrf:u.csrf}:{user:null})}
    const publicUserMatch=path.match(/^\/api\/users\/(\d+)(\/avatar)?$/);
    if(publicUserMatch){
     auth(req);if(method!=='GET')fail(405,'不支持的请求');
     const p=db.prepare("SELECT id,username,nickname,bio,certified,avatar FROM users WHERE id=? AND role='student'").get(Number(publicUserMatch[1]));
     if(!p)fail(404,'用户不存在');
     if(publicUserMatch[2]){
      if(!p.avatar)fail(404,'尚未设置头像');
      const [prefix,data]=p.avatar.split(',');res.writeHead(200,{'Content-Type':prefix.includes('png')?'image/png':'image/jpeg','Cache-Control':'private, no-store'});return res.end(Buffer.from(data,'base64'));
     }
     const profile={id:p.id,username:p.username,nickname:p.nickname,bio:p.bio,certified:!!p.certified,avatarVersion:p.avatar?hash(p.avatar).slice(0,16):null};
     return send(200,{profile,products:db.prepare("SELECT p.*,u.username owner_name FROM products p JOIN users u ON u.id=p.owner_id WHERE p.owner_id=? AND p.status='live' ORDER BY p.id DESC").all(p.id).map(publicProduct)});
    }
    if(path==='/api/profile/avatar'){
     const u=auth(req);
     if(method==='GET'){
      if(!u.avatar)fail(404,'尚未设置头像');
      const [prefix,data]=u.avatar.split(',');
      res.writeHead(200,{'Content-Type':prefix.includes('png')?'image/png':'image/jpeg','Cache-Control':'private, no-store'});
      return res.end(Buffer.from(data,'base64'));
     }
     if(method==='PUT'){
      const b=await body(req);
      if(!b||typeof b.avatar!=='string')fail(400,'请上传PNG或JPEG头像');
      const avatar=b.avatar;
      if(avatar.length>2800000)fail(400,'头像图片不能超过2 MiB');
      if(avatar){images([avatar]);if(Buffer.from(avatar.split(',')[1],'base64').length>2097152)fail(400,'头像图片不能超过2 MiB');}
      db.prepare('UPDATE users SET avatar=? WHERE id=?').run(avatar,u.id);
      return send(200,{ok:true});
     }
     fail(405,'不支持的请求');
    }
    if(path==='/api/profile'){
     const u=auth(req);
     if(method==='GET')return send(200,db.prepare('SELECT username,role,certified,nickname,bio FROM users WHERE id=?').get(u.id));
     if(method==='PUT'){
      const b=await body(req);
      if(!b||Array.isArray(b)||typeof b!=='object'||Object.keys(b).some(k=>!['nickname','bio','avatar'].includes(k)))fail(400,'仅可修改昵称、个人简介和头像');
      const nickname=text(b.nickname,0,40),bio=text(b.bio,0,300);
      if(Object.hasOwn(b,'avatar')){
       if(typeof b.avatar!=='string')fail(400,'请上传PNG或JPEG头像');
       if(b.avatar.length>2800000)fail(400,'头像图片不能超过2 MiB');
       if(b.avatar){images([b.avatar]);if(Buffer.from(b.avatar.split(',')[1],'base64').length>2097152)fail(400,'头像图片不能超过2 MiB');}
       db.prepare('UPDATE users SET nickname=?,bio=?,avatar=? WHERE id=?').run(nickname,bio,b.avatar,u.id);
      }else db.prepare('UPDATE users SET nickname=?,bio=? WHERE id=?').run(nickname,bio,u.id);
      return send(200,{ok:true});
     }
     fail(405,'不支持的请求');
    }
    if(path==='/api/logout'&&method==='POST'){const u=auth(req);db.prepare('DELETE FROM sessions WHERE token_hash=?').run(u.token_hash);return send(200,{ok:true},{'Set-Cookie':'campus_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})}
    if(path==='/api/certifications'){const u=auth(req);if(method==='GET')return send(200,db.prepare('SELECT id,real_name,student_no,status,reason,created_at FROM certifications WHERE user_id=? ORDER BY id DESC').all(u.id));if(method==='POST'){if(u.role!=='student'||u.certified)fail(403,'当前账号不可申请');const b=await body(req);const realName=text(b.realName,1,40),studentNo=text(b.studentNo,1,40);if(db.prepare("SELECT id FROM certifications WHERE student_no=? AND status='approved'").get(studentNo))fail(409,'该学号已完成认证，无法重复申请');try{const r=db.prepare('INSERT INTO certifications(user_id,real_name,student_no,created_at) VALUES(?,?,?,?)').run(u.id,realName,studentNo,now());return send(201,{id:Number(r.lastInsertRowid)})}catch{fail(409,'已有待审核申请')}}}
  }
}

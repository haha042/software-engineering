export function createAdminRoutes({db, now, auth, body, fail, text, tx, audit, notice, publicProduct}) {
  return async function handleAdminRequest(req, url, send) {
    const path = url.pathname;
    const method = req.method;
    if(path==='/api/admin/users'&&method==='GET'){
     const actor=auth(req,'admin');
     const users=db.prepare(`SELECT u.id,u.username,u.role,u.certified,u.nickname,u.bio,u.created_at,u.failed_attempts,u.locked_until,
      (SELECT status FROM certifications WHERE user_id=u.id ORDER BY id DESC LIMIT 1) certification_status,
      (SELECT COUNT(*) FROM products WHERE owner_id=u.id) product_count,
      (SELECT COUNT(*) FROM orders WHERE buyer_id=u.id OR seller_id=u.id) order_count
      FROM users u ORDER BY u.id DESC`).all();
     audit(actor.id,'read_accounts','users',`count=${users.length}`);
     return send(200,{users});
    }
    const accountMatch=path.match(/^\/api\/admin\/users\/(\d+)$/);
    if(accountMatch&&method==='GET'){
     const actor=auth(req,'admin');
     const account=db.prepare('SELECT id,username,role,certified,nickname,bio,avatar,created_at,failed_attempts,locked_until FROM users WHERE id=?').get(Number(accountMatch[1]));
     if(!account)fail(404,'账号不存在');
     const certifications=db.prepare('SELECT c.id,c.real_name,c.student_no,c.status,c.reason,c.created_at,c.reviewed_at,c.reviewed_by,u.username reviewer_name FROM certifications c LEFT JOIN users u ON u.id=c.reviewed_by WHERE c.user_id=? ORDER BY c.id DESC').all(account.id);
     const counts={products:db.prepare('SELECT COUNT(*) n FROM products WHERE owner_id=?').get(account.id).n,orders:db.prepare('SELECT COUNT(*) n FROM orders WHERE buyer_id=? OR seller_id=?').get(account.id,account.id).n};
     audit(actor.id,'read_account',account.id);
     return send(200,{account,certifications,counts,passwordSet:true});
    }
    if(path==='/api/admin/queue'&&method==='GET'){auth(req,'admin');return send(200,{certifications:db.prepare("SELECT c.*,u.username FROM certifications c JOIN users u ON u.id=c.user_id WHERE c.status='pending'").all(),products:db.prepare("SELECT * FROM products WHERE status='pending'").all().map(publicProduct)})}
    let match=path.match(/^\/api\/admin\/(certifications|products)\/(\d+)$/);if(match&&method==='POST'){const u=auth(req,'admin'),b=await body(req);if(!['approve','reject'].includes(b.action))fail(400,'审核动作错误');const id=+match[2],reason=b.action==='reject'?text(b.reason):'';tx(()=>{const review=audit(u.id,'review_'+match[1],id,b.action+' '+reason).lastInsertRowid;if(match[1]==='certifications'){const c=db.prepare('SELECT * FROM certifications WHERE id=?').get(id);if(!c||c.status!=='pending')fail(409,'申请已处理');if(b.action==='approve'&&b.offlineVerified!==true)fail(400,'请确认已线下核验');if(b.action==='approve'&&db.prepare("SELECT id FROM certifications WHERE student_no=? AND status='approved'").get(c.student_no))fail(409,'学号已绑定其他账号');db.prepare('UPDATE certifications SET status=?,reason=?,reviewed_by=?,reviewed_at=? WHERE id=?').run(b.action==='approve'?'approved':'rejected',reason,u.id,now(),id);if(b.action==='approve')db.prepare('UPDATE users SET certified=1 WHERE id=?').run(c.user_id);notice(c.user_id,'review:'+review,'认证审核：'+(b.action==='approve'?'通过':'驳回 '+reason))}else{const p=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!p||p.status!=='pending')fail(409,'商品已处理');db.prepare('UPDATE products SET status=?,review_reason=? WHERE id=?').run(b.action==='approve'?'live':'rejected',reason,id);notice(p.owner_id,'review:'+review,'商品审核：'+(b.action==='approve'?'通过':'驳回 '+reason))}});return send(200,{ok:true})}
  }
}

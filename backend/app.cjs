'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {openDatabase,transaction}=require('./database.cjs');
const S=require('./security.cjs');
const {createMailer}=require('./email.cjs');
const publicPages=['login','forgot-password','request-account','reset-password'];
const pages=[...publicPages,'dashboard','customers','menu','orders','tables','billing','reports','settings'];
const now=()=>new Date().toISOString();
function createApp(options={}){
  const root=options.root||path.resolve(__dirname,'..');
  const db=openDatabase(options.dbPath||path.resolve(root,process.env.DB_PATH||'data/dineflow.sqlite'));
  const mail=createMailer({transport:options.mailTransport,from:options.mailFrom});
  const baseUrl=(options.baseUrl||process.env.APP_URL||'http://127.0.0.1:4173').replace(/\/$/,'');
  const origin=new URL(baseUrl).origin,secure=options.secureCookies??(process.env.COOKIE_SECURE==='true');
  const setupSecret=options.setupSecret??process.env.SETUP_SECRET??'';
  const timezone=options.timezone||process.env.RESTAURANT_TIMEZONE||'Asia/Manila';
  const get=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args),run=(sql,...args)=>db.prepare(sql).run(...args);
  const atomic=fn=>transaction(db,fn);
  const dateKey=value=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
  const orderId=id=>S.integer(Number(String(id).replace(/^DF-/,'')),1,Number.MAX_SAFE_INTEGER,'Order ID');
  const publicUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,status:u.status});
  const profile=()=>JSON.parse(get("SELECT value FROM settings WHERE key='profile'").value);
  function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value))}
  function audit(user,action,entity,id){run('INSERT INTO audit_log(actor_id,action,entity,entity_id,created_at) VALUES (?,?,?,?,?)',user?.id||null,action,entity,String(id??''),now())}
  function cookie(res,token,clear=false){res.setHeader('Set-Cookie',`dineflow_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${clear?0:43200}${secure?'; Secure':''}`)}
  function issueSession(res,user){const token=S.randomToken(),csrf=S.randomToken();run('INSERT INTO sessions VALUES (?,?,?,?)',S.hashToken(token),user.id,csrf,Date.now()+43200000);cookie(res,token);return {user:publicUser(user),csrf}}
  function session(req){const token=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('dineflow_session='))?.slice('dineflow_session='.length);if(!token||!/^\w{64}$/.test(token))return null;return get("SELECT u.*,s.csrf,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status='Active'",S.hashToken(token),Date.now())||null}
  function requireUser(req){const u=session(req);if(!u)S.fail(401,'Please log in to continue.');return u}
  function admin(u){if(u.role!=='Admin')S.fail(403,'Only an administrator can perform this action.')}
  function version(record,data){if(record.version!==data.version)S.fail(409,'This record changed in another session. Refresh and try again.')}
  function limited(key,max,ms=900000){const r=get('SELECT * FROM rate_limits WHERE key=?',key);if(r&&r.reset_at>Date.now()&&r.count>=max)S.fail(429,'Too many attempts. Please try again later.');if(!r||r.reset_at<=Date.now())run('INSERT INTO rate_limits VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=1,reset_at=excluded.reset_at',key,Date.now()+ms);else run('UPDATE rate_limits SET count=count+1 WHERE key=?',key)}
  async function body(req){if(!String(req.headers['content-type']||'').startsWith('application/json'))S.fail(415,'Use application/json.');let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>65536)S.fail(413,'Request is too large.');chunks.push(c)}try{const v=JSON.parse(Buffer.concat(chunks));if(!v||Array.isArray(v)||typeof v!=='object')throw Error();return v}catch{S.fail(400,'Invalid JSON request.')}}
  function orderRow(o){return {id:`DF-${o.id}`,customer:o.customer_id||0,customerName:o.customer_name,table:o.table_id,status:o.status,createdAt:o.created_at,version:o.version,items:all('SELECT * FROM order_items WHERE order_id=? ORDER BY id',o.id).map(i=>({id:i.menu_id,name:i.name,price:i.price_cents/100,qty:i.qty}))}}
  function bill(id){const o=get('SELECT * FROM orders WHERE id=?',id);if(!o)S.fail(404,'Order not found.');const paid=get('SELECT * FROM transactions WHERE order_id=?',id);if(paid)return {...JSON.parse(paid.snapshot),paid:true,receipt:`TX-${paid.id}`,method:paid.method,tendered:paid.tendered_cents/100,reference:paid.reference};const items=orderRow(o).items,subtotal=items.reduce((s,i)=>s+Math.round(i.price*100)*i.qty,0),vat=Math.round(subtotal*.12);return {orderId:`DF-${id}`,version:o.version,table:o.table_id,customer:o.customer_name,items,subtotal:subtotal/100,vat:vat/100,total:(subtotal+vat)/100,paid:false,method:'Cash',profile:profile()}}
  function freeTable(id){if(!get("SELECT id FROM orders WHERE table_id=? AND status IN ('Pending','Preparing','Served')",id))run("UPDATE dining_tables SET status='Available',version=version+1 WHERE id=?",id)}
  function metrics(){const today=dateKey(Date.now()),y=new Date(today+'T12:00:00Z');y.setUTCDate(y.getUTCDate()-1);const yesterday=y.toISOString().slice(0,10),tx=all('SELECT * FROM transactions'),os=all('SELECT created_at FROM orders');const t=tx.filter(x=>dateKey(x.created_at)===today),p=tx.filter(x=>dateKey(x.created_at)===yesterday);const sum=rows=>rows.reduce((s,x)=>s+x.total_cents,0)/100,revenue=sum(t),prev=sum(p),count=os.filter(x=>dateKey(x.created_at)===today).length,pc=os.filter(x=>dateKey(x.created_at)===yesterday).length;const pop=new Map();for(const x of t)for(const i of JSON.parse(x.snapshot).items)pop.set(i.name,(pop.get(i.name)||0)+i.qty);const pct=(v,p)=>p?Math.round((v-p)/p*100):0;return {revenue,totalOrders:count,completed:t.length,average:t.length?revenue/t.length:0,topItem:[...pop.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'—',revenueChange:pct(revenue,prev),orderChange:pct(count,pc),averageChange:pct(t.length?revenue/t.length:0,p.length?prev/p.length:0),weekly:Array.from({length:7},(_,i)=>{const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-6+i);const key=d.toISOString().slice(0,10);return {date:key,label:d.toLocaleDateString('en-US',{weekday:'short',timeZone:'UTC'}),amount:sum(tx.filter(x=>dateKey(x.created_at)===key))}})}}
  function bootstrap(u){return {user:publicUser(u),csrf:u.csrf,mailConfigured:mail.configured,profile:profile(),preferences:JSON.parse(get('SELECT value FROM user_preferences WHERE user_id=?',u.id)?.value||'{"email":true,"print":false,"dark":false}'),customers:all('SELECT * FROM customers WHERE deleted=0 ORDER BY id').map(c=>({id:c.id,name:c.name,phone:c.phone,email:c.email,visits:c.visits,last:c.last_visit?dateKey(c.last_visit):'No visits',version:c.version})),menu:all('SELECT * FROM menu_items WHERE deleted=0 ORDER BY id').map(m=>({id:m.id,name:m.name,description:m.description,price:m.price_cents/100,category:m.category,image:m.image,available:!!m.available,version:m.version})),tables:all('SELECT * FROM dining_tables ORDER BY id'),orders:all('SELECT * FROM orders ORDER BY id DESC').map(orderRow),transactions:all('SELECT * FROM transactions ORDER BY id DESC').map(t=>{const b=JSON.parse(t.snapshot);return {id:`TX-${t.id}`,orderId:`DF-${t.order_id}`,time:new Date(t.created_at).toLocaleTimeString('en-PH',{timeZone:timezone,hour:'2-digit',minute:'2-digit'}),createdAt:t.created_at,customer:b.customer,items:b.items.map(i=>`${i.qty}x ${i.name}`).join(', '),amount:t.total_cents/100,method:t.method,reference:t.reference}}),team:all('SELECT id,name,email,role,status FROM users ORDER BY id'),requests:u.role==='Admin'?all('SELECT id,name,email,role,message,status,created_at,email_status FROM account_requests ORDER BY id DESC'):[],metrics:metrics()}}
  let reportBusy=false;
  async function sendClosingReports(day){
    if(!mail.configured||reportBusy)return;reportBusy=true;
    try{const rows=all('SELECT total_cents,created_at FROM transactions').filter(t=>dateKey(t.created_at)===day),revenue=rows.reduce((s,t)=>s+t.total_cents,0)/100;
      for(const user of all("SELECT u.*,p.value preferences FROM users u LEFT JOIN user_preferences p ON p.user_id=u.id WHERE u.status='Active'")){
        if(user.preferences&&!JSON.parse(user.preferences).email)continue;const previous=get('SELECT * FROM email_deliveries WHERE user_id=? AND date_key=?',user.id,day);
        if(previous&&(previous.status==='Sent'||previous.attempts>=3||previous.last_attempt>Date.now()-3600000))continue;
        run("INSERT INTO email_deliveries VALUES (?,?,'Sending',1,?) ON CONFLICT(user_id,date_key) DO UPDATE SET status='Sending',attempts=attempts+1,last_attempt=excluded.last_attempt",user.id,day,Date.now());
        try{await mail.send(user.email,`DineFlow closing report — ${day}`,`Hello ${user.name},\n\nClosing report for ${day} (${timezone})\nRestaurant: ${profile().name}\nPaid transactions: ${rows.length}\nRevenue including VAT: PHP ${revenue.toFixed(2)}\n\nOpen DineFlow Reports for details.\n${baseUrl}/reports/index.html`);run("UPDATE email_deliveries SET status='Sent' WHERE user_id=? AND date_key=?",user.id,day)}catch{run("UPDATE email_deliveries SET status='Failed' WHERE user_id=? AND date_key=?",user.id,day)}
      }
    }finally{reportBusy=false}
  }
  async function authRoutes(req,res,url){
    const route=url.pathname,method=req.method,ip=req.socket.remoteAddress||'local';
    if(route==='/api/session'&&method==='GET'){const u=session(req);json(res,200,{user:u?publicUser(u):null,csrf:u?.csrf||null,setupRequired:!get('SELECT id FROM users LIMIT 1'),mailConfigured:mail.configured,setupSecretRequired:!!setupSecret});return true}
    if(route==='/api/setup'&&method==='POST'){
      limited(`setup:${ip}`,10);if(get('SELECT id FROM users LIMIT 1'))S.fail(409,'Initial setup is already complete.');
      const d=await body(req);if(setupSecret&&S.hashToken(String(d.setupSecret||''))!==S.hashToken(setupSecret))S.fail(403,'Setup key is incorrect.');
      const name=S.text(d.name,'Name',100),email=S.email(d.email),hash=await S.hashPassword(S.password(d.password));
      const u=atomic(()=>{if(get('SELECT id FROM users LIMIT 1'))S.fail(409,'Initial setup is already complete.');const r=run("INSERT INTO users(name,email,password_hash,role,status,created_at) VALUES (?,?,?,'Admin','Active',?)",name,email,hash,now());const u=get('SELECT * FROM users WHERE id=?',Number(r.lastInsertRowid));run("UPDATE settings SET value=? WHERE key='profile'",JSON.stringify({...profile(),email}));if(d.referenceCatalog===true){const catalog=require('./reference-catalog.cjs');for(const [name,description,price,category,image] of catalog.menu)run('INSERT INTO menu_items(name,description,price_cents,category,image) VALUES (?,?,?,?,?)',name,description,price*100,category,image);for(const seats of catalog.seats)run("INSERT INTO dining_tables(seats,status) VALUES (?,'Available')",seats)}audit(u,'setup','user',u.id);return u});json(res,201,issueSession(res,u));return true;
    }
    if(route==='/api/auth/login'&&method==='POST'){
      limited(`login-ip:${ip}`,40);const d=await body(req),email=S.email(d.email);limited(`login-email:${email}`,10);
      const u=get('SELECT * FROM users WHERE email=?',email),valid=await S.verifyPassword(typeof d.password==='string'?d.password.slice(0,129):'',u?.password_hash);
      if(!valid||u?.status!=='Active')S.fail(401,'Email or password is incorrect.');run('DELETE FROM rate_limits WHERE key=?',`login-email:${email}`);audit(u,'login','user',u.id);json(res,200,issueSession(res,u));return true;
    }
    if(route==='/api/auth/logout'&&method==='POST'){const u=requireUser(req);if(req.headers['x-csrf-token']!==u.csrf)S.fail(403,'Invalid request token.');run('DELETE FROM sessions WHERE token_hash=?',u.token_hash);cookie(res,'',true);json(res,200,{ok:true});return true}
    if(route==='/api/account-requests'&&method==='POST'){
      limited(`requests:${ip}`,10,3600000);const d=await body(req),name=S.text(d.name,'Full name',100),email=S.email(d.email),role=S.text(d.role,'Role',40),message=S.text(d.message||'','Message',2000,true);
      if(!['Manager','Staff','Cashier','Kitchen Staff'].includes(role))S.fail(400,'Select a valid role.');
      if(!get('SELECT id FROM users WHERE email=?',email)&&!get("SELECT id FROM account_requests WHERE email=? AND status='Pending'",email))run('INSERT INTO account_requests(name,email,role,message,created_at) VALUES (?,?,?,?,?)',name,email,role,message,now());
      json(res,202,{message:'Your request has been submitted to the administrator for review.'});return true;
    }
    if(route==='/api/auth/forgot'&&method==='POST'){
      limited(`forgot-ip:${ip}`,15,3600000);const d=await body(req),email=S.email(d.email);limited(`forgot-email:${email}`,3,3600000);
      if(!mail.configured)S.fail(503,'Password reset email is not configured yet. Please contact your administrator.');
      const u=get("SELECT * FROM users WHERE email=? AND status='Active'",email);
      if(u){const token=S.randomToken();atomic(()=>{run("DELETE FROM auth_tokens WHERE user_id=? AND purpose='reset'",u.id);run("INSERT INTO auth_tokens VALUES (?,?,'reset',?)",S.hashToken(token),u.id,Date.now()+3600000)});
        try{await mail.send(u.email,'Reset your DineFlow password',`Hello ${u.name},\n\nOpen this link to choose a new password:\n${baseUrl}/reset-password/index.html#token=${token}\n\nThe link expires in one hour and can only be used once. If you did not request this, ignore this email.\n\nDineFlow`)}catch{run('DELETE FROM auth_tokens WHERE token_hash=?',S.hashToken(token));S.fail(503,'Email delivery failed. Please try again later or contact your administrator.')}
      }json(res,202,{message:'If an active account matches that address, a password reset link has been emailed.'});return true;
    }
    if(route==='/api/auth/token-info'&&method==='POST'){limited(`token:${ip}`,30);const d=await body(req),row=get("SELECT a.purpose FROM auth_tokens a JOIN users u ON u.id=a.user_id WHERE a.token_hash=? AND a.expires_at>? AND u.status IN ('Active','Invited')",S.hashToken(S.text(d.token,'Token',128)),Date.now());if(!row)S.fail(400,'This link has expired or has already been used.');json(res,200,row);return true}
    if(route==='/api/auth/reset'&&method==='POST'){
      limited(`reset:${ip}`,10);const d=await body(req),token=S.text(d.token,'Token',128),hash=await S.hashPassword(S.password(d.password));
      atomic(()=>{const r=get('SELECT a.*,u.status FROM auth_tokens a JOIN users u ON u.id=a.user_id WHERE a.token_hash=? AND a.expires_at>?',S.hashToken(token),Date.now());if(!r||!['Active','Invited'].includes(r.status))S.fail(400,'This link has expired or has already been used.');run("UPDATE users SET password_hash=?,status='Active' WHERE id=?",hash,r.user_id);run('DELETE FROM auth_tokens WHERE user_id=?',r.user_id);run('DELETE FROM sessions WHERE user_id=?',r.user_id);audit({id:r.user_id},r.purpose==='invite'?'activate':'reset-password','user',r.user_id)});cookie(res,'',true);json(res,200,{message:'Password saved. You can now log in.'});return true;
    }
    return false;
  }
  async function records(req,res,url,u){
    const route=url.pathname,method=req.method;
    if(route==='/api/bootstrap'&&method==='GET')return json(res,200,bootstrap(u));
    if(route==='/api/profile'&&method==='PUT'){admin(u);const d=await body(req),p={name:S.text(d.name,'Restaurant name',120),address:S.text(d.address,'Business address',500),phone:S.text(d.phone,'Contact number',50),email:S.email(d.email)};run("UPDATE settings SET value=? WHERE key='profile'",JSON.stringify(p));audit(u,'update','profile','restaurant');return json(res,200,{ok:true})}
    if(route==='/api/preferences'&&method==='PUT'){const d=await body(req);for(const k of ['email','print','dark'])if(typeof d[k]!=='boolean')S.fail(400,'Invalid preferences.');run('INSERT INTO user_preferences VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET value=excluded.value',u.id,JSON.stringify({email:d.email,print:d.print,dark:d.dark}));return json(res,200,{ok:true})}
    if(route==='/api/auth/password'&&method==='PUT'){limited(`password:${u.id}`,10);const d=await body(req);if(!await S.verifyPassword(String(d.current||''),u.password_hash))S.fail(400,'Current password is incorrect.');const hash=await S.hashPassword(S.password(d.password));atomic(()=>{run('UPDATE users SET password_hash=? WHERE id=?',hash,u.id);run('DELETE FROM sessions WHERE user_id=?',u.id);run('DELETE FROM auth_tokens WHERE user_id=?',u.id);audit(u,'change-password','user',u.id)});cookie(res,'',true);return json(res,200,{message:'Password updated. Please log in again.'})}
    const r=route.match(/^\/api\/account-requests\/(\d+)\/(approve|reject|resend)$/);
    if(r&&method==='POST'){
      admin(u);const id=Number(r[1]),action=r[2],d=await body(req);let request=get('SELECT * FROM account_requests WHERE id=?',id);if(!request)S.fail(404,'Account request not found.');
      if(action==='reject'){if(request.status!=='Pending')S.fail(409,'This request has already been reviewed.');run("UPDATE account_requests SET status='Rejected',reviewed_by=?,reviewed_at=? WHERE id=?",u.id,now(),id);audit(u,'reject','account-request',id);return json(res,200,{ok:true})}
      if(!mail.configured)S.fail(503,'Configure Gmail SMTP before sending account invitations.');let invited;
      if(action==='approve'){if(!['Admin','Staff'].includes(d.role))S.fail(400,'Choose Admin or Staff access.');invited=atomic(()=>{request=get('SELECT * FROM account_requests WHERE id=?',id);if(request.status!=='Pending')S.fail(409,'This request has already been reviewed.');if(get('SELECT id FROM users WHERE email=?',request.email))S.fail(409,'An account already exists for this email.');const result=run("INSERT INTO users(name,email,role,status,created_at) VALUES (?,?,?,'Invited',?)",request.name,request.email,d.role,now());const person=get('SELECT * FROM users WHERE id=?',Number(result.lastInsertRowid));run("UPDATE account_requests SET status='Approved',reviewed_by=?,reviewed_at=?,user_id=? WHERE id=?",u.id,now(),person.id,id);audit(u,'approve','account-request',id);return person})}
      else{if(request.status!=='Approved')S.fail(409,'Approve this request first.');invited=get('SELECT * FROM users WHERE id=?',request.user_id);if(invited?.status!=='Invited')S.fail(409,'This account has already been activated or disabled.')}
      const token=S.randomToken();atomic(()=>{run("DELETE FROM auth_tokens WHERE user_id=? AND purpose='invite'",invited.id);run("INSERT INTO auth_tokens VALUES (?,?,'invite',?)",S.hashToken(token),invited.id,Date.now()+86400000);run("UPDATE account_requests SET email_status='Sending' WHERE id=?",id)});
      try{await mail.send(invited.email,'Your DineFlow account is approved',`Hello ${invited.name},\n\nYour account request was approved. Set your password using this one-time link:\n${baseUrl}/reset-password/index.html#token=${token}\n\nThis link expires in 24 hours.\n\nDineFlow`);run("UPDATE account_requests SET email_status='Sent' WHERE id=?",id)}catch{run('DELETE FROM auth_tokens WHERE token_hash=?',S.hashToken(token));run("UPDATE account_requests SET email_status='Failed' WHERE id=?",id);S.fail(503,'Approved, but email delivery failed. Use Resend Invitation after checking Gmail settings.')}
      return json(res,200,{ok:true});
    }
    const um=route.match(/^\/api\/users\/(\d+)$/);
    if(um&&method==='PUT'){admin(u);const id=Number(um[1]),d=await body(req);if(id===u.id)S.fail(400,'You cannot disable or change your own access.');if(!['Admin','Staff'].includes(d.role)||!['Active','Disabled'].includes(d.status))S.fail(400,'Invalid role or status.');const target=get('SELECT * FROM users WHERE id=?',id);if(!target)S.fail(404,'User not found.');if(!target.password_hash)S.fail(409,'This account must accept its invitation first.');atomic(()=>{run('UPDATE users SET role=?,status=? WHERE id=?',d.role,d.status,id);run('DELETE FROM sessions WHERE user_id=?',id);run('DELETE FROM auth_tokens WHERE user_id=?',id);audit(u,'change-access','user',id)});return json(res,200,{ok:true})}
    const cm=route.match(/^\/api\/(customers|menu|tables)(?:\/(\d+))?$/);
    if(cm&&['POST','PUT','DELETE'].includes(method)){
      const type=cm[1],id=cm[2]?Number(cm[2]):null;if(type==='menu'||type==='tables'&&method!=='PUT')admin(u);
      if(method==='POST'&&id||method!=='POST'&&!id)S.fail(405,'Invalid record operation.');
      const d=await body(req),name={customers:'customers',menu:'menu_items',tables:'dining_tables'}[type],old=id?get(`SELECT * FROM ${name} WHERE id=?${type!=='tables'?' AND deleted=0':''}`,id):null;
      if(id&&!old)S.fail(404,'Record not found.');if(old)version(old,d);
      const result=atomic(()=>{
        if(method==='DELETE'){if(type==='tables')S.fail(405,'Tables cannot be deleted.');run(`UPDATE ${name} SET deleted=1,version=version+1 WHERE id=?`,id)}
        else if(type==='customers'){const name=S.text(d.name,'Customer name',100),phone=S.text(d.phone,'Phone',50),email=S.email(d.email),visits=S.integer(d.visits,0,1000000,'Visits');if(id)run('UPDATE customers SET name=?,phone=?,email=?,visits=?,version=version+1 WHERE id=?',name,phone,email,visits,id);else return Number(run('INSERT INTO customers(name,phone,email,visits) VALUES (?,?,?,?)',name,phone,email,visits).lastInsertRowid)}
        else if(type==='menu'){const name=S.text(d.name,'Item name',100),desc=S.text(d.description||'','Description',500,true),price=S.cents(d.price,'Price');if(!price)S.fail(400,'Price must be greater than zero.');if(!['Food','Beverages'].includes(d.category)||typeof d.available!=='boolean')S.fail(400,'Invalid category or availability.');if(id)run('UPDATE menu_items SET name=?,description=?,price_cents=?,category=?,available=?,version=version+1 WHERE id=?',name,desc,price,d.category,Number(d.available),id);else return Number(run('INSERT INTO menu_items(name,description,price_cents,category,available) VALUES (?,?,?,?,?)',name,desc,price,d.category,Number(d.available)).lastInsertRowid)}
        else{const seats=S.integer(d.seats,1,50,'Seats');if(!['Available','Occupied','Reserved'].includes(d.status))S.fail(400,'Invalid table status.');if(id&&d.status!=='Occupied'&&get("SELECT id FROM orders WHERE table_id=? AND status IN ('Pending','Preparing','Served')",id))S.fail(409,'This table has open orders. Complete or cancel them before changing its status.');if(id)run('UPDATE dining_tables SET seats=?,status=?,version=version+1 WHERE id=?',seats,d.status,id);else return Number(run('INSERT INTO dining_tables(seats,status) VALUES (?,?)',seats,d.status).lastInsertRowid)}return id;
      });audit(u,method.toLowerCase(),type,result);return json(res,method==='POST'?201:200,{id:result});
    }
    const om=route.match(/^\/api\/orders(?:\/(DF-\d+))?$/);
    if(om&&['POST','PUT'].includes(method)){
      const d=await body(req),id=om[1]?orderId(om[1]):null;if(method==='PUT'&&!id||method==='POST'&&id)S.fail(405,'Invalid order operation.');
      const result=atomic(()=>{
        const old=id?get('SELECT * FROM orders WHERE id=?',id):null;if(id&&!old)S.fail(404,'Order not found.');if(old){version(old,d);if(['Completed','Cancelled'].includes(old.status))S.fail(409,'Completed and cancelled orders cannot be edited.')}
        if(!['Pending','Preparing','Served','Cancelled'].includes(d.status))S.fail(400,'Use Billing to complete an order.');const tid=S.integer(d.table,1,Number.MAX_SAFE_INTEGER,'Table');if(!get('SELECT id FROM dining_tables WHERE id=?',tid))S.fail(400,'Select an existing table.');
        const cid=S.integer(d.customer||0,0,Number.MAX_SAFE_INTEGER,'Customer'),c=cid?get('SELECT * FROM customers WHERE id=?',cid):null;if(cid&&(!c||c.deleted&&old?.customer_id!==cid))S.fail(400,'Select an existing customer.');
        if(!Array.isArray(d.items)||!d.items.length||d.items.length>100)S.fail(400,'An order must contain between 1 and 100 items.');const seen=new Set(),oldItems=old?all('SELECT * FROM order_items WHERE order_id=?',id):[];
        const items=d.items.map(i=>{const mid=S.integer(i.id,1,Number.MAX_SAFE_INTEGER,'Menu item'),qty=S.integer(i.qty,1,999,'Quantity');if(seen.has(mid))S.fail(400,'Combine duplicate items into one quantity.');seen.add(mid);const m=get('SELECT * FROM menu_items WHERE id=?',mid),previous=oldItems.find(x=>x.menu_id===mid);if(!m||((m.deleted||!m.available)&&(!previous||qty>previous.qty)))S.fail(409,'An item is unavailable. Refresh and try again.');return {id:mid,qty,name:previous?.name||m.name,price:previous?.price_cents||m.price_cents}});
        const time=now();let oid=id;if(id){run('UPDATE orders SET customer_id=?,customer_name=?,table_id=?,status=?,updated_at=?,version=version+1 WHERE id=?',cid||null,c?.name||'Walk-in customer',tid,d.status,time,id);run('DELETE FROM order_items WHERE order_id=?',id)}else oid=Number(run('INSERT INTO orders(customer_id,customer_name,table_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',cid||null,c?.name||'Walk-in customer',tid,d.status,time,time).lastInsertRowid);
        for(const i of items)run('INSERT INTO order_items(order_id,menu_id,name,price_cents,qty) VALUES (?,?,?,?,?)',oid,i.id,i.name,i.price,i.qty);if(old&&old.table_id!==tid)freeTable(old.table_id);if(d.status==='Cancelled')freeTable(tid);else run("UPDATE dining_tables SET status='Occupied',version=version+1 WHERE id=?",tid);audit(u,id?'update':'create','order',oid);return oid;
      });return json(res,id?200:201,{id:`DF-${result}`});
    }
    const bm=route.match(/^\/api\/billing\/(DF-\d+)$/);if(bm&&method==='GET')return json(res,200,bill(orderId(bm[1])));
    if(route==='/api/payments'&&method==='POST'){
      const d=await body(req),oid=orderId(d.orderId),key=S.text(d.idempotencyKey,'Payment request key',100);if(!/^[a-zA-Z0-9-]{16,100}$/.test(key))S.fail(400,'Invalid payment request key.');if(!['Cash','Card','GCash'].includes(d.method))S.fail(400,'Invalid payment method.');const tendered=S.cents(d.tendered,'Amount tendered'),ref=S.text(d.reference||'','Payment reference',100,true);if(d.method!=='Cash'&&!ref)S.fail(400,'Enter the reference from the completed external payment.');
      const result=atomic(()=>{
        const previous=get('SELECT * FROM transactions WHERE idempotency_key=?',key);if(previous){if(previous.order_id!==oid||previous.method!==d.method||previous.tendered_cents!==tendered||previous.reference!==ref)S.fail(409,'This payment key was used for a different request.');return bill(oid)}
        const o=get('SELECT * FROM orders WHERE id=?',oid);if(!o)S.fail(404,'Order not found.');if(get('SELECT id FROM transactions WHERE order_id=?',oid))S.fail(409,'This order is already paid. Refresh to view its receipt.');version(o,d);if(o.status!=='Served')S.fail(409,'Mark the order as Served before taking payment.');
        const b=bill(oid),subtotal=Math.round(b.subtotal*100),vat=Math.round(b.vat*100),total=subtotal+vat;if(!total||!b.items.length)S.fail(400,'There are no billable items.');if(tendered<total)S.fail(400,'Amount tendered must cover the grand total.');
        run('INSERT INTO transactions(order_id,subtotal_cents,vat_cents,total_cents,tendered_cents,method,reference,snapshot,created_at,cashier_id,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?,?)',oid,subtotal,vat,total,tendered,d.method,ref,JSON.stringify(b),now(),u.id,key);run("UPDATE orders SET status='Completed',version=version+1,updated_at=? WHERE id=?",now(),oid);freeTable(o.table_id);if(o.customer_id)run('UPDATE customers SET visits=visits+1,last_visit=?,version=version+1 WHERE id=?',now(),o.customer_id);audit(u,'settle','order',oid);return bill(oid);
      });return json(res,200,result);
    }
    S.fail(404,'API endpoint not found.');
  }
  const server=http.createServer(async(req,res)=>{
    for(const [k,v] of Object.entries({'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'self'"}))res.setHeader(k,v);
    try{
      if(req.headers.host!==new URL(baseUrl).host&&!options.allowAnyHost)S.fail(403,'Host is not allowed. Open the configured APP_URL.');const url=new URL(req.url,baseUrl);
      if(url.pathname.startsWith('/api/')){
        if(!['GET','POST','PUT','DELETE'].includes(req.method))S.fail(405,'Method not allowed.');if(req.method!=='GET'&&(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'))S.fail(403,'Request origin is not allowed.');
        if(url.pathname==='/api/health'&&req.method==='GET')return json(res,200,{ok:true});if(await authRoutes(req,res,url))return;
        const u=requireUser(req);if(req.method!=='GET'&&req.headers['x-csrf-token']!==u.csrf)S.fail(403,'Invalid request token. Refresh and try again.');return await records(req,res,url,u);
      }
      if(!['GET','HEAD'].includes(req.method))S.fail(405,'Method not allowed.');let relative;try{relative=decodeURIComponent(url.pathname)}catch{S.fail(400,'Invalid path.')}
      if(relative==='/'){res.writeHead(302,{Location:'/login/index.html'});return res.end()}
      const pm=relative.match(/^\/([a-z-]+)(?:\/|\/index\.html)?$/);
      if(pm&&pages.includes(pm[1])){if(!publicPages.includes(pm[1])&&!session(req)){res.writeHead(302,{Location:'/login/index.html'});return res.end()}relative=`/${pm[1]}/index.html`}
      if(!/^\/(?:assets\/[\w.-]+\.(?:png|svg)|shared\/(?:app\.js|style\.css)|(?:login|forgot-password|request-account|reset-password|dashboard|customers|menu|orders|tables|billing|reports|settings)\/(?:index\.html|style\.css|script\.js))$/.test(relative))S.fail(404,'File not found.');
      const file=path.resolve(root,'.'+relative);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))S.fail(404,'File not found.');const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});if(req.method==='HEAD')return res.end();fs.createReadStream(file).on('error',()=>res.destroy()).pipe(res);
    }catch(error){if(res.headersSent)return res.destroy();const status=error.status||500;if(status===500)console.error('DineFlow request failed:',error.code||error.name);json(res,status,{error:status===500?'The server could not complete the request. Please try again.':error.message})}
  });
  const cleanup=setInterval(()=>{try{run('DELETE FROM sessions WHERE expires_at<?',Date.now());run('DELETE FROM auth_tokens WHERE expires_at<?',Date.now());run('DELETE FROM rate_limits WHERE reset_at<?',Date.now())}catch{}},300000);cleanup.unref();
  const reportsTimer=setInterval(()=>{const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date());const h=Number(parts.find(p=>p.type==='hour').value),m=Number(parts.find(p=>p.type==='minute').value);if(h===0&&m<5)return;const d=new Date(dateKey(Date.now())+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-1);sendClosingReports(d.toISOString().slice(0,10)).catch(()=>{})},60000);reportsTimer.unref();
  server.on('close',()=>{clearInterval(cleanup);clearInterval(reportsTimer);db.close()});return {server,db,mail,sendClosingReports};
}
module.exports={createApp};

'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {once}=require('node:events');
const {createApp}=require('../backend/app.cjs');
test('database-backed restaurant and authentication workflows',async t=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'dineflow-test-')),dbPath=path.join(folder,'test.sqlite'),messages=[];
  const transport={async sendMail(message){messages.push(message);return {messageId:'test'}}};
  const options={dbPath,baseUrl:'http://dineflow.test',allowAnyHost:true,setupSecret:'test-setup-key',mailTransport:transport,mailFrom:'test@example.com'};
  let app=createApp(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');let base='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{if(app.server.listening)await new Promise(resolve=>app.server.close(resolve));fs.rmSync(folder,{recursive:true,force:true})});
  function client(){let cookie='',csrf='';return {async call(route,method='GET',data,extra={}){const response=await fetch(base+route,{method,redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(method!=='GET'?{Origin:'http://dineflow.test','Content-Type':'application/json','X-CSRF-Token':csrf}:{}),...extra},...(data!==undefined?{body:JSON.stringify(data)}:{})});const set=response.headers.get('set-cookie');if(set)cookie=set.split(';')[0];let value;try{value=await response.json()}catch{value=null}if(value?.csrf)csrf=value.csrf;return {status:response.status,value,headers:response.headers}},get cookie(){return cookie},get csrf(){return csrf}}}
  const admin=client(),guest=client();let menuId,tableId,customerId,oid,receipt,staffId;
  const ok=async(client,route,method,data,status=200)=>{const r=await client.call(route,method,data);assert.equal(r.status,status,JSON.stringify(r.value));return r.value};
  await t.test('protects records and private files; setup is one-time and stores hashed passwords',async()=>{
    assert.equal((await guest.call('/api/bootstrap')).status,401);const page=await guest.call('/billing/index.html');assert.equal(page.status,302);assert.equal(page.headers.get('location'),'/login/index.html');
    for(const file of ['/.env','/data/dineflow.sqlite','/server.cjs','/backend/app.cjs','/package.json'])assert.equal((await guest.call(file)).status,404);
    const info=await ok(guest,'/api/session');assert.equal(info.setupRequired,true);
    assert.equal((await guest.call('/api/setup','POST',{name:'Owner',email:'owner@example.com',password:'Owner-Password-123',setupSecret:'wrong'})).status,403);
    const r=await admin.call('/api/setup','POST',{name:'Owner',email:'owner@example.com',password:'Owner-Password-123',setupSecret:'test-setup-key'});assert.equal(r.status,201);assert.match(r.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);assert.equal(r.value.user.role,'Admin');
    assert.equal((await guest.call('/api/setup','POST',{})).status,409);const user=app.db.prepare('SELECT * FROM users').get();assert.match(user.password_hash,/^scrypt\$/);assert.ok(!user.password_hash.includes('Owner-Password-123'));
    assert.equal((await guest.call('/api/auth/login','POST',{email:'owner@example.com',password:'wrong'})).status,401);assert.equal((await admin.call('/api/profile','PUT',{}, {'X-CSRF-Token':''})).status,403);assert.equal((await admin.call('/api/profile','PUT',{}, {Origin:'https://evil.example'})).status,403);
  });
  await t.test('validates and saves customers, menu, tables; rejects stale concurrent edits',async()=>{
    customerId=(await ok(admin,'/api/customers','POST',{name:'Test Customer',phone:'+63 900 000 0000',email:'customer@example.com',visits:0},201)).id;
    menuId=(await ok(admin,'/api/menu','POST',{name:'Pasta Carbonara',description:'Pasta',price:180,category:'Food',available:true},201)).id;
    await ok(admin,'/api/menu','POST',{name:'Iced Coffee',description:'Coffee',price:90,category:'Beverages',available:true},201);
    await ok(admin,'/api/menu','POST',{name:'Mango Juice',description:'Mango',price:80,category:'Beverages',available:true},201);
    tableId=(await ok(admin,'/api/tables','POST',{seats:4,status:'Available'},201)).id;
    assert.equal((await admin.call('/api/menu','POST',{name:'Invalid',description:'',price:-1,category:'Food',available:true})).status,400);
    const data=await ok(admin,'/api/bootstrap');assert.equal(data.customers.length,1);assert.equal(data.menu.length,3);assert.equal(data.tables.length,1);assert.ok(!JSON.stringify(data).includes('password_hash'));
    await ok(admin,'/api/customers/'+customerId,'PUT',{...data.customers[0],name:'Updated Customer'});assert.equal((await admin.call('/api/customers/'+customerId,'PUT',data.customers[0])).status,409);
  });
  await t.test('snapshots order prices, rejects invalid items atomically, and calculates VAT on server',async()=>{
    const before=app.db.prepare('SELECT count(*) n FROM orders').get().n;
    assert.equal((await admin.call('/api/orders','POST',{customer:customerId,table:tableId,status:'Served',items:[{id:menuId,qty:1},{id:99999,qty:1}]})).status,409);assert.equal(app.db.prepare('SELECT count(*) n FROM orders').get().n,before);
    oid=(await ok(admin,'/api/orders','POST',{customer:customerId,table:tableId,status:'Served',items:[{id:menuId,qty:2,price:.01},{id:2,qty:1},{id:3,qty:1}],total:.01},201)).id;
    const b=await ok(admin,'/api/billing/'+oid);assert.equal(b.subtotal,530);assert.equal(b.vat,63.6);assert.equal(b.total,593.6);
    let data=await ok(admin,'/api/bootstrap');assert.equal(data.tables[0].status,'Occupied');await ok(admin,'/api/menu/'+menuId,'PUT',{...data.menu[0],price:999});assert.equal((await ok(admin,'/api/billing/'+oid)).total,593.6);
    data=await ok(admin,'/api/bootstrap');assert.equal((await admin.call('/api/tables/'+tableId,'PUT',{...data.tables[0],status:'Available'})).status,409);
    assert.equal((await admin.call('/api/orders/'+oid,'PUT',{...data.orders[0],status:'Completed'})).status,400);
  });
  await t.test('settles once, handles concurrent retries, and keeps receipts immutable',async()=>{
    const b=await ok(admin,'/api/billing/'+oid),payload={orderId:oid,version:b.version,method:'Cash',tendered:1000,idempotencyKey:'test-payment-idempotency-0001'};
    assert.equal((await admin.call('/api/payments','POST',{...payload,tendered:100})).status,400);
    assert.equal((await admin.call('/api/payments','POST',{...payload,version:0})).status,409);
    const responses=await Promise.all([admin.call('/api/payments','POST',payload),admin.call('/api/payments','POST',payload)]);assert.deepEqual(responses.map(r=>r.status),[200,200]);receipt=responses[0].value;assert.equal(receipt.total,593.6);assert.equal(receipt.tendered-receipt.total,406.4);assert.equal(receipt.receipt,responses[1].value.receipt);
    assert.equal((await admin.call('/api/payments','POST',{...payload,idempotencyKey:'another-payment-key-0002'})).status,409);
    assert.equal(app.db.prepare('SELECT count(*) n FROM transactions').get().n,1);const data=await ok(admin,'/api/bootstrap');assert.equal(data.orders[0].status,'Completed');assert.equal(data.tables[0].status,'Available');assert.equal(data.customers[0].visits,1);assert.equal(data.metrics.revenue,593.6);assert.equal(data.metrics.completed,1);assert.equal(data.metrics.topItem,'Pasta Carbonara');
    await ok(admin,'/api/menu/'+menuId,'DELETE',{version:data.menu[0].version});const archived=await ok(admin,'/api/billing/'+oid);assert.equal(archived.items[0].name,'Pasta Carbonara');assert.equal(archived.items[0].price,180);
  });
  let inviteToken;
  await t.test('saves requests; administrators approve and email single-use invitations',async()=>{
    assert.equal((await guest.call('/api/account-requests','POST',{name:'Intruder',email:'bad@example.com',role:'Admin'})).status,400);
    const request={name:'New Staff',email:'staff@example.com',role:'Cashier',message:'Please add me.'};await ok(guest,'/api/account-requests','POST',request,202);await ok(guest,'/api/account-requests','POST',request,202);
    let data=await ok(admin,'/api/bootstrap');assert.equal(data.requests.length,1);await ok(admin,'/api/account-requests/'+data.requests[0].id+'/approve','POST',{role:'Staff'});assert.equal(messages.length,1);assert.equal(messages[0].to,'staff@example.com');inviteToken=messages[0].text.match(/#token=([a-f0-9]+)/)[1];
    assert.equal(app.db.prepare('SELECT token_hash FROM auth_tokens').get().token_hash.length,64);assert.notEqual(app.db.prepare('SELECT token_hash FROM auth_tokens').get().token_hash,inviteToken);
    assert.equal((await guest.call('/api/auth/login','POST',{email:'staff@example.com',password:'Staff-Password-123'})).status,401);
    assert.equal((await ok(guest,'/api/auth/token-info','POST',{token:inviteToken})).purpose,'invite');await ok(guest,'/api/auth/reset','POST',{token:inviteToken,password:'Staff-Password-123'});assert.equal((await guest.call('/api/auth/reset','POST',{token:inviteToken,password:'Staff-Password-456'})).status,400);
  });
  const staff=client();
  await t.test('enforces staff permissions and revokes sessions after access changes',async()=>{
    const login=await ok(staff,'/api/auth/login','POST',{email:'staff@example.com',password:'Staff-Password-123'});staffId=login.user.id;const data=await ok(staff,'/api/bootstrap');assert.deepEqual(data.requests,[]);
    assert.equal((await staff.call('/api/menu','POST',{})).status,403);assert.equal((await staff.call('/api/profile','PUT',{})).status,403);assert.equal((await staff.call('/api/tables','POST',{})).status,403);assert.equal((await staff.call('/api/users/1','PUT',{})).status,403);
    await ok(staff,'/api/customers','POST',{name:'Staff Added',email:'another@example.com',phone:'123',visits:0},201);
    await ok(admin,'/api/users/'+staffId,'PUT',{role:'Staff',status:'Disabled'});assert.equal((await staff.call('/api/bootstrap')).status,401);await ok(admin,'/api/users/'+staffId,'PUT',{role:'Staff',status:'Active'});await ok(staff,'/api/auth/login','POST',{email:'staff@example.com',password:'Staff-Password-123'});
  });
  await t.test('requires externally completed Card/GCash reference and keeps shared tables occupied',async()=>{
    const data=await ok(admin,'/api/bootstrap'),item=data.menu[0];const orderData={customer:0,table:tableId,status:'Served',items:[{id:item.id,qty:1}]};
    const a=(await ok(staff,'/api/orders','POST',orderData,201)).id,b=(await ok(staff,'/api/orders','POST',orderData,201)).id;
    const first=await ok(staff,'/api/billing/'+a);const pay={orderId:a,version:first.version,method:'GCash',tendered:first.total,idempotencyKey:'gcash-payment-key-00003'};
    assert.equal((await staff.call('/api/payments','POST',pay)).status,400);await ok(staff,'/api/payments','POST',{...pay,reference:'TEST-GCASH-REF'});assert.equal((await ok(admin,'/api/bootstrap')).tables[0].status,'Occupied');
    const second=(await ok(admin,'/api/bootstrap')).orders.find(o=>o.id===b);await ok(staff,'/api/orders/'+b,'PUT',{...second,status:'Cancelled'});assert.equal((await ok(admin,'/api/bootstrap')).tables[0].status,'Available');
  });
  await t.test('reset links expire and invalidate sessions; profile is separate from login identity',async()=>{
    const current=await ok(admin,'/api/bootstrap');await ok(admin,'/api/profile','PUT',{...current.profile,email:'contact@example.com'});assert.equal((await ok(admin,'/api/session')).user.email,'owner@example.com');
    await ok(staff,'/api/preferences','PUT',{email:false,print:true,dark:true});assert.equal((await ok(staff,'/api/bootstrap')).preferences.dark,true);assert.equal((await ok(admin,'/api/bootstrap')).preferences.dark,false);
    await ok(guest,'/api/auth/forgot','POST',{email:'staff@example.com'},202);const token=messages.at(-1).text.match(/#token=([a-f0-9]+)/)[1];await ok(guest,'/api/auth/reset','POST',{token,password:'Staff-New-Password-456'});assert.equal((await staff.call('/api/bootstrap')).status,401);
    await ok(staff,'/api/auth/login','POST',{email:'staff@example.com',password:'Staff-New-Password-456'});
    await ok(guest,'/api/auth/forgot','POST',{email:'staff@example.com'},202);const expired=messages.at(-1).text.match(/#token=([a-f0-9]+)/)[1];app.db.prepare('UPDATE auth_tokens SET expires_at=0 WHERE user_id=?').run(staffId);assert.equal((await guest.call('/api/auth/reset','POST',{token:expired,password:'Another-Password-789'})).status,400);
    await ok(staff,'/api/auth/password','PUT',{current:'Staff-New-Password-456',password:'Staff-Final-Password-789'});assert.equal((await staff.call('/api/bootstrap')).status,401);await ok(staff,'/api/auth/login','POST',{email:'staff@example.com',password:'Staff-Final-Password-789'});await ok(staff,'/api/auth/logout','POST',{});assert.equal((await staff.call('/api/bootstrap')).status,401);
  });
  await t.test('persists records and password hashes across server restarts',async()=>{
    await new Promise(resolve=>app.server.close(resolve));app=createApp(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base='http://127.0.0.1:'+app.server.address().port;
    const owner=client();await ok(owner,'/api/auth/login','POST',{email:'owner@example.com',password:'Owner-Password-123'});const saved=await ok(owner,'/api/bootstrap');assert.equal(saved.transactions.length,2);assert.equal(saved.customers.length,2);assert.equal(saved.profile.email,'contact@example.com');assert.equal((await ok(owner,'/api/billing/'+oid)).receipt,receipt.receipt);
    assert.ok(app.db.prepare('SELECT count(*) n FROM audit_log').get().n>10);
  });
  await t.test('deduplicates daily closing emails and respects each user’s notification preference',async()=>{
    const before=messages.length;await app.sendClosingReports('2026-10-17');assert.equal(messages.length,before+1);assert.equal(messages.at(-1).to,'owner@example.com');await app.sendClosingReports('2026-10-17');assert.equal(messages.length,before+1);assert.equal(app.db.prepare("SELECT count(*) n FROM email_deliveries WHERE status='Sent'").get().n,1);
  });
});
test('failed SMTP is reported honestly and tokens are revoked on delivery failure',async t=>{
  const app=createApp({dbPath:':memory:',baseUrl:'http://mail.test',allowAnyHost:true,mailTransport:{async sendMail(){throw Error('test failure')}}});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>app.server.close(resolve)));const base='http://127.0.0.1:'+app.server.address().port;
  const call=async(route,data)=>fetch(base+route,{method:'POST',headers:{Origin:'http://mail.test','Content-Type':'application/json'},body:JSON.stringify(data)});
  assert.equal((await call('/api/setup',{name:'Mail Test',email:'mail@example.com',password:'Mail-Test-Password-123'})).status,201);
  assert.equal((await call('/api/auth/forgot',{email:'mail@example.com'})).status,503);assert.equal(app.db.prepare('SELECT count(*) n FROM auth_tokens').get().n,0);
});
test('first-run reference catalog is optional and contains no fabricated sales',async t=>{
  const app=createApp({dbPath:':memory:',baseUrl:'http://catalog.test',allowAnyHost:true});app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>new Promise(resolve=>app.server.close(resolve)));const base='http://127.0.0.1:'+app.server.address().port;
  const response=await fetch(base+'/api/setup',{method:'POST',headers:{Origin:'http://catalog.test','Content-Type':'application/json'},body:JSON.stringify({name:'Catalog Owner',email:'catalog@example.com',password:'Catalog-Password-123',referenceCatalog:true})});assert.equal(response.status,201);assert.equal(app.db.prepare('SELECT count(*) n FROM menu_items').get().n,6);assert.equal(app.db.prepare('SELECT count(*) n FROM dining_tables').get().n,10);assert.equal(app.db.prepare('SELECT count(*) n FROM transactions').get().n,0);assert.equal(app.db.prepare('SELECT count(*) n FROM customers').get().n,0);
});

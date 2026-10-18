// Disposable UI test server. No production database or SMTP delivery is used.
const {createApp}=require('../backend/app.cjs');
const {hashPassword}=require('../backend/security.cjs');
const catalog=require('../backend/reference-catalog.cjs');
(async()=>{
  const app=createApp({dbPath:':memory:',baseUrl:'http://localhost:4180',mailTransport:{async sendMail(){return {messageId:'test-only'}}},mailFrom:'test@example.com'}),db=app.db;
  db.prepare("INSERT INTO users(name,email,password_hash,role,status,created_at) VALUES (?,?,?,'Admin','Active',?)").run('UI Test Administrator','qa@example.com',await hashPassword('QA-Only-Password-123'),new Date().toISOString());
  for(const [name,description,price,category,image] of catalog.menu)db.prepare('INSERT INTO menu_items(name,description,price_cents,category,image) VALUES (?,?,?,?,?)').run(name,description,price*100,category,image);
  catalog.seats.forEach((seats,i)=>db.prepare('INSERT INTO dining_tables(seats,status) VALUES (?,?)').run(seats,['Occupied','Available','Reserved','Occupied','Available'][i%5]));
  for(const name of ['Rica Gonzaga','Marie Tobongbanua','Josie Bagasic','Mika Fernandez','Kurt Lapid','Mary Castillo'])db.prepare('INSERT INTO customers(name,phone,email,visits) VALUES (?,?,?,?)').run(name,'+63 917 123 4567',name.split(' ')[0].toLowerCase()+'@example.com',24);
  for(const [id,cid,tid,status,items] of [[3091,1,4,'Served',[[1,2],[4,1],[5,1]]],[3090,2,2,'Preparing',[[2,2],[4,2]]],[3089,3,8,'Pending',[[3,1],[6,1]]],[3088,4,1,'Served',[[2,1],[5,1]]]]){
    db.prepare('INSERT INTO orders(id,customer_id,customer_name,table_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,cid,db.prepare('SELECT name FROM customers WHERE id=?').get(cid).name,tid,status,new Date().toISOString(),new Date().toISOString());
    for(const [mid,qty] of items){const m=db.prepare('SELECT * FROM menu_items WHERE id=?').get(mid);db.prepare('INSERT INTO order_items(order_id,menu_id,name,price_cents,qty) VALUES (?,?,?,?,?)').run(id,mid,m.name,m.price_cents,qty)}
  }
  app.server.listen(4180,'127.0.0.1',()=>console.log('Disposable UI verification server: http://localhost:4180/login/index.html'));
  process.on('SIGINT',()=>app.server.close(()=>process.exit(0)));
})();

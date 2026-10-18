'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../shared/app.js'),'utf8');
function context(page){
  const calls=[],user={id:1,name:'Test Owner',email:'owner@example.com',role:'Admin',status:'Active'};
  const fixture={user,csrf:'csrf-test',mailConfigured:true,customers:[{id:1,name:'Rica Gonzaga',phone:'123',email:'test@example.com',visits:1,last:'2026-10-18',version:1}],menu:[{id:1,name:'Pasta Carbonara',price:180,description:'Pasta',category:'Food',available:true,image:'pasta',version:1}],tables:[{id:1,seats:4,status:'Occupied',version:1}],orders:[{id:'DF-1',customer:1,customerName:'Rica Gonzaga',table:1,status:'Served',items:[{id:1,name:'Pasta Carbonara',price:180,qty:2}],version:1}],transactions:[],profile:{name:'Dine Flow',address:'Test Address',phone:'123',email:'contact@example.com'},preferences:{email:true,print:false,dark:false},team:[user],requests:[],metrics:{revenue:0,totalOrders:1,completed:0,average:0,topItem:'—',revenueChange:0,orderChange:0,averageChange:0,weekly:Array.from({length:7},(_,i)=>({date:'2026-10-'+(12+i),label:'Day',amount:0}))}};
  const bill={orderId:'DF-1',version:1,table:1,customer:'Rica Gonzaga',items:fixture.orders[0].items,subtotal:360,vat:43.2,total:403.2,paid:false,method:'Cash',profile:fixture.profile};
  const node={innerHTML:'',value:'',values:{},disabled:false,focus(){},remove(){},append(){},appendChild(){},setAttribute(){},querySelector(){return node},querySelectorAll(){return []},addEventListener(){},classList:{toggle(){}}};
  const listeners={};const document={body:{dataset:{page},innerHTML:'',classList:{toggle(){}},append(){},prepend(){}},head:{append(){}},activeElement:null,addEventListener:(event,fn)=>listeners[event]=fn,querySelector(){return null},getElementById(){return null},createElement(){return node}};
  class FD{constructor(form){this.values=form?.values||{}}get(k){const v=this.values[k];return Array.isArray(v)?v[0]:v}getAll(k){const v=this.values[k];return Array.isArray(v)?v:v===undefined?[]:[v]}has(k){return k in this.values}*[Symbol.iterator](){for(const [k,v] of Object.entries(this.values))yield [k,v]}}
  const store={};const ctx=vm.createContext({document,console,URL,URLSearchParams,Blob,crypto:require('node:crypto').webcrypto,FormData:FD,sessionStorage:{getItem:k=>store[k],setItem:(k,v)=>store[k]=v,removeItem:k=>delete store[k]},location:{hash:'',pathname:'/'+page+'/index.html'},history:{replaceState(){}},setTimeout(){},setInterval(){},window:{print(){}},fetch:async(url,options={})=>{calls.push({url,options,data:options.body?JSON.parse(options.body):null});let value=url==='/api/session'?{user,csrf:'csrf-test',setupRequired:false}:url==='/api/bootstrap'?structuredClone(fixture):url.startsWith('/api/billing/')?bill:url==='/api/auth/token-info'?{purpose:'reset'}:{id:2,message:'Success'};return {ok:true,status:200,json:async()=>value}}});
  vm.runInContext(source,ctx);return {ctx,node,document,listeners,calls,fixture};
}
test('all 12 pages render with server data and retain valid page folders and assets',async()=>{
  for(const page of ['login','forgot-password','request-account','reset-password','dashboard','customers','menu','orders','tables','billing','reports','settings']){
    const c=context(page);await new Promise(setImmediate);assert.ok(c.document.body.innerHTML.includes(['login','forgot-password','request-account','reset-password'].includes(page)?'Welcome Back':'<main>'),page);
    for(const match of c.document.body.innerHTML.matchAll(/(?:href|src)="(\.\.\/[^"?#]+)"/g))assert.ok(fs.existsSync(path.resolve(__dirname,'..',page,match[1])),page+': '+match[1]);
    if(!['login','forgot-password','request-account','reset-password'].includes(page))assert.equal(vm.runInContext('orderAmount(db.orders[0])',c.ctx),360);
  }
});
test('customer, menu, and table forms save through authenticated API endpoints',async()=>{
  for(const [page,editor,values,endpoint] of [
    ['customers','customerEditor',{name:'New Person',phone:'123',email:'new@example.com',visits:'0'},'/api/customers'],
    ['menu','itemEditor',{name:'New Dish',description:'Dish',price:'100',category:'Food',available:'true'},'/api/menu'],
    ['tables','tableEditor',{seats:'4',status:'Available'},'/api/tables']]){
    const c=context(page);await new Promise(setImmediate);vm.runInContext(editor+'()',c.ctx);c.node.values=values;c.node.onsubmit({target:c.node,preventDefault(){}});await new Promise(setImmediate);
    const call=c.calls.find(x=>x.url===endpoint&&x.options.method==='POST');assert.ok(call,endpoint);assert.equal(call.options.headers['X-CSRF-Token'],'csrf-test');
  }
});
test('icon-only sidebar navigation keeps accessible names at narrow widths',async()=>{
  const c=context('dashboard');await new Promise(setImmediate);
  for(const name of ['Dashboard','Customers','Menu','Orders','Tables','Billing','Reports','Settings','Logout'])assert.ok(c.document.body.innerHTML.includes('aria-label="'+name+'"'),name+' navigation needs a persistent accessible name');
});
test('login and account request forms call the backend; no password is stored in browser data',async()=>{
  const c=context('login');await new Promise(setImmediate);c.node.values={email:'owner@example.com',password:'test-password-value'};c.node.id='login-form';c.listeners.submit({target:c.node,preventDefault(){}});await new Promise(setImmediate);assert.ok(c.calls.some(x=>x.url==='/api/auth/login'));assert.equal(c.ctx.location.href,'../dashboard/index.html');
  const request=context('request-account');await new Promise(setImmediate);request.node.values={name:'New Staff',email:'staff@example.com',role:'Staff',message:'Test'};request.node.onsubmit({target:request.node,preventDefault(){}});await new Promise(setImmediate);assert.ok(request.calls.some(x=>x.url==='/api/account-requests'));
  assert.ok(!source.includes('localStorage'));assert.ok(!source.includes('dineflow123'));
});

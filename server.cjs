'use strict';
const fs=require('node:fs'),path=require('node:path');
if(fs.existsSync(path.join(__dirname,'.env')))process.loadEnvFile(path.join(__dirname,'.env'));
const {createApp}=require('./backend/app.cjs');
if(require.main===module){
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT||4173);
  if(!['127.0.0.1','localhost','::1'].includes(host)&&(!process.env.SETUP_SECRET||process.env.COOKIE_SECURE!=='true'||!process.env.APP_URL?.startsWith('https://'))){console.error('Remote hosting requires HTTPS APP_URL, COOKIE_SECURE=true, and SETUP_SECRET.');process.exit(1)}
  const app=createApp();
  app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?`Port ${port} is in use. Stop the previous DineFlow server and restart.`:e.message);process.exitCode=1});
  app.server.listen(port,host,()=>console.log(`DineFlow: ${process.env.APP_URL||`http://${host}:${port}`}\nDatabase connected. ${app.mail.configured?'SMTP configured.':'Gmail SMTP not configured yet.'}`));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.server.close(()=>process.exit(0)));
}
module.exports={createApp};

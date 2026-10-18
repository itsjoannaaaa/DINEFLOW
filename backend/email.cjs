'use strict';
function createMailer(config={}){
  const configured=!!(config.transport||(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASS&&process.env.MAIL_FROM));
  let transport=config.transport;
  if(configured&&!transport){
    transport=require('nodemailer').createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||465),secure:process.env.SMTP_SECURE!=='false',requireTLS:process.env.SMTP_SECURE==='false',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,disableFileAccess:true,disableUrlAccess:true});
  }
  async function send(to,subject,text){if(!configured)throw new Error('Email is not configured.');return transport.sendMail({from:config.from||process.env.MAIL_FROM,to,subject,text,disableFileAccess:true,disableUrlAccess:true})}
  return {configured,send};
}
module.exports={createMailer};

'use strict';
// Run interactively on the restaurant's computer. App Password input is hidden.
const fs=require('node:fs'),path=require('node:path');
const readline=require('node:readline/promises');
async function secret(){
  if(!process.stdin.isTTY)throw Error('Run CONFIGURE GMAIL.bat in an interactive terminal.');
  process.stdout.write('Google App Password (hidden): ');process.stdin.setRawMode(true);process.stdin.resume();let result='';
  return new Promise((resolve,reject)=>{const handler=chunk=>{for(const char of chunk.toString()){if(char==='\r'||char==='\n'){cleanup();return resolve(result)}if(char==='\u0003'){cleanup();return reject(Error('Cancelled.'))}if(char==='\u007f'||char==='\b')result=result.slice(0,-1);else if(char.charCodeAt(0)>=32)result+=char}};function cleanup(){process.stdin.removeListener('data',handler);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n')}process.stdin.on('data',handler)})
}
async function main(){
  console.log('Create the Gmail account first: https://accounts.google.com/signup');
  console.log('Enable 2-Step Verification, then create an App Password: https://myaccount.google.com/apppasswords');
  console.log('Enter the App Password here, not in chat. Your normal Gmail password is not used.');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});const email=(await rl.question('Gmail address: ')).trim().toLowerCase();rl.close();
  if(!/^[a-z0-9._%+-]+@gmail\.com$/.test(email))throw Error('Enter your personal @gmail.com address.');
  const pass=(await secret()).replace(/\s/g,'');if(!/^[a-zA-Z0-9]{16}$/.test(pass))throw Error('Use the 16-character Google App Password.');
  const transport=require('nodemailer').createTransport({host:'smtp.gmail.com',port:465,secure:true,auth:{user:email,pass},connectionTimeout:15000,greetingTimeout:15000,socketTimeout:15000});
  process.stdout.write('Checking Gmail SMTP connection... ');await transport.verify();transport.close();console.log('connected.');
  const root=path.resolve(__dirname,'..'),filename=path.join(root,'.env');let content=fs.readFileSync(fs.existsSync(filename)?filename:path.join(root,'.env.example'),'utf8');
  for(const [key,value] of Object.entries({SMTP_HOST:'smtp.gmail.com',SMTP_PORT:'465',SMTP_SECURE:'true',SMTP_USER:email,SMTP_PASS:pass,MAIL_FROM:`"DineFlow <${email}>"`})){
    const pattern=new RegExp('^'+key+'=.*$','m');content=pattern.test(content)?content.replace(pattern,key+'='+value):content+'\n'+key+'='+value;
  }
  fs.writeFileSync(filename,content,{mode:0o600});console.log('Gmail settings saved privately to .env. Restart DineFlow to enable email delivery.');
}
main().catch(error=>{console.error('Gmail configuration could not complete:',error.code||error.message);process.exitCode=1});

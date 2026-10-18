'use strict';
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
const hashToken=token=>crypto.createHash('sha256').update(token).digest('hex');
const randomToken=()=>crypto.randomBytes(32).toString('hex');
function fail(status,message){const error=new Error(message);error.status=status;throw error}
function text(value,label,max=200,optional=false){if(typeof value!=='string'||value.trim().length>max||(!optional&&!value.trim()))fail(400,`${label} is required and must be at most ${max} characters.`);return value.trim()}
function email(value){const result=text(value,'Email',254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)||/[\r\n]/.test(result))fail(400,'Enter a valid email address.');return result}
function password(value){if(typeof value!=='string'||value.length<12||value.length>128)fail(400,'Use a password between 12 and 128 characters.');return value}
function integer(value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)fail(400,`${label} must be a whole number between ${min} and ${max}.`);return value}
function cents(value,label='Amount'){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>10000000||Math.abs(value*100-Math.round(value*100))>0.00001)fail(400,`${label} must be a valid amount with up to two decimal places.`);return Math.round(value*100)}
async function hashPassword(value){const salt=crypto.randomBytes(16).toString('hex');const derived=await scrypt(value,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return `scrypt$${salt}$${derived.toString('hex')}`}
async function verifyPassword(value,stored){const [,salt,key]=(stored||'').split('$');const derived=await scrypt(String(value),salt||'dineflow-dummy-salt',64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return !!key&&key.length===128&&crypto.timingSafeEqual(derived,Buffer.from(key,'hex'))}
module.exports={fail,text,email,password,integer,cents,hashPassword,verifyPassword,hashToken,randomToken};

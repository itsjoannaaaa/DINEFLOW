'use strict';
const fs=require('node:fs'),path=require('node:path');
const {DatabaseSync,backup}=require('node:sqlite');
const root=path.resolve(__dirname,'..');if(fs.existsSync(path.join(root,'.env')))process.loadEnvFile(path.join(root,'.env'));
const source=path.resolve(root,process.env.DB_PATH||'data/dineflow.sqlite');if(!fs.existsSync(source))throw Error('Start DineFlow first to create its database.');
fs.mkdirSync(path.join(root,'backups'),{recursive:true});const destination=path.join(root,'backups',`dineflow-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
const db=new DatabaseSync(source);backup(db,destination).then(()=>{db.close();console.log('Database backup saved:',destination)}).catch(e=>{db.close();console.error(e.message);process.exitCode=1});

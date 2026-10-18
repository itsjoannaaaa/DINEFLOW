const result=require('node:child_process').spawnSync(process.execPath,['--test','tests/backend.test.cjs','tests/frontend.test.cjs'],{stdio:'inherit'}).status;
process.exitCode=result||0;

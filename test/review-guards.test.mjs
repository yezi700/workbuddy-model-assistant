import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {loadConfig} from '../src/config.mjs';import {writeFileAtomic} from '../src/util.mjs';

async function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-guards-'));let paid=0;const tokens=[];
 const mock=http.createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  const json=(status,o)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(o));};
  if(req.url.endsWith('/enterprises/personal/models'))return json(200,{code:0,data:{models:['paid','safe','limited','quota'].map(id=>({id,credits:'x1.65',maxInputTokens:100000}))}});
  if(req.url.endsWith('/get-user-resource'))return json(200,{code:0,data:{Response:{Data:{Accounts:[{CapacityRemain:req.headers.authorization==='Bearer B'?90:10}]}}}});
  if(req.url==='/v2/chat/completions'){
   const m=JSON.parse(body).model;tokens.push(req.headers.authorization);
   if(m==='paid')paid++;
   if(m==='limited'){res.setHeader('Retry-After','2');return json(429,{msg:'rate limit exceeded'});}
   if(m==='quota')return json(429,{msg:'insufficient credits'});
   res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta:{content:'mock reply'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
  }json(404,{});
 });
 await new Promise(r=>mock.listen(0,'127.0.0.1',r));const up='http://127.0.0.1:'+mock.address().port;
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const cfg={host:'127.0.0.1',port,apiKey:'mock-guards-key',defaultSite:'cn-cli',defaultModel:'safe',routing:{fallbackMode:'off'},modelAliases:{alias:'cn-cli/paid'},context:{enabled:false},sites:{'cn-cli':{enabled:true,apiBase:up,billingBase:up,origin:up,userAgent:'mock'},'intl-cli':{enabled:false},'intl-work':{enabled:false}},timeouts:{metaMs:1000,headerMs:1000,idleMs:1000},routingPolicies:[{model:'paid',site:'cn-cli',requireFree:true,fallbackMode:'off',fallbackSites:[],schedule:{enabled:true,start:'25:00',end:'08:00',site:'cn-cli',outside:'block'}}]};
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(cfg));
 fs.writeFileSync(path.join(dir,'auth.cn-cli.pool.json'),JSON.stringify({version:1,accounts:['A','B'].map(id=>({id,uid:id,label:id,accessToken:id,refreshToken:'unused',enabled:true,expiresAt:Date.now()+86400000}))}));
 const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,WB_CONFIG_DIR:dir},stdio:'ignore'});
 t.after(async()=>{const exited=once(child,'exit');child.kill();await exited;await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port,headers={Authorization:'Bearer mock-guards-key','Content-Type':'application/json'};
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
 return {dir,get:async p=>(await fetch(base+'/console/api'+p,{headers})).json(),post:(p,b)=>fetch(base+p,{method:'POST',headers,body:JSON.stringify(b)}),paid:()=>paid,tokens};
}
test('损坏的费用保护阻断三个协议、别名和探测，其他模型正常；保存后仍阻断',async t=>{
 const f=await fixture(t);
 for(const [p,b] of [['/v1/chat/completions',{model:'alias',messages:[{role:'user',content:'test'}]}],['/v1/responses',{model:'cn-cli/paid',input:'test'}],['/v1/messages',{model:'paid',max_tokens:5,messages:[{role:'user',content:'test'}]}]]){const r=await f.post(p,b);assert.equal(r.status,403);await r.text();}
 const probe=await f.post('/console/api/probe',{targets:[{site:'cn-cli',model:'paid'}]});await probe.text();assert.equal(f.paid(),0);
 const normal=await f.post('/v1/chat/completions',{model:'safe',messages:[{role:'user',content:'test'}]});assert.equal(normal.status,200);await normal.text();
 const save=await f.post('/console/api/default-model',{site:'cn-cli',model:'safe'});assert.equal(save.status,200);await save.text();
 assert.ok(loadConfig(f.dir).blockedRoutingModels.paid);
 const fix=await f.post('/console/api/routing',{policies:[{model:'paid',site:'cn-cli',requireFree:true,fallbackMode:'off',fallbackSites:[],schedule:{}}],routing:{fallbackMode:'off'},pool:{maxAccountsPerRequest:3,switchSiteOnExhausted:true}});assert.equal(fix.status,200);await fix.text();
 assert.equal((await f.get('/routing')).blocked_models.paid,undefined);
 const denied=await f.post('/v1/chat/completions',{model:'paid',messages:[{role:'user',content:'test'}]});assert.equal(denied.status,403);await denied.text();assert.equal(f.paid(),0);
});
test('余额按显示账号绑定，刷新账号列表后不会串余额',async t=>{
 const f=await fixture(t);const before=await f.get('/state');assert.equal(before.sites[0].uid,'A');assert.equal(before.sites[0].credit,10);
 await f.get('/pool?site=cn-cli');const after=await f.get('/state');assert.equal(after.sites[0].uid,'B');assert.equal(after.sites[0].credit,90);
});
test('429 临时限流遵循 Retry-After，真额度不足仍标记耗尽',async t=>{
 const f=await fixture(t);const limited=await f.post('/v1/chat/completions',{model:'limited',messages:[{role:'user',content:'test'}]});assert.equal(limited.status,429);await limited.text();
 const cooled=await f.get('/pool?site=cn-cli&credit=0');assert.ok(cooled.accounts.every(a=>!a.exhausted && a.cooldown_until));
 await new Promise(r=>setTimeout(r,2100));assert.ok((await f.get('/pool?site=cn-cli&credit=0')).accounts.every(a=>a.usable));
 const quota=await f.post('/v1/chat/completions',{model:'quota',messages:[{role:'user',content:'test'}]});assert.equal(quota.status,429);await quota.text();assert.ok((await f.get('/pool?site=cn-cli&credit=0')).accounts.every(a=>a.exhausted));
});
test('原子写在 rename 或临时写失败时保留旧文件',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-atomic-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const target=path.join(dir,'config.json'),old='{"previous":true}';fs.writeFileSync(target,old);
 const rename=fs.renameSync,write=fs.writeFileSync;
 try{fs.renameSync=()=>{throw Object.assign(new Error('busy'),{code:'EPERM'});};assert.throws(()=>writeFileAtomic(target,'{"next":true}'));assert.equal(fs.readFileSync(target,'utf8'),old);}finally{fs.renameSync=rename;}
 try{fs.writeFileSync=(file,data,options)=>{write(file,String(data).slice(0,5),options);throw Object.assign(new Error('full'),{code:'ENOSPC'});};assert.throws(()=>writeFileAtomic(target,'{"next":true}'));assert.equal(fs.readFileSync(target,'utf8'),old);}finally{fs.writeFileSync=write;}
 assert.deepEqual(fs.readdirSync(dir),['config.json']);
});
test('无法确定损坏规则影响的模型时不启动，避免丢失全部保护',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-unknown-rule-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({routingPolicies:[null]}));assert.throws(()=>loadConfig(dir),/保护费用限制/);
});

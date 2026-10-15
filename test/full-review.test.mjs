import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {modelQuotaReset,activeModelLimit} from '../src/model-quota.mjs';
import {setConfigDir} from '../src/config.mjs';import {markFailure,pickAccount,getAccount,isUsable,resetAccountState} from '../src/pool.mjs';
import {handleConsoleApi} from '../src/console-api.mjs';import {accountSnapshot} from '../src/auth.mjs';
const actualMessage='您的使用量已超出频率限制，将在 2026-10-14 10:05:43 UTC+8 重置，您也可以切换其他模型继续使用。';
test('实际 6004 错误识别到模型重置时间，普通限流不当作免费日额度',()=>{
 const now=Date.parse('2026-10-13T19:27:00+08:00');
 assert.equal(modelQuotaReset(JSON.stringify({code:6004,msg:actualMessage}),now),Date.parse('2026-10-14T10:05:43+08:00'));
 assert.equal(modelQuotaReset('too many requests, retry in 30 seconds',now),null);
 assert.equal(modelQuotaReset('maximum context length exceeded',now),null);
});
test('日额度只暂停指定模型，重置后自动恢复；账号健康快照不显示过期耗尽',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-model-limit-')),restore=setConfigDir(dir);t.after(()=>{restore();fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'auth.cn-cli.pool.json'),JSON.stringify({accounts:[{id:'A',enabled:true,accessToken:'mock'},{id:'B',enabled:true,accessToken:'mock',exhaustedAt:Date.now()-7*3600000}]}));
 markFailure('cn-cli','A',{status:429,message:'免费额度已用完',model:'step'});
 const a=getAccount('cn-cli','A');assert.ok(activeModelLimit(a,'step'));assert.equal(isUsable(a,Date.now(),'step'),false);assert.equal(isUsable(a,Date.now(),'other'),true);
 assert.equal(pickAccount('cn-cli',{model:'step',fallback:true}).id,'B');assert.equal(isUsable(a,a.modelLimits.step.until+1,'step'),true);
 assert.equal(accountSnapshot('cn-cli').find(a=>a.id==='B').exhausted,false);
 resetAccountState('cn-cli','A');assert.equal(activeModelLimit(getAccount('cn-cli','A'),'step'),null);
});
test('保存规则的磁盘写入失败不能改变内存中的免费保护',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-config-rollback-')),restore=setConfigDir(dir);t.after(()=>{restore();fs.rmSync(dir,{recursive:true,force:true});});
 const policy={model:'step',site:'cn-cli',enabled:true,requireFree:true,fallbackMode:'off',fallbackSites:[],schedule:{}};
 const cfg={sites:{'cn-cli':{}},routingPolicies:[policy],routing:{fallbackMode:'off'},pool:{maxAccountsPerRequest:3,switchSiteOnExhausted:true}};
 const previous=structuredClone(cfg);fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify(cfg));
 let status;const res={writeHead:s=>{status=s;},end:()=>{},headersSent:false};const rename=fs.renameSync;
 try{fs.renameSync=()=>{throw Error('mock disk failure');};await handleConsoleApi({cfg,req:{method:'POST'},res,url:new URL('http://localhost/console/api/routing'),body:{policies:[{...policy,requireFree:false}],routing:{fallbackMode:'listed'},pool:{maxAccountsPerRequest:1,switchSiteOnExhausted:false}}});}finally{fs.renameSync=rename;}
 assert.equal(status,400);assert.deepEqual(cfg,previous);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'config.json'),'utf8')),previous);
});
async function fixture(t,{paidFallback=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-switch-review-')),calls=[];
 const reset=new Date(Date.now()+86400000).toISOString().slice(0,19).replace('T',' ')+' UTC+0';
 const msg=`您的使用量已超出频率限制，将在 ${reset} 重置，您也可以切换其他模型继续使用。`;
 const mock=http.createServer(async(req,res)=>{
  let raw='';for await(const c of req)raw+=c;
  if(req.url.endsWith('/enterprises/personal/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{id:'step',credits:paidFallback&&req.headers.authorization!=='Bearer A'?'x1.65':'x0',maxInputTokens:100000}]}));return;}
  if(req.url==='/v2/chat/completions'){
   const token=req.headers.authorization;calls.push(token);
   if(token==='Bearer A'){res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({code:6004,msg}));return;}
   res.setHeader('Content-Type','text/event-stream');
   if(token==='Bearer B'){res.end('data: '+JSON.stringify({code:6004,msg})+'\n\n');return;}
   res.end('data: '+JSON.stringify({choices:[{delta:{content:'mock success'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;
  }res.writeHead(404);res.end();
 });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));const up='http://127.0.0.1:'+mock.address().port;
 const site={enabled:true,apiBase:up,origin:up,userAgent:'mock'};
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({host:'127.0.0.1',port,apiKey:'mock-switch',defaultSite:'cn-cli',defaultModel:'step',pool:{maxAccountsPerRequest:3,switchSiteOnExhausted:true},sites:{'cn-cli':site,'intl-work':site,'intl-cli':{enabled:false}},routingPolicies:[{model:'step',site:'cn-cli',requireFree:true,fallbackMode:'freeOnly',fallbackSites:['intl-work'],schedule:{}}]}));
 for(const [site,ids] of [['cn-cli',['A']],['intl-work',['B','C']]])fs.writeFileSync(path.join(dir,`auth.${site}.pool.json`),JSON.stringify({accounts:ids.map(id=>({id,uid:id,accessToken:id,enabled:true,expiresAt:Date.now()+86400000}))}));
 const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,WB_CONFIG_DIR:dir},stdio:'ignore'});
 t.after(async()=>{const exited=once(child,'exit');child.kill();await exited;await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
 return {calls,dir,post:(p,b)=>fetch(base+p,{method:'POST',headers:{Authorization:'Bearer mock-switch','Content-Type':'application/json'},body:JSON.stringify(b)})};
}
test('真实错误结构跨国内账号、国际账号轮换，三个协议成功且不再撞受限账号',async t=>{
 const f=await fixture(t);
 for(const [p,b] of [['/v1/chat/completions',{model:'step',messages:[{role:'user',content:'mock'}]}],['/v1/responses',{model:'step',input:'mock'}],['/v1/messages',{model:'step',max_tokens:1024,messages:[{role:'user',content:'mock'}]}]]){const r=await f.post(p,b);assert.equal(r.status,200);assert.match(await r.text(),/mock success/);}
 assert.deepEqual(f.calls,['Bearer A','Bearer B','Bearer C','Bearer C','Bearer C']);
 const a=JSON.parse(fs.readFileSync(path.join(f.dir,'auth.cn-cli.pool.json'),'utf8')).accounts[0];assert.ok(a.modelLimits.step.until>Date.now());assert.equal(a.exhaustedAt,undefined);
});
test('免费渠道都不可用时停止，429 不绕过免费保护调用收费备用渠道',async t=>{
 const f=await fixture(t,{paidFallback:true});const r=await f.post('/v1/chat/completions',{model:'step',messages:[{role:'user',content:'mock'}]});assert.equal(r.status,429);await r.text();assert.deepEqual(f.calls,['Bearer A']);
 const next=await f.post('/v1/chat/completions',{model:'step',messages:[{role:'user',content:'mock'}]});const error=(await next.json()).error;assert.equal(error.type,'insufficient_quota');assert.equal(error.retryable,false);assert.equal(error.accounts.total,1);assert.equal(error.accounts.available,0);
});

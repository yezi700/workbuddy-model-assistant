import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';import {once} from 'node:events';
import {applyModelParameters,validateParameters,parameterCapabilities} from '../src/model-parameters.mjs';
import {applyContextFit} from '../src/upstream.mjs';import {estimateMessages,learnLimit} from '../src/compress.mjs';import {loadConfig} from '../src/config.mjs';
const info={reasoningEfforts:['low','medium','high'],reasoningDefault:'high',contextLengths:[4096,8192],contextWindow:8192,contextDefault:4096};
test('渠道参数隔离，客户端显式参数优先；只发送思考字段，窗口用于本地处理',()=>{
 const cfg={modelParameters:{'cn-cli/m':{reasoning_effort:'low',context_window:4096},'intl-work/m':{reasoning_effort:'high',context_window:8192}}};
 assert.equal(applyModelParameters(cfg,'cn-cli',{model:'m'},info).body.reasoning_effort,'low');
 assert.equal(applyModelParameters(cfg,'intl-work',{model:'m'},info).body.reasoning_effort,'high');
 const result=applyModelParameters(cfg,'cn-cli',{model:'m',reasoning:{effort:'medium'},context_window:8192},info);
 assert.equal(result.body.reasoning_effort,'medium');assert.equal(result.body.reasoning,undefined);assert.equal(result.body.context_window,undefined);assert.equal(result.contextWindow,8192);
 assert.throws(()=>validateParameters({reasoning_effort:'max'},info),/不支持/);assert.throws(()=>validateParameters({context_window:1000000},info),/不支持/);assert.throws(()=>validateParameters({context_window:'4096'}),/有效/);
 assert.deepEqual(parameterCapabilities({}).efforts,[]);
});
test('显式小窗口即使自动压缩关闭也生效，且不突破已知渠道上限',()=>{
 learnLimit('parameter-test','m',8192);
 const body={model:'m',max_tokens:256,messages:[{role:'system',content:'Keep this system prompt'},...Array.from({length:8},(_,i)=>({role:i%2?'assistant':'user',content:'long old history '.repeat(2000)})),{role:'user',content:'latest question'}]};
 const before=estimateMessages(body.messages);const stats=applyContextFit({context:{enabled:false}},body,{site:'parameter-test',selectedWindow:4096});
 assert.equal(stats.limit,4096);assert.ok(estimateMessages(body.messages)<before);assert.equal(body.messages[0].content,'Keep this system prompt');assert.equal(body.messages.at(-1).content,'latest question');
 const bigger=applyContextFit({}, {model:'m',messages:[{role:'user',content:'x'.repeat(70000)}]},{site:'parameter-test',selectedWindow:1000000});assert.equal(bigger.limit,8192);
});
test('控制台保存、拒绝非法档位、三种协议线上的参数与窗口裁剪、恢复默认',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-params-')),requests=[];
 const mock=http.createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  if(req.url.endsWith('/enterprises/personal/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{id:'m',credits:'x0',maxInputTokens:8192,maxOutputTokens:2048,contextWindow:{defaultLength:4096,supportedLengths:[4096,8192]},reasoning:{defaultEffort:'high',supportedEfforts:['low','medium','high']}}]}));return;}
  if(req.url==='/v2/chat/completions'){requests.push(JSON.parse(text));res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content:'mock reply'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return;}
  res.writeHead(404);res.end();
 });await new Promise(r=>mock.listen(0,'127.0.0.1',r));
 const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
 const up='http://127.0.0.1:'+mock.address().port;
 fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({host:'127.0.0.1',port,apiKey:'mock-model-settings',defaultSite:'cn-cli',defaultModel:'m',context:{enabled:false},sites:{'cn-cli':{apiBase:up,origin:up,userAgent:'mock'},'intl-cli':{enabled:false},'intl-work':{enabled:false}},routing:{fallbackMode:'off'},routingPolicies:[{model:'m',site:'cn-cli',requireFree:true,fallbackMode:'off',fallbackSites:[],schedule:{}}]}));
 fs.writeFileSync(path.join(dir,'auth.cn-cli.pool.json'),JSON.stringify({version:1,accounts:[{id:'a',uid:'a',enabled:true,accessToken:'mock',expiresAt:Date.now()+86400000}]}));
 const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,WB_CONFIG_DIR:dir},stdio:'ignore'});
 t.after(async()=>{const exit=once(child,'exit');child.kill();await exit;await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port,headers={Authorization:'Bearer mock-model-settings','Content-Type':'application/json'};
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,30));}
 const post=async(p,b)=>{const r=await fetch(base+p,{method:'POST',headers,body:JSON.stringify(b)});return {status:r.status,text:await r.text()};};
 assert.equal((await post('/console/api/model-parameters',{site:'cn-cli',model:'m',parameters:{reasoning_effort:'max'}})).status,400);
 assert.equal((await post('/console/api/model-parameters',{site:'cn-cli',model:'m',parameters:{reasoning_effort:'low',context_window:4096}})).status,200);
 assert.equal(loadConfig(dir).modelParameters['cn-cli/m'].reasoning_effort,'low');
 const large='long history '.repeat(10000);
 for(const [p,b] of [['/v1/chat/completions',{model:'m',max_tokens:256,messages:[{role:'user',content:large}]}],['/v1/responses',{model:'m',max_output_tokens:256,reasoning:{effort:'medium'},input:large}],['/v1/messages',{model:'m',max_tokens:256,output_config:{effort:'high'},messages:[{role:'user',content:large}]}]])assert.equal((await post(p,b)).status,200);
 assert.deepEqual(requests.map(r=>r.reasoning_effort),['low','medium','high']);assert.ok(requests.every(r=>!('context_window' in r)&&estimateMessages(r.messages)<4096));
 assert.equal((await post('/v1/responses',{model:'m',input:'test',reasoning:{effort:'max'}})).status,400);assert.equal(requests.length,3);
 assert.equal((await post('/console/api/model-parameters',{site:'cn-cli',model:'m',parameters:{}})).status,200);
 assert.equal(loadConfig(dir).modelParameters['cn-cli/m'],undefined);
 assert.equal((await post('/v1/chat/completions',{model:'m',messages:[{role:'user',content:'test'}]})).status,200);assert.equal(requests.at(-1).reasoning_effort,undefined);
});

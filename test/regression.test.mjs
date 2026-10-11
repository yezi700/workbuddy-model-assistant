import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { scheduleActive, preferredSite, validatePolicies, routeCandidates } from '../src/routing-policy.mjs';
import { openRoutedChat } from '../src/routed-chat.mjs';
import { inspectOpening } from '../src/upstream.mjs';

const schedule = { enabled: true, timezone:'Asia/Shanghai', start:'23:00', end:'08:00', startDate:'2026-09-11', endDate:'2026-10-31', site:'cn-cli', outside:'block' };
test('夜间活动边界：起始晚间、凌晨、结束晚间、到期后', () => {
  for (const [date, expected] of [['2026-09-11T07:00:00+08:00',false],['2026-09-11T23:00:00+08:00',true],['2026-10-12T07:59:00+08:00',true],['2026-10-12T08:00:00+08:00',false],['2026-10-12T22:59:00+08:00',false],['2026-10-31T23:00:00+08:00',true],['2026-11-01T07:59:00+08:00',true],['2026-11-01T08:00:00+08:00',false]]) assert.equal(scheduleActive(schedule, new Date(date)), expected, date);
  assert.throws(() => preferredSite({model:'hy4-preview',site:'cn-cli',schedule}, new Date('2026-10-12T12:00:00+08:00')), /暂停/);
});
test('规则校验拒绝重复模型、非法日期与时刻', () => {
  const p = {model:'m',site:'a',fallbackSites:[],fallbackMode:'off',schedule:{}};
  assert.throws(() => validatePolicies([p,p],{a:{}}));
  assert.throws(() => validatePolicies([{...p,schedule:{...schedule,startDate:'2026-02-30'}}],{a:{},'cn-cli':{}}));
  assert.throws(() => validatePolicies([{...p,schedule:{...schedule,start:'25:00'}}],{a:{},'cn-cli':{}}));
});
test('未知价格与非零价格不会成为免费备用；名单外不可切换', async () => {
  const cfg={sites:{a:{},b:{},c:{},d:{}},routing:{fallbackMode:'freeOnly'},pool:{}};
  const getCatalog=async(_,s)=>({models:new Map([['m',{credits:{a:'x0.1',b:null,c:'x0.00 credits',d:'x0.1'}[s]}]])});
  const deps={getCatalog,loggedIn:()=>true};
  let r=await routeCandidates(cfg,{site:'a',model:'m'},deps);
  assert.deepEqual(r.fallbacks.map(x=>x.site),['c']);
  cfg.routingPolicies=[{model:'m',site:'a',fallbackMode:'listed',fallbackSites:['b'],schedule:{},requireFree:false}];
  r=await routeCandidates(cfg,{site:'a',model:'m'},deps);
  assert.deepEqual(r.fallbacks.map(x=>x.site),['b']);
  cfg.routingPolicies[0].requireFree=true;
  await assert.rejects(routeCandidates(cfg,{site:'a',model:'m'},deps),/暂停/);
});
test('多备用站点顺序、额度开关、取消和普通参数错误', async () => {
  const target={site:'a',model:'m',fallbacks:[{site:'b',model:'m'},{site:'c',model:'m'}]};
  const calls=[];
  const open=async(_,site)=>{calls.push(site);return {up:site==='c'?{ok:true}:{ok:false,status:402,text:'quota exhausted'}}};
  const r=await openRoutedChat({pool:{switchSiteOnExhausted:true}},target,{},{open});
  assert.equal(r.site,'c'); assert.deepEqual(calls,['a','b','c']);
  calls.length=0;
  await openRoutedChat({pool:{switchSiteOnExhausted:false}},target,{},{open});
  assert.deepEqual(calls,['a']);
  calls.length=0;
  await openRoutedChat({pool:{}},target,{},{open:async(_,s)=>{calls.push(s);return {up:{ok:false,status:400,text:'bad request'}}}});
  assert.deepEqual(calls,['a']);
  await assert.rejects(openRoutedChat({pool:{}},target,{},{signal:AbortSignal.abort(new Error('cancel')),open}),/cancel/);
});
test('HTTP 200 的首段业务额度错误会触发切换；正常帧原样回放', async () => {
  let closed=false;
  const failure=await inspectOpening({ok:true,site:'a',accountId:'one',close:()=>{closed=true},frames:(async function*(){yield JSON.stringify({choices:[{delta:{role:'assistant'}}]});yield JSON.stringify({code:123,msg:'insufficient credits'});})()});
  assert.equal(failure.ok,false);assert.equal(failure.status,429);assert.equal(closed,true);
  const payloads=[JSON.stringify({choices:[{delta:{role:'assistant'}}]}),JSON.stringify({choices:[{delta:{content:'ok'}}]}),'tail'];
  const success=await inspectOpening({ok:true,close(){},frames:(async function*(){yield*payloads;})()});
  assert.deepEqual(await Array.fromAsync(success.frames),payloads);
});

test('真实 HTTP 模拟上游：三个协议同站点换号、跨站点换号与禁用回退', async t => {
  const calls=[]; let failing='A'; let alternateFails=false;
  const upstream=http.createServer(async(req,res)=>{
    if(req.url.startsWith('/v2/billing/meter/get-user-resource')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:0,data:{Response:{Data:{Accounts:[{CapacityRemain:0}]}}}}));return;}
    if(req.url!='/v2/chat/completions'){res.writeHead(403);res.end('catalog unavailable');return;}
    const chunks=[];for await(const c of req)chunks.push(c);
    const token=req.headers.authorization;
    calls.push(token);
    if(token==='Bearer '+failing || (alternateFails && token==='Bearer B')){res.writeHead(402,{'Content-Type':'application/json'});res.end(JSON.stringify({msg:'insufficient credits'}));return;}
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    res.end('data: '+JSON.stringify({id:'mock',choices:[{index:0,delta:{content:'mock answer'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:2}})+'\n\ndata: [DONE]\n\n');
  });
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const upstreamUrl=`http://127.0.0.1:${upstream.address().port}`;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'wb-routing-'));
  const portServer=http.createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const cfg={host:'127.0.0.1',port,apiKey:'local-test',defaultSite:'cn-cli',defaultModel:'m',sites:{'cn-cli':{enabled:true,apiBase:upstreamUrl,billingBase:null,origin:upstreamUrl,seedModels:[{id:'m'}]},'intl-work':{enabled:true,apiBase:upstreamUrl,billingBase:null,origin:upstreamUrl,seedModels:[{id:'m'}]},'intl-cli':{enabled:false}},routing:{fallbackMode:'off'},routingPolicies:[{model:'m',site:'cn-cli',fallbackMode:'listed',fallbackSites:['intl-work'],schedule:{}}],pool:{maxAccountsPerRequest:3,switchSiteOnExhausted:true},context:{enabled:false},timeouts:{headerMs:2000,idleMs:2000,metaMs:2000},upstreamRetries:0};
  const account=(id,token)=>({id,accessToken:token,refreshToken:'unused',expiresAt:Date.now()+86400000,enabled:true});
  cfg.sites['cn-cli'].billingBase=upstreamUrl;
  fs.writeFileSync(path.join(temp,'config.json'),JSON.stringify(cfg));
  const cnFile=path.join(temp,'auth.cn-cli.pool.json');
  fs.writeFileSync(cnFile,JSON.stringify({version:1,accounts:[account('a','A'),account('b','B')]}));
  fs.writeFileSync(path.join(temp,'auth.intl-work.pool.json'),JSON.stringify({version:1,accounts:[account('c','C')]}));
  const child=spawn(process.execPath,['server.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,WB_CONFIG_DIR:temp},stdio:'ignore'});
  t.after(async()=>{child.kill();await new Promise(r=>upstream.close(r));fs.rmSync(temp,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<80;i++){try{if((await fetch(base+'/health')).ok)break;}catch{}await new Promise(r=>setTimeout(r,50));}
  const headers={'Content-Type':'application/json',Authorization:'Bearer local-test'};
  const connection=await fetch(base+'/console/api/connection',{headers});
  assert.equal(connection.status,200); assert.equal(connection.headers.get('cache-control'),'no-store');
  assert.equal((await connection.json()).api_key,'local-test');
  assert.equal((await fetch(base+'/console/api/connection')).status,401);
  assert.equal((await fetch(base+'/console/api/connection',{headers:{...headers,Origin:'https://example.com'}})).status,403);
  const state=await (await fetch(base+'/console/api/state',{headers})).json();
  assert.equal(state.selected_route.site,'cn-cli');
  assert.deepEqual(state.selected_route.fallback_sites,['intl-work']);
  const pool=await fetch(base+'/console/api/pool?site=cn-cli',{headers});
  assert.equal(pool.status,200);
  assert.equal(JSON.parse(fs.readFileSync(cnFile,'utf8')).accounts[0].exhaustedAt,undefined,'查看零余额不应标记免费账号耗尽');
  for(const endpoint of ['/v1/chat/completions','/v1/messages','/v1/responses']){
    for(const cross of [false,true]){
      calls.length=0; alternateFails=cross;
      fs.writeFileSync(cnFile,JSON.stringify({version:1,accounts:[account('a','A'),account('b','B')]}));
      const response=await fetch(base+endpoint,{method:'POST',headers,body:JSON.stringify({model:'m',stream:false,max_tokens:2048,messages:[{role:'user',content:'hello'}],input:'hello'})});
      assert.equal(response.status,200,endpoint+' '+await response.text());
      assert.deepEqual(calls,cross?['Bearer A','Bearer B','Bearer C']:['Bearer A','Bearer B'],endpoint);
    }
  }
  const opts=await fetch(base+'/console/api/routing',{method:'POST',headers,body:JSON.stringify({policies:[{model:'m',site:'cn-cli',fallbackMode:'off',fallbackSites:[],schedule:{}}],routing:{fallbackMode:'off'},pool:{maxAccountsPerRequest:3,switchSiteOnExhausted:true}})});
  assert.equal(opts.status,200);
  calls.length=0;fs.writeFileSync(cnFile,JSON.stringify({version:1,accounts:[account('a','A'),account('b','B')]}));
  const blocked=await fetch(base+'/v1/chat/completions',{method:'POST',headers,body:JSON.stringify({model:'m',messages:[{role:'user',content:'hello'}]})});
  assert.equal(blocked.status,402);assert.deepEqual(calls,['Bearer A','Bearer B']);
});

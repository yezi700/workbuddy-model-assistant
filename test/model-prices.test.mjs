import {test} from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {normalizeModelCatalog,cachedPriceModels} from '../src/model-prices.mjs';
import {catalogIdentity,writeCatalogCache,readCatalogCache} from '../src/catalog-cache.mjs';
import {setConfigDir} from '../src/config.mjs';
import http from 'node:http';
const now=Date.parse('2026-10-12T10:00:00+08:00');
const promo=(from,until)=>({enabled:true,modelIds:['m'],discount:{factor:0},schedule:{validFrom:from,validUntil:until}});
test('官方倍率与上下文正常解析，保留原始倍率',()=>{
 const [m]=normalizeModelCatalog({code:0,data:{models:[{id:'m',credits:'x1.65',maxInputTokens:272000}]}},now);
 assert.equal(m.credits,'x1.65 credits');assert.equal(m.contextWindow,272000);assert.equal(m.catalogCredits,'x1.65');
 assert.equal(normalizeModelCatalog({models:[{id:'m',credits:0}]},now)[0].credits,'x0 credits');
});
test('已过期、未来或错误日期的促销不能把零倍率判定为当前免费',()=>{
 for(const p of [promo('2026-07-06T00:00:00+08:00','2026-09-30T00:00:00+08:00'),promo('2026-11-01T00:00:00Z','2026-12-01T00:00:00Z'),promo('bad','bad')]){
  const [m]=normalizeModelCatalog({models:[{id:'m',credits:'x0.00'}],modelPromotions:[p]},now);
  assert.equal(m.credits,null);assert.equal(m.priceStatus,'inactive-promotion');assert.equal(m.catalogCredits,'x0.00');
 }
});
test('有效活动计算优惠；结束后的缓存不再用于确认免费',()=>{
 const [m]=normalizeModelCatalog({models:[{id:'m',credits:'x0.29'}],modelPromotions:[promo('2026-10-01T00:00:00Z','2026-10-13T00:00:00Z')]},now);
 assert.equal(m.credits,'x0 credits');assert.equal(cachedPriceModels([m],Date.parse('2026-10-14T00:00:00Z'))[0].credits,null);
 assert.equal(cachedPriceModels([m],now)[0].priceStatus,'stale-zero');
});
test('磁盘目录缓存按站点、账号、组织隔离，记录不包含凭据',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-price-cache-'));const restore=setConfigDir(dir);
 t.after(()=>{restore();fs.rmSync(dir,{recursive:true,force:true});});
 const cfg={sites:{'intl-work':{apiBase:'https://www.workbuddy.ai'},'cn-cli':{apiBase:'https://copilot.tencent.com'}}};
 const auth={uid:'one',accessToken:'SECRET-NOT-FOR-CACHE',enterpriseId:'org'};
 const key=catalogIdentity(cfg,'intl-work',auth);
 writeCatalogCache(key,{fetchedAt:now,models:[{id:'m',credits:'x1.65 credits'}]});
 assert.equal(readCatalogCache(key).models[0].credits,'x1.65 credits');
 assert.equal(readCatalogCache(catalogIdentity(cfg,'intl-work',{...auth,uid:'two'})),null);
 assert.equal(readCatalogCache(catalogIdentity(cfg,'cn-cli',auth)),null);
 assert.equal(readCatalogCache(catalogIdentity(cfg,'intl-work',{...auth,enterpriseId:'other'})),null);
 assert.equal(fs.readFileSync(path.join(dir,'model-catalog-cache.json'),'utf8').includes(auth.accessToken),false);
});
test('国际版使用 v2 目录；模拟进程重启、上游失败后从磁盘恢复价格',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-model-endpoint-'));const restore=setConfigDir(dir);
 t.after(()=>{restore();fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'auth.intl-work.json'),JSON.stringify({accessToken:'test-model-token',refreshToken:'test-refresh',uid:'test-user',expiresAt:Date.now()+86400000}));
 let healthy=true;const calls=[];
 const server=http.createServer((req,res)=>{
  calls.push(req.url);
  if(healthy && req.url==='/v2/enterprises/personal/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({code:0,data:{models:[{id:'m',credits:'x1.65'}]}}));}
  else{res.writeHead(503);res.end('unavailable');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const cfg={sites:{'intl-work':{apiBase:base,origin:base,userAgent:'test',seedModels:[]}},timeouts:{metaMs:1000}};
 const first=await import('../src/router.mjs?price-test-first');
 const live=await first.getCatalog(cfg,'intl-work',{force:true});
 assert.equal(live.source,'upstream');assert.deepEqual(calls,['/v2/enterprises/personal/models']);
 healthy=false;
 const restarted=await import('../src/router.mjs?price-test-restarted');
 const cached=await restarted.getCatalog(cfg,'intl-work');
 assert.equal(cached.source,'upstream(cache)');assert.equal(cached.models.get('m').credits,'x1.65 credits');
 assert.equal(cached.fetchedAt,live.fetchedAt);
});

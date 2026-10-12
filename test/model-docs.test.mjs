import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {parseModelDocument,getModelDocument,modelNameKey} from '../src/model-docs.mjs';
import {setConfigDir} from '../src/config.mjs';
import {normalizeModelCatalog} from '../src/model-prices.mjs';
import {consoleModels} from '../src/console-models.mjs';
const html='<html><table><tr><th>模型名称</th><th>简介</th><th>可用功能</th></tr><tr><td>Hy4 preview</td><td>混元新一代模型<br>图片理解</td><td>思考</td></tr></table></html>';
test('只解析同产品模型表；版本名称精确匹配，不混用 Flash 与 V4.1 Flash',()=>{
 assert.equal(parseModelDocument(html)[0].description,'混元新一代模型 图片理解');
 assert.equal(parseModelDocument('<table><tr><th>模型</th><th>倍率</th></tr><tr><td>Hy3</td><td>免费</td></tr></table>').length,0);
 assert.notEqual(modelNameKey('Deepseek-V4-Flash'),modelNameKey('DeepSeek V4.1 Flash'));
});
test('文档缓存、强制刷新和网络失败标记，不把旧数据伪装成实时数据',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-docs-'));const restore=setConfigDir(dir);t.after(()=>{restore();fs.rmSync(dir,{recursive:true,force:true});});
 let count=0;const fetcher=async(url,options)=>{count++;assert.equal(options.headers.Authorization,undefined);return new Response(html);};
 const a=await getModelDocument('cn-cli',{fetcher,now:1000});assert.equal(a.source,'live');
 await getModelDocument('cn-cli',{fetcher,now:2000});assert.equal(count,1);
 const b=await getModelDocument('cn-cli',{force:true,fetcher:async()=>{throw Error('offline');},now:3000});assert.equal(b.source,'cache');assert.equal(b.fetchedAt,1000);assert.equal(b.error,'offline');
 await getModelDocument('cn-cli',{force:true,fetcher,now:4000});assert.equal(count,2);
});
test('活动标签、默认上下文、输入输出上限保留；夜间标签不直接变成免费',()=>{
 const [m]=normalizeModelCatalog({models:[{id:'hy4',credits:'x0.29',descriptionZh:'混元模型',tags:['badge:夜间免费:#FF0000'],contextWindow:{defaultLength:300000},maxInputTokens:960000,maxOutputTokens:64000}]});
 assert.equal(m.credits,'x0.29 credits');assert.deepEqual(m.badges,['夜间免费']);assert.equal(m.contextDefault,300000);assert.equal(m.contextWindow,960000);assert.equal(m.description,'混元模型');assert.match(m.priceNote,/免费额度需/);
});
test('官方文档只能补充说明，不能覆盖当前账号价格或授权参考模型免费',async()=>{
 const models=await consoleModels({sites:{'cn-cli':{seedModels:[{id:'ref',name:'Other'}]}}},{loggedIn:()=>true,getCatalog:async()=>({source:'upstream',models:new Map([['hy4',{id:'hy4',name:'Hy4 preview',credits:'x0.29 credits'}]])}),documents:{'cn-cli':{url:'https://www.codebuddy.cn/docs/workbuddy/Model',source:'live',fetchedAt:1000,models:[{name:'Hy4 preview',description:'文档说明',credits:'x0'}, {name:'Other',description:'参考说明',credits:'x0'}]}}});
 assert.equal(models.find(m=>m.id==='cn-cli/hy4').credits,'x0.29 credits');assert.equal(models.find(m=>m.id==='cn-cli/hy4').description,'文档说明');assert.equal(models.find(m=>m.id==='cn-cli/ref').free,false);
});

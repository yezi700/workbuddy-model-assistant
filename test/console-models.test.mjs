import {test} from 'node:test';
import assert from 'node:assert/strict';
import {consoleModels} from '../src/console-models.mjs';

const cfg={sites:{'intl-cli':{seedModels:[{id:'m',credits:'x0.00'}]},'intl-work':{seedModels:[]},off:{enabled:false}}};
const deps={loggedIn:s=>s==='intl-work',getCatalog:async()=>({source:'seed',models:new Map([['m',{id:'m',name:'Model'}]])})};
test('已退出渠道默认隐藏；显式展开只显示一次且不可选择、不可标记免费',async()=>{
 const active=await consoleModels(cfg,{...deps,includeLoggedOut:false});
 assert.deepEqual(active.map(m=>m.site),['intl-work']);
 const all=await consoleModels(cfg,{...deps,includeLoggedOut:true});
 assert.equal(all.length,2);
 const missing=all.find(m=>m.site==='intl-cli');
 assert.equal(missing.selectable,false);assert.equal(missing.pending_login,true);
 assert.equal(missing.free,false);assert.equal(missing.credits,null);
 assert.match(missing.price_note,/未登录/);
});
test('未知费用说明来源，官方明确的零倍率才显示免费',async()=>{
 const unknown=await consoleModels(cfg,{...deps,includeLoggedOut:false});
 assert.match(unknown[0].price_note,/费用未确认/);
 const official=await consoleModels(cfg,{...deps,includeLoggedOut:false,getCatalog:async()=>({source:'upstream',models:new Map([['m',{id:'m',credits:'x0.00 credits'}]])})});
 assert.equal(official[0].free,true);assert.match(official[0].price_note,/官方/);
});

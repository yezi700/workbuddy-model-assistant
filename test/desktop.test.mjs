import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {initData,importData}=require('../desktop/data.cjs');
const {ProxyService}=require('../desktop/service.cjs');
const {normalizeChannels}=require('../desktop/channels.cjs');

test('两渠道迁移移除国际 CodeBuddy，保留密钥并迁移模型路由，不复制价格',()=>{
  const cfg=normalizeChannels({apiKey:'test-key',port:8788,defaultSite:'intl-cli',defaultModel:'intl-cli/m',sites:{'intl-cli':{},'intl-work':{seedModels:[{id:'m',credits:'x0.00'}]}},modelAliases:{m:'intl-cli/m'},modelRoutes:{m:'intl-cli'},routingPolicies:[{site:'intl-cli',fallbackSites:['intl-cli','intl-work'],schedule:{site:'intl-cli'}}]});
  assert.deepEqual(Object.keys(cfg.sites).sort(),['cn-cli','intl-work']);
  assert.equal(cfg.apiKey,'test-key');assert.equal(cfg.port,8788);
  assert.equal(cfg.defaultModel,'intl-work/m');assert.equal(cfg.modelAliases.m,'intl-work/m');
  assert.deepEqual(cfg.routingPolicies[0].fallbackSites,['intl-work']);
  assert.equal(cfg.sites['intl-work'].seedModels.find(m=>m.id==='m').credits,null);
  assert.ok(cfg.sites['intl-work'].seedModels.length>=24);
});
test('每个桌面用户生成独立密钥，默认限时活动不启用',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-desktop-data-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  initData(path.join(dir,'a'));initData(path.join(dir,'b'));
  const read=name=>JSON.parse(fs.readFileSync(path.join(dir,name,'config.json'),'utf8'));
  assert.notEqual(read('a').apiKey,read('b').apiKey);
  assert.equal(read('a').routingPolicies.find(p=>p.model==='hy4-preview').enabled,false);
  const key=read('a').apiKey;initData(path.join(dir,'a'));assert.equal(read('a').apiKey,key);
});
test('导入仅包含配置和账号，保留旧目录并备份桌面账号',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-desktop-import-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const from=path.join(dir,'old'),to=path.join(dir,'new');initData(from);initData(to);
  fs.writeFileSync(path.join(from,'auth.cn-cli.pool.json'),JSON.stringify({accounts:[{accessToken:'test-token'}]}));
  fs.writeFileSync(path.join(from,'passwords.txt'),'not imported');
  fs.writeFileSync(path.join(to,'auth.intl-cli.json'),JSON.stringify({accessToken:'old-test'}));
  const result=importData(from,to);assert.equal(result.imported_accounts,1);
  assert.equal(fs.existsSync(path.join(to,'passwords.txt')),false);
  assert.equal(fs.existsSync(path.join(from,'auth.cn-cli.pool.json')),true);
  assert.equal(fs.existsSync(path.join(to,'auth.intl-cli.json')),false);
  assert.equal(fs.existsSync(path.join(result.backup_dir,'auth.intl-cli.json')),true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(to,'config.json'),'utf8')).host,'127.0.0.1');
});
test('导入坏凭证时不覆盖当前配置',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-desktop-invalid-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const from=path.join(dir,'old'),to=path.join(dir,'new');initData(from);initData(to);
  const previous=fs.readFileSync(path.join(to,'config.json'),'utf8');
  fs.writeFileSync(path.join(from,'auth.cn-cli.json'),'not json');
  assert.throws(()=>importData(from,to));assert.equal(fs.readFileSync(path.join(to,'config.json'),'utf8'),previous);
});
test('桌面服务拒绝非本机监听地址与非法端口',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-desktop-bind-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const service=new ProxyService({root:dir,dataDir:dir,fork:()=>{throw new Error('should not spawn');}});
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({host:'0.0.0.0',port:8788}));assert.throws(()=>service.config(),/本机/);
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({host:'127.0.0.1',port:1}));assert.throws(()=>service.config(),/端口/);
});

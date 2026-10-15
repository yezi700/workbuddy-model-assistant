import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openWithTransientRetry,inspectOpening} from '../src/upstream.mjs';
const error={code:10000,msg:'invoke model error',retry_policy:{retry:true},extError:{code:'internal_server_error',message:'internal server error'}};
const failed=()=>({ok:false,status:502,text:JSON.stringify(error)});
test('上游明确建议重试的内部错误只补试一次，成功恢复',async()=>{let calls=0;const up=await openWithTransientRetry(async()=>++calls===1?failed():{ok:true},{delayMs:0});assert.equal(up.ok,true);assert.equal(calls,2);});
test('持续内部错误限制为两次，不循环',async()=>{let calls=0;await openWithTransientRetry(async()=>{calls++;return failed();},{delayMs:0});assert.equal(calls,2);});
test('额度、鉴权、未建议重试的错误均不补试',async()=>{for(const up of [{...failed(),status:429},{...failed(),status:401},{...failed(),text:JSON.stringify({...error,retry_policy:{retry:false}})},{...failed(),text:JSON.stringify({code:6004,msg:'免费额度已用完'})}]){let calls=0;await openWithTransientRetry(async()=>{calls++;return up;},{delayMs:0});assert.equal(calls,1);}});
test('取消退避后不补试',async()=>{const ac=new AbortController();let calls=0;const p=openWithTransientRetry(async()=>{calls++;return failed();},{signal:ac.signal,delayMs:1000,onRetry:()=>setTimeout(()=>ac.abort(new Error('cancel')),0)});await assert.rejects(p,/cancel/);assert.equal(calls,1);});
test('SSE 开头业务错误保留重试字段，输出正文后不重放',async()=>{let closed=0;const up=await inspectOpening({ok:true,accountId:'B',close:()=>closed++,frames:(async function*(){yield JSON.stringify(error);})()});assert.deepEqual(JSON.parse(up.text),error);assert.equal(closed,1);let calls=0;const success=await openWithTransientRetry(async()=>{calls++;return inspectOpening({ok:true,close:()=>{},frames:(async function*(){yield JSON.stringify({choices:[{delta:{content:'hello'}}]});yield JSON.stringify(error);})()});},{delayMs:0});assert.equal(success.ok,true);assert.equal(calls,1);});

test('额度受限加备用账号冷却时本地停止，不强行重试冷却账号',async t=>{
 const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');
 const {setConfigDir}=await import('../src/config.mjs');const {openChatRotating}=await import('../src/upstream.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wb-cooldown-'));const restore=setConfigDir(dir);t.after(()=>{restore();fs.rmSync(dir,{recursive:true,force:true});});
 fs.writeFileSync(path.join(dir,'auth.intl-work.pool.json'),JSON.stringify({accounts:[{id:'A',accessToken:'mock-A',enabled:true,modelLimits:{step:{until:Date.now()+60000}}},{id:'B',accessToken:'mock-B',enabled:true,cooldownUntil:Date.now()+30000}]}));
 const {up,tried}=await openChatRotating({},'intl-work',{model:'step'});assert.equal(up.status,503);assert.equal(up.code,'accounts_temporarily_unavailable');assert.equal(up.rotation.available,0);assert.deepEqual(tried,[]);
});

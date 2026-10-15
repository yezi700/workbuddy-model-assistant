import {test} from 'node:test';import assert from 'node:assert/strict';
import {modelLimitDetails,modelQuotaReset} from '../src/model-quota.mjs';
const now=Date.parse('2026-10-15T12:00:00+08:00');
test('6004 频率限制不能推断免费额度耗尽；重置时间来自上游',()=>{
 for(const msg of ['您的使用量已超出频率限制，将在 2026-10-16 03:47:01 UTC+8 重置，您也可以切换其他模型继续使用。','usage exceeds frequency limit; reset at 2026-10-16 03:47:01 UTC+8; switch to other models']){
 const reason=JSON.stringify({code:6004,msg});const until=modelQuotaReset(reason,now);assert.ok(until>now);assert.deepEqual(modelLimitDetails(reason,until),{kind:'usage_limit',reset_source:'upstream'});
 }
});
test('仅明确免费额度耗尽可这样标注，六小时暂避不是上游重置时间',()=>{const reason='免费额度已用完';const until=modelQuotaReset(reason,now);assert.deepEqual(modelLimitDetails(reason,until),{kind:'free_quota',reset_source:'local'});});
test('旧记录缺少原因，或文本时间不等于限制时间时不假称上游重置',()=>{assert.deepEqual(modelLimitDetails('',now+1000),{kind:'usage_limit',reset_source:'local'});assert.equal(modelLimitDetails('free quota used up, reset at 2026-10-14 03:47:01 UTC+8',now+1000).reset_source,'local');});

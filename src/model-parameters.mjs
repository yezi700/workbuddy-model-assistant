export const EFFORTS = ['minimal','low','medium','high','xhigh','max'];
const bad=message=>Object.assign(new Error(message),{status:400});
export function parameterCapabilities(info={}) {
  const efforts=(Array.isArray(info.reasoningEfforts)?info.reasoningEfforts:[]).filter(e=>EFFORTS.includes(e));
  const windows=(Array.isArray(info.contextLengths)?info.contextLengths:[]).filter(n=>Number.isInteger(n)&&n>0&&(!info.contextWindow||n<=info.contextWindow));
  return {efforts:[...new Set(efforts)],windows:[...new Set(windows)].sort((a,b)=>a-b),defaultEffort:info.reasoningDefault||null,defaultWindow:info.contextDefault||info.contextWindow||null};
}
export function validateParameters(value,info) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw bad('模型参数必须是对象');
  const result={};
  if(value.reasoning_effort!=null){if(!EFFORTS.includes(value.reasoning_effort))throw bad('思考强度无效');result.reasoning_effort=value.reasoning_effort;}
  if(value.context_window!=null){if(!Number.isInteger(value.context_window)||value.context_window<1024||value.context_window>10000000)throw bad('上下文窗口必须是有效 token 数');result.context_window=value.context_window;}
  if(info){const caps=parameterCapabilities(info);if(result.reasoning_effort&&!caps.efforts.includes(result.reasoning_effort))throw bad('当前渠道的模型不支持该思考强度，请刷新模型目录');if(result.context_window&&!caps.windows.includes(result.context_window))throw bad('当前渠道的模型不支持该上下文窗口，请刷新模型目录');}
  return result;
}
export function applyModelParameters(cfg,site,src,info) {
  const saved=cfg.modelParameters?.[`${site}/${src.model}`]||{};
  const effort=src.reasoning_effort ?? src.reasoning?.effort ?? saved.reasoning_effort;
  const window=src.context_window ?? saved.context_window;
  const effective=validateParameters({reasoning_effort:effort,context_window:window},info);
  const body={...src};delete body.context_window;
  if(effective.reasoning_effort){
    body.reasoning_effort=effective.reasoning_effort;
    body.reasoning_summary=src.reasoning_summary ?? src.reasoning?.summary ?? 'auto';
    if(body.reasoning){body.reasoning={...body.reasoning};delete body.reasoning.effort;delete body.reasoning.summary;if(!Object.keys(body.reasoning).length)delete body.reasoning;}
  }
  return {body,contextWindow:effective.context_window||null};
}

// 明确重置时间及可切换模型：暂停该模型；不能据此断定免费额度耗尽。
export function modelLimitDetails(reason, until) {
  let text=String(reason||'');try{const j=JSON.parse(text);text=j.msg||j.message||j.error?.message||text;}catch{}
  const match=text.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?/i);
  const explicit=match?Date.parse(`${match[1]}T${match[2]}${match[3]}${match[4].padStart(2,'0')}:${match[5]||'00'}`):NaN;
  return {
    kind:/免费.{0,16}(?:额度|次数).{0,16}(?:耗尽|用完|不足)|free.{0,20}(?:quota|allowance).{0,20}(?:exhaust|used up)/i.test(text)?'free_quota':'usage_limit',
    reset_source:Number.isFinite(explicit)&&explicit===until?'upstream':'local',
  };
}
export function modelQuotaReset(message,now=Date.now()) {
  let text=String(message||'');try{const j=JSON.parse(text);text=j.msg||j.message||j.error?.message||text;}catch{}
  const match=text.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(?:UTC|GMT)\s*([+-])(\d{1,2})(?::?(\d{2}))?/i);
  const scope=/切换其他模型|其他模型继续|switch.{0,30}(?:another|other) model|free.{0,20}(?:quota|allowance).{0,20}(?:exhaust|used up)|免费.{0,16}(?:额度|次数).{0,16}(?:耗尽|用完|不足)/i.test(text);
  if(!scope)return null;
  if(match){
    const time=Date.parse(`${match[1]}T${match[2]}${match[3]}${match[4].padStart(2,'0')}:${match[5]||'00'}`);
    if(Number.isFinite(time)&&time>now&&time<=now+7*86400000)return time;
  }
  // 没有明确重置时间的免费日额度，仍只暂停这个模型。
  if(/免费.{0,16}(?:额度|次数).{0,16}(?:耗尽|用完|不足)|free.{0,20}(?:quota|allowance).{0,20}(?:exhaust|used up)/i.test(text))return now+6*3600000;
  return null;
}
export function activeModelLimit(account,model,now=Date.now()) {
  const limits=account?.modelLimits;
  if(!model||!limits||!Object.hasOwn(limits,model))return null;
  const value=limits[model];return Number.isFinite(value?.until)&&value.until>now?value:null;
}

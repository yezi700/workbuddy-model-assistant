export function creditMultiplier(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const text=String(value ?? '').trim();
  const match=text.match(/^x\s*(\d+(?:\.\d+)?)\s*(?:credits)?$/i) || text.match(/^(\d+(?:\.\d+)?)\s*x$/i);
  return match ? Number(match[1]) : null;
}
export function normalizeModelCatalog(json, now=Date.now()) {
  if (json.code !== undefined && json.code !== 0) throw new Error('模型目录业务返回失败');
  const data=json.data || json;
  if (!Array.isArray(data.models) || !data.models.length) throw new Error('模型目录为空');
  const cli=(data.agents || []).find(a=>a.name==='cli');
  const permitted=cli?.models?.length ? new Set(cli.models) : null;
  return data.models.filter(m=>m.id && !m.disabled && (!permitted || permitted.has(m.id))).map(m=>{
    const base=creditMultiplier(m.credits);
    const badges=(m.tags||[]).filter(t=>typeof t==='string'&&t.startsWith('badge:')).map(t=>t.split(':')[1]).filter(Boolean);
    const description=m.descriptionZh || m.descriptionEn || '';
    const contextDefault=Number(m.contextWindow?.defaultLength)||null;
    const promotions=(data.modelPromotions || []).filter(p=>p.enabled && p.modelIds?.includes(m.id));
    const active=promotions.filter(p=>{
      const from=p.schedule?.validFrom ? Date.parse(p.schedule.validFrom) : -Infinity;
      const until=p.schedule?.validUntil ? Date.parse(p.schedule.validUntil) : Infinity;
      const factor=p.discount?.factor;
      return !Number.isNaN(from) && !Number.isNaN(until) && now>=from && now<until && Number.isFinite(factor) && factor>=0 && factor<=1;
    }).sort((a,b)=>a.discount.factor-b.discount.factor);
    const promo=active[0];
    const unconfirmedZero=base===0 && promotions.length>0 && !promo;
    const effective=unconfirmedZero ? null : base===null ? null : base*(promo?.discount.factor ?? 1);
    return {id:m.id,name:m.name || m.id,credits:effective===null ? null : `x${Number(effective.toFixed(6))} credits`,
      catalogCredits:m.credits ?? null,baseCredits:base===null ? null : `x${base} credits`,
      priceStatus:unconfirmedZero ? 'inactive-promotion' : effective===null ? 'unknown' : 'official',
      badges,description,contextDefault,
      priceNote:unconfirmedZero ? '目录返回零倍率，但对应活动当前未生效；现价待确认' : promo ? `官方活动：${promo.badge?.label || '优惠'}${promo.schedule?.validUntil ? '，截至 '+promo.schedule.validUntil : ''}` : badges.length ? `官方活动标签：${badges.join('、')}；活动期限及剩余免费额度需在官方客户端确认` : null,
      priceExpiresAt:promo?.schedule?.validUntil ? Date.parse(promo.schedule.validUntil) : null,
      contextWindow:m.maxInputTokens || null,maxTokens:m.maxOutputTokens || null,
      supportsImages:Boolean(m.supportsImages),supportsToolCall:Boolean(m.supportsToolCall),supportsReasoning:Boolean(m.supportsReasoning)};
  });
}
export function cachedPriceModels(models, now=Date.now()) {
  return models.map(m=>{
    if (m.priceExpiresAt && now>=m.priceExpiresAt) return {...m,credits:null,priceStatus:'inactive-promotion',priceNote:'缓存中的活动已结束；现价待确认'};
    // 缓存保留价格用于展示；过期缓存的零倍率不再作为免费调用依据。
    if (creditMultiplier(m.credits)===0) return {...m,credits:null,catalogCredits:m.catalogCredits || m.credits,priceStatus:'stale-zero',priceNote:'上次目录为零倍率，当前读取失败；免费资格待确认'};
    return m;
  });
}

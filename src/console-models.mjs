import { parseMultiplier, isExcluded } from './router.mjs';
import reference from './workbuddy-reference.json' with { type: 'json' };

export async function consoleModels(cfg, { includeLoggedOut = true, loggedIn, getCatalog }) {
  const data = [];
  for (const [site, settings] of Object.entries(cfg.sites)) {
    if (settings.enabled === false) continue;
    const logged = loggedIn(site);
    if (!logged && !includeLoggedOut) continue;
    const cat = logged ? await getCatalog(cfg, site) : { models: new Map(), source: 'seed' };
    const entries = new Map([...(cfg.workbuddyOnly ? reference[site] || [] : []),...(settings.seedModels || [])].map(m => [m.id,{...m,reference:true,credits:null}]));
    for (const [id,m] of cat.models) entries.set(id,m);
    for (const info of entries.values()) {
      if (isExcluded(cfg,site,info.id)) continue;
      const credits = logged && !info.reference ? info.credits ?? null : null;
      const mult = parseMultiplier(credits);
      data.push({ id: `${site}/${info.id}`, site, name: info.name || info.id,
        credits, multiplier: Number.isFinite(mult) ? mult : null, free: logged && mult === 0,
        context: info.contextWindow || null, max_output: info.maxTokens || null,
        pending_login: !logged, selectable: logged, catalog_source: cat.source,
        catalog_credits: info.catalogCredits || null,price_status:info.priceStatus || null,
        price_updated_at:cat.fetchedAt ? new Date(cat.fetchedAt).toISOString() : null,
        availability_note: !logged ? '未登录，暂不可调用' : info.reference ? '参考清单，当前账号可用性未验证' : '来自该渠道的官方目录',
        price_note: !logged ? '未登录，未查询费用' : info.priceNote || (credits != null ? (cat.source === 'upstream(cache)' ? '上次官方目录缓存，实际费用以上游为准' : '来自官方模型目录') : info.reference || cat.source === 'seed' ? '当前官方目录未列出，费用未确认' : '上游未提供价格，不能视为免费'),
      });
    }
  }
  return data;
}

import { parseMultiplier } from './router.mjs';

export async function consoleModels(cfg, { includeLoggedOut = false, loggedIn, getCatalog }) {
  const data = [];
  for (const [site, settings] of Object.entries(cfg.sites)) {
    if (settings.enabled === false) continue;
    const logged = loggedIn(site);
    if (!logged && !includeLoggedOut) continue;
    const cat = logged ? await getCatalog(cfg, site) : { models: new Map((settings.seedModels || []).map(m => [m.id, m])), source: 'seed' };
    for (const info of cat.models.values()) {
      const credits = logged ? info.credits ?? null : null;
      const mult = parseMultiplier(credits);
      data.push({ id: `${site}/${info.id}`, site, name: info.name || info.id,
        credits, multiplier: Number.isFinite(mult) ? mult : null, free: logged && mult === 0,
        context: info.contextWindow || null, max_output: info.maxTokens || null,
        pending_login: !logged, selectable: logged, catalog_source: cat.source,
        price_note: !logged ? '未登录，未查询费用' : credits != null ? (cat.source === 'upstream(cache)' ? '上次官方目录缓存，实际费用以上游为准' : '来自官方模型目录') : cat.source === 'seed' ? '内置清单不含价格，不能视为免费' : '上游未提供价格，不能视为免费',
      });
    }
  }
  return data;
}

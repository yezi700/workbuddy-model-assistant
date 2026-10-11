// 可编辑的模型路由规则；不推测上游免费活动或价格。
export function validatePolicies(policies, sites) {
  if (!Array.isArray(policies) || policies.length > 100) throw new Error('规则必须是数组，最多 100 条');
  const seen = new Set();
  return policies.map((p) => {
    if (!p || typeof p !== 'object') throw new Error('无效的路由规则');
    const model = String(p.model || '').trim();
    if (!model || model.length > 160 || ['default', 'current'].includes(model.toLowerCase()) || model.includes('/') || seen.has(model)) throw new Error('模型 ID 不可为空、重复或带站点前缀');
    seen.add(model);
    if (!sites[p.site]) throw new Error(`未知首选站点：${p.site}`);
    if (!['off', 'listed', 'freeOnly'].includes(p.fallbackMode)) throw new Error('请选择有效的备用站点规则');
    if (!Array.isArray(p.fallbackSites) || p.fallbackSites.some(s => !sites[s])) throw new Error('备用站点无效');
    const s = p.schedule || {};
    const validTime = t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
    if (s.enabled && (!validTime(s.start) || !validTime(s.end) || s.start === s.end || !sites[s.site])) throw new Error('定时规则需要站点和不同的起止时间');
    const timezone = s.timezone || 'Asia/Shanghai';
    try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('时区无效'); }
    const validDate = d => !d || (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d);
    if (!validDate(s.startDate) || !validDate(s.endDate) || (s.startDate && s.endDate && s.startDate > s.endDate)) throw new Error('活动日期无效');
    return {
      model, enabled: p.enabled !== false, site: p.site,
      fallbackMode: p.fallbackMode, fallbackSites: [...new Set(p.fallbackSites)],
      requireFree: p.requireFree === true,
      schedule: { enabled: s.enabled === true, start: s.start || '', end: s.end || '', startDate: s.startDate || '', endDate: s.endDate || '', site: s.site || p.site, timezone, outside: s.outside === 'block' ? 'block' : 'base' },
    };
  });
}

export function policyFor(cfg, model) {
  return (cfg.routingPolicies || []).find(p => p.enabled !== false && p.model === model);
}

export function scheduleActive(schedule, now = new Date()) {
  if (!schedule?.enabled) return false;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timezone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const time = parts.find(p => p.type === 'hour').value + ':' + parts.find(p => p.type === 'minute').value;
  let date = ['year', 'month', 'day'].map(t => parts.find(p => p.type === t).value).join('-');
  // 跨午夜的凌晨属于前一天开始的活动晚间，例如 10/31 晚间延续到 11/1 08:00。
  if (schedule.start > schedule.end && time < schedule.end) date = new Date(Date.parse(date) - 86400000).toISOString().slice(0, 10);
  if ((schedule.startDate && date < schedule.startDate) || (schedule.endDate && date > schedule.endDate)) return false;
  return schedule.start < schedule.end ? time >= schedule.start && time < schedule.end : time >= schedule.start || time < schedule.end;
}

export function preferredSite(policy, now = new Date()) {
  if (!policy?.schedule?.enabled) return policy.site;
  if (scheduleActive(policy.schedule, now)) return policy.schedule.site;
  if (policy.schedule.outside === 'block') throw Object.assign(new Error(`${policy.model} 当前不在允许时段 ${policy.schedule.start}–${policy.schedule.end}（${policy.schedule.timezone}），已暂停调用`), { status: 403 });
  return policy.site;
}

// getCatalog / loggedIn 允许注入，便于用模拟目录验证未知价格与备用站点限制。
export async function routeCandidates(cfg, target, { getCatalog, loggedIn, excluded = () => false }) {
  const p = policyFor(cfg, target.model);
  if (p?.schedule.enabled && p.schedule.outside === 'block') preferredSite(p);
  const mode = p?.fallbackMode || cfg.routing?.fallbackMode || 'freeOnly';
  const catalogs = new Map();
  const catalog = async s => { if (!catalogs.has(s)) catalogs.set(s, await getCatalog(cfg, s)); return catalogs.get(s); };
  const free = info => /^x\s*0(?:\.0+)?\s*(?:credits)?$/i.test(String(info?.credits || '').trim());
  const allowed = s => cfg.sites?.[s] && cfg.sites[s].enabled !== false && loggedIn(s);
  if (p?.requireFree) {
    const info = (await catalog(target.site)).models.get(target.model);
    if (!free(info)) throw Object.assign(new Error(`${target.model} 在 ${target.site} 的目录未确认免费（价格未知或非零），已暂停调用`), { status: 403 });
  }
  const pool = p ? p.fallbackSites : Object.keys(cfg.sites || {});
  const fallbacks = [];
  if (mode !== 'off') {
    for (const s of pool) {
      if (s === target.site || !allowed(s) || excluded(cfg, s, target.model)) continue;
      const info = (await catalog(s)).models.get(target.model);
      // 指定的站点允许目录缺失（国际版清单可能不全）；免费模式必须有零倍率。
      if ((mode === 'freeOnly' || p?.requireFree) ? !free(info) : (!p && !info)) continue;
      fallbacks.push({ site: s, model: target.model });
    }
  }
  return { ...target, fallbacks, fallback: fallbacks[0] || null, policy: p || null };
}

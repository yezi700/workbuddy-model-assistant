// 控制台后端 API：状态总览 / 模型清单 / 一键切换默认模型 / 日志 / 用量 / 探测 / 登录 / 停服
// 仅本机可用（服务只监听 127.0.0.1），鉴权用控制台会话 token 或 config.json 的 apiKey。
import fs from 'node:fs';
import {validateParameters} from './model-parameters.mjs';
import path from 'node:path';
import { ROOT, siteKeys, saveConfig, paths, authPathFor, authKeys, primaryKey, blockedPolicyModels } from './config.mjs';
import { getAuth, isLoggedIn, accountSnapshot } from './auth.mjs';
import {
  poolPathFor,
  getAccount,
  removeAccount,
  setAccountEnabled,
  setAccountLabel,
  resetAccountState,
  flushPool,
  pickAccount,
  reloadPool,
} from './pool.mjs';
import { getCatalog, resolveTarget } from './router.mjs';
import {getModelDocument} from './model-docs.mjs';
import { consoleModels } from './console-models.mjs';
import { validatePolicies, preferredSite } from './routing-policy.mjs';
import { openChat, queryCredit, classifyFrame, upstreamErrorMessage, supportsCreditQuery } from './upstream.mjs';
import { startLogin, pollLogin } from './device-login.mjs';
import { usageSnapshot, resetUsage, flushUsage, recordBalance } from './usage.mjs';
import { recentLogs } from './log.mjs';
import { sendJson } from './util.mjs';

const startedAt = Date.now();
const loginStates = new Map(); // site → { state, authUrl, at }

/**
 * 首页余额的短期缓存。控制台每 20 秒刷新一次 /state，原先每次都实时打各站点的计费接口，
 * 桌面版常驻托盘一天就是几千次计费请求。余额变化不需要秒级精度；
 * 「账号登录」页的「刷新余额」走 /pool，不经过这里，仍然实时。
 */
const CREDIT_TTL_MS = 60_000;
const creditCache = new Map();
function creditKey(cfg,site,accountId) {const a=getAccount(site,accountId)||{};return JSON.stringify([paths.root,site,accountId,a.uid,a.enterpriseId,cfg.sites[site]?.billingBase]);}
function clearCreditCache(site){for(const [key,value] of creditCache)if(value.site===site)creditCache.delete(key);}
function storeCredit(cfg,site,accountId,credit){if(creditCache.size>=256)creditCache.clear();creditCache.set(creditKey(cfg,site,accountId),{site,at:Date.now(),credit});}
async function cachedCredit(cfg, site, accountId) {
  const key=creditKey(cfg,site,accountId);
  const hit = creditCache.get(key);
  if (hit && Date.now() - hit.at < CREDIT_TTL_MS) {
    if (hit.error) throw new Error(hit.error);
    return hit.credit;
  }
  try {
    const credit = await queryCredit(cfg, site, accountId);
    storeCredit(cfg,site,accountId,credit);
    return credit;
  } catch (e) {
    creditCache.set(key, { site,at: Date.now(), error: e.message });
    throw e;
  }
}

/**
 * 从 package.json 读版本号。
 *
 * 原先这里是硬编码的 '1.1.0'，结果 package.json 升到 1.2.0 后控制台还显示旧版本，
 * 排查问题时对着版本号看会误导。改成单一来源，不再两处维护。
 * 读不到时返回 'unknown' 而不是抛错——控制台不该因为读不到版本号就打不开。
 */
let cachedVersion = null;
function pkgVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    cachedVersion = p.version || 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

function maskKey(k) {
  if (!k) return '';
  return k.length <= 10 ? '***' : k.slice(0, 6) + '…' + k.slice(-4);
}

async function siteSummary(cfg, site) {
  const a = getAuth(site);
  const s = cfg.sites[site];
  const cat = await getCatalog(cfg, site);
  const accounts = accountSnapshot(site);
  return {
    site,
    account_id:a.id || accounts.find(x=>x.uid===a.uid)?.id || pickAccount(site,{fallback:true})?.id || null,
    label: s.label,
    apiBase: s.apiBase,
    enabled: s.enabled !== false,
    logged_in: isLoggedIn(site),
    uid: a.uid || null,
    nickname: a.nickname || null,
    domain: a.domain || null,
    token_expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
    model_count: cat.models.size,
    catalog_source: cat.source || null,
    catalog_error: cat.error || null,
    // 号池概览：控制台据此显示「3 个账号，2 个可用」
    account_count: accounts.length,
    account_usable: accounts.filter((x) => x.usable).length,
    accounts,
  };
}

/** 探测单个模型是否可用（不消耗或极少消耗额度）。 */
async function probeModel(cfg, site, model) {
  const t0 = Date.now();
  try {
    const up = await openChat(cfg, site, {
      model,
      stream: true,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    }, {});
    if (!up.ok) {
      return { model, site, status: up.status, ok: false, msg: upstreamErrorMessage(up.status, up.text, site), ms: Date.now() - t0 };
    }
    let first = null;
    try {
      for await (const payload of up.frames) {
        const parsed = classifyFrame(payload);
        first = parsed;
        break;
      }
    } finally {
      up.close();
    }
    if (first?.kind === 'error') return { model, site, status: 502, ok: false, msg: first.message, ms: Date.now() - t0 };
    return { model, site, status: 200, ok: true, msg: '可用', ms: Date.now() - t0 };
  } catch (e) {
    return { model, site, status: 0, ok: false, msg: e.message, ms: Date.now() - t0 };
  }
}

export async function handleConsoleApi(ctx) {
  const { cfg, req, res, url } = ctx;
  const p = url.pathname.replace(/^\/console\/api/, '') || '/';
  const method = req.method;

  // 仅在已鉴权的本机控制台请求时读取，方便复制到客户端。
  if (p === '/connection' && method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    return sendJson(res, 200, { base_url: `http://${cfg.host}:${cfg.port}/v1`, full_url: `http://${cfg.host}:${cfg.port}/v1/chat/completions`, model: 'default', api_key: primaryKey(cfg) });
  }

  // 本机控制台管理路由；保存后立即生效，不重启、不调用聊天接口。
  if (p === '/routing' && method === 'GET') {
    return sendJson(res, 200, {
      policies: cfg.routingPolicies || [], routing: cfg.routing || { fallbackMode: 'freeOnly' }, pool: cfg.pool,
      blocked_models: cfg.blockedRoutingModels || {},
      invalid_policies:(cfg.invalidRoutingPolicies||[]).map(p=>({model:String(p.model).split('/').at(-1),site:cfg.sites[p.site]?p.site:cfg.defaultSite,enabled:true,requireFree:p.requireFree===true,fallbackMode:['off','freeOnly','listed'].includes(p.fallbackMode)?p.fallbackMode:'off',fallbackSites:Array.isArray(p.fallbackSites)?p.fallbackSites.filter(s=>cfg.sites[s]):[],schedule:Object.fromEntries(['enabled','start','end','startDate','endDate','site','timezone','outside'].map(k=>[k,p.schedule?.[k]]))})),
      sites: Object.entries(cfg.sites).map(([id, s]) => ({ id, label: s.label, enabled: s.enabled !== false, logged_in: isLoggedIn(id) })),
      active: (cfg.routingPolicies || []).map(r => { try { return { model: r.model, site: preferredSite(r), enabled: r.enabled !== false }; } catch (e) { return { model: r.model, blocked: e.message, enabled: r.enabled !== false }; } }),
    });
  }
  if (p === '/routing' && method === 'POST') {
    try {
      const b = ctx.body || {};
      const policies = validatePolicies(b.policies, cfg.sites);
      if (!['off', 'freeOnly', 'listed'].includes(b.routing?.fallbackMode)) throw new Error('全局备用站点模式无效');
      const max = Number(b.pool?.maxAccountsPerRequest);
      if (!Number.isInteger(max) || max < 1 || max > 20) throw new Error('每次尝试账号数需为 1–20');
      const repaired=new Set(policies.map(p=>p.model));
      const invalidRoutingPolicies=(cfg.invalidRoutingPolicies||[]).filter(p=>!repaired.has(String(p.model||'').split('/').at(-1)));
      const next={...cfg,routingPolicies:policies,invalidRoutingPolicies,blockedRoutingModels:blockedPolicyModels(invalidRoutingPolicies,cfg.sites),routing:{fallbackMode:b.routing.fallbackMode},pool:{...cfg.pool,maxAccountsPerRequest:max,switchSiteOnExhausted:b.pool.switchSiteOnExhausted===true}};
      saveConfig(next);Object.assign(cfg,next);
      return sendJson(res, 200, { ok: true });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (p === '/routing/preview' && method === 'POST') {
    try {
      const target = await resolveTarget(cfg, String(ctx.body?.model || 'default'));
      return sendJson(res, 200, { site: target.site, model: target.model, fallback_sites: target.fallbacks.map(x => x.site), note: '只解析路由，没有发送对话或验证模型权限' });
    } catch (e) { return sendJson(res, e.status || 400, { error: e.message }); }
  }

  // ---- 状态总览 ----
  if (p === '/state' && method === 'GET') {
    const sites = [];
    for (const s of siteKeys(cfg)) {
      const info = await siteSummary(cfg, s);
      // 没有配置 billingBase 的站点不走计费接口，
      // 跳过查询而不是报错，前端会显示「—」。
      if (info.logged_in && supportsCreditQuery(cfg, s)) {
        try {
          const credit = await cachedCredit(cfg, s, info.account_id);
          info.credit = credit.remain;
          info.credit_detail = credit.detail;
          if (typeof credit.remain === 'number') recordBalance(s, credit.remain);
        } catch (e) {
          info.credit_error = e.message.slice(0, 160);
        }
      }
      sites.push(info);
    }
    let selectedRoute;
    try {
      const t = await resolveTarget(cfg, 'default');
      selectedRoute = { site: t.site, model: t.model, fallback_sites: t.fallbacks.map(f => f.site) };
    } catch (e) { selectedRoute = { blocked: e.message }; }
    return sendJson(res, 200, {
      version: pkgVersion(),
      uptime_ms: Date.now() - startedAt,
      node: process.version,
      platform: process.platform,
      default_site: cfg.defaultSite,
      default_model: cfg.defaultModel,
      api_key_masked: maskKey(primaryKey(cfg)),
      api_key_count: authKeys(cfg).length,
      base_url: `http://${cfg.host}:${cfg.port}/v1`,
      full_url: `http://${cfg.host}:${cfg.port}/v1/chat/completions`,
      selected_route: selectedRoute,
      sites,
    });
  }

  // ---- 模型清单（含 default 虚拟模型） ----
  if (p === '/models' && method === 'GET') {
    // 控制台逐站点展示；API 客户端模型清单仍按原逻辑合并。
    const force=url.searchParams.get('refresh')==='1';
    const documents=cfg.workbuddyOnly ? Object.fromEntries(await Promise.all(Object.keys(cfg.sites).filter(s=>cfg.sites[s].enabled!==false).map(async s=>[s,await getModelDocument(s,{force})]))) : {};
    const list = await consoleModels(cfg, { documents, loggedIn: isLoggedIn, getCatalog: (config,site)=>getCatalog(config,site,{force}) });
    return sendJson(res, 200, {
      default_model: cfg.defaultModel,
      default_site: cfg.defaultSite,
      documents,
      aliases: cfg.modelAliases || {},
      model_routes: cfg.modelRoutes || {},
      data: list,
    });
  }

  if(p==='/model-parameters' && method==='POST'){
    const b=ctx.body||{},site=String(b.site||''),model=String(b.model||'');
    if(!cfg.sites[site]||!model||model.includes('/')||model.length>160)return sendJson(res,400,{error:'渠道或模型无效'});
    let next;
    try {
      const requested=validateParameters(b.parameters);
      if(Object.keys(requested).length){
        const cat=await getCatalog(cfg,site);const info=cat.models.get(model);
        if(!info||info.seed||cat.source==='seed')return sendJson(res,409,{error:'官方目录未确认该模型能力，请先登录并刷新目录'});
        next=validateParameters(requested,info);
      }else next={};
      const modelParameters={...(cfg.modelParameters||{})};const key=`${site}/${model}`;
      if(Object.keys(next).length)modelParameters[key]=next;else delete modelParameters[key];
      saveConfig({...cfg,modelParameters});cfg.modelParameters=modelParameters;
      return sendJson(res,200,{ok:true,parameters:next});
    }catch(e){return sendJson(res,e.status||500,{error:e.message});}
  }

  // ---- 一键切换默认模型（Trae 侧只配 model=default） ----
  if (p === '/default-model' && method === 'POST') {
    const body = ctx.body || {};
    const model = String(body.model || '').trim();
    if (!model) return sendJson(res, 400, { error: '缺少 model' });
    if (body.site && !cfg.sites[String(body.site)]) return sendJson(res, 400, { error: '未知站点' });
    const requestedSite = String(body.site || (cfg.sites[model.split('/')[0]] ? model.split('/')[0] : cfg.defaultSite));
    if (cfg.sites[requestedSite]?.enabled === false || !isLoggedIn(requestedSite)) return sendJson(res, 409, { error: '该渠道未登录或已停用，请先登录账号再选择模型。' });
    const next={...cfg,defaultModel:body.site && !model.includes('/') ? `${body.site}/${model}` : model,defaultSite:body.site?String(body.site):cfg.defaultSite};
    saveConfig(next);Object.assign(cfg,next);
    return sendJson(res, 200, { ok: true, default_model: cfg.defaultModel, default_site: cfg.defaultSite });
  }

  // ---- 站点启停 ----
  if (p === '/site' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (typeof body.enabled === 'boolean') cfg.sites[site].enabled = body.enabled;
    if (body.label) cfg.sites[site].label = String(body.label);
    if (Array.isArray(body.seedModels)) cfg.sites[site].seedModels = body.seedModels;
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, site: cfg.sites[site] });
  }

  // ---- 别名管理 ----
  if (p === '/aliases' && method === 'POST') {
    const body = ctx.body || {};
    const aliases = body.aliases;
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return sendJson(res, 400, { error: '缺少 aliases 对象' });
    if (Object.values(aliases).some((v) => typeof v !== 'string' || !v.trim())) return sendJson(res, 400, { error: '别名的目标必须是非空字符串' });
    cfg.modelAliases = aliases;
    saveConfig(cfg);
    return sendJson(res, 200, { ok: true, aliases: cfg.modelAliases });
  }

  // ---- 号池：列出某站点所有账号（含各自余额） ----
  if (p === '/pool' && method === 'GET') {
    const site = String(url.searchParams.get('site') || cfg.defaultSite);
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if(url.searchParams.get('reload')==='1'){reloadPool(site);clearCreditCache(site);}
    const withCredit = url.searchParams.get('credit') !== '0';
    const accounts = accountSnapshot(site);
    if (withCredit && supportsCreditQuery(cfg, site)) {
      // 逐个查余额。串行执行——并发打上游容易被限流。
      for (const a of accounts) {
        if (!a.enabled) continue;
        try {
          const c = await queryCredit(cfg, site, a.id);
          storeCredit(cfg,site,a.id,c);
          a.credit = c.remain;
          a.credit_detail = c.detail;
          if (typeof c.remain === 'number') recordBalance(`${site}/${a.label}`, c.remain);
          // 零积分账号仍可能有免费模型额度；只根据实际调用错误标记耗尽。
        } catch (e) {
          a.credit_error = e.message.slice(0, 160);
        }
      }
    }
    return sendJson(res, 200, { site, accounts, supports_credit: supportsCreditQuery(cfg, site) });
  }

  // ---- 号池：启用/禁用、重置状态、删除、改标签 ----
  if (p === '/pool/account' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    const id = String(body.id || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    if (!getAccount(site, id)) return sendJson(res, 404, { error: `账号不存在：${id}` });

    clearCreditCache(site);
    if (typeof body.enabled === 'boolean') setAccountEnabled(site, id, body.enabled);
    if (body.reset) resetAccountState(site, id);
    if (typeof body.label === 'string' && body.label.trim()) setAccountLabel(site, id, body.label.trim());
    return sendJson(res, 200, { ok: true, account: accountSnapshot(site).find((a) => a.id === id) || null });
  }

  if (p === '/pool/account/remove' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    const id = String(body.id || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    clearCreditCache(site);
    const ok = removeAccount(site, id);
    if (!ok) return sendJson(res, 404, { error: `账号不存在：${id}` });
    return sendJson(res, 200, { ok: true, remaining: accountSnapshot(site).length });
  }

  // ---- 日志 ----
  if (p === '/logs' && method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    return sendJson(res, 200, recentLogs(after));
  }

  // ---- 用量统计 ----
  if (p === '/usage' && method === 'GET') {
    const days = Number(url.searchParams.get('days') || 7);
    return sendJson(res, 200, usageSnapshot(days));
  }
  if (p === '/usage/reset' && method === 'POST') {
    resetUsage();
    return sendJson(res, 200, { ok: true });
  }

  // ---- 模型探测（顺序执行，避免打爆上游） ----
  if (p === '/probe' && method === 'POST') {
    const body = ctx.body || {};
    const targets = Array.isArray(body.targets) ? body.targets.slice(0, 60) : [];
    const results = [];
    for (const t of targets) {
      const site = String(t.site || cfg.defaultSite);
      const model = String(t.model || '');
      if (!model || !cfg.sites[site]) continue;
      results.push(await probeModel(cfg, site, model));
      await new Promise((r) => setTimeout(r, 250));
    }
    return sendJson(res, 200, { ok: true, count: results.length, results });
  }

  // ---- 账号登录（设备授权） ----
  if (p === '/login/start' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || cfg.defaultSite);
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    const r = await startLogin(cfg, site);
    loginStates.set(site, { ...r, label: body.label ? String(body.label).slice(0, 40) : null });
    return sendJson(res, 200, r);
  }

  if (p === '/login/poll' && method === 'GET') {
    const site = String(url.searchParams.get('site') || cfg.defaultSite);
    const st = loginStates.get(site);
    if (!st) return sendJson(res, 400, { error: '请先点击「开始登录」' });
    const r = await pollLogin(cfg, site, st.state, { label: st.label || null });
    if (r.done) {
      loginStates.delete(site);
      clearCreditCache(site);
      return sendJson(res, 200, {
        done: true,
        account_id: r.auth.id,
        label: r.auth.label,
        uid: r.auth.uid,
        nickname: r.auth.nickname,
        expires_at: r.auth.expiresAt,
        account_count: accountSnapshot(site).length,
      });
    }
    return sendJson(res, 200, { done: false, msg: r.msg });
  }

  /**
   * 登出。带 id 时只删该账号；不带 id 时——为兼容旧行为——删掉该站点账号池，
   * 但保留账号记录（置为未登录）会更让人困惑，所以这里明确按「删账号」处理。
   */
  if (p === '/login/logout' && method === 'POST') {
    const body = ctx.body || {};
    const site = String(body.site || '');
    if (!cfg.sites[site]) return sendJson(res, 400, { error: `未知站点 ${site}` });
    const id = body.id ? String(body.id) : null;
    clearCreditCache(site);
    if (id) {
      if (!getAccount(site, id)) return sendJson(res, 404, { error: `账号不存在：${id}` });
      removeAccount(site, id);
      return sendJson(res, 200, { ok: true, site, removed: id, remaining: accountSnapshot(site).length });
    }
    // 没指定账号 → 清空整个站点（旧版语义）
    try {
      fs.rmSync(poolPathFor(site), { force: true });
      fs.rmSync(authPathFor(site), { force: true });
      if (site === 'cn-cli') fs.rmSync(paths.legacyAuth, { force: true });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
    return sendJson(res, 200, { ok: true, site, remaining: 0 });
  }

  // ---- 服务控制 ----
  if (p === '/service/stop' && method === 'POST') {
    sendJson(res, 200, { ok: true, message: 'shutting down' });
    flushUsage();
    flushPool();
    setTimeout(() => process.exit(0), 200);
    return;
  }

  return sendJson(res, 404, { error: `未知控制台接口 ${method} ${p}` });
}

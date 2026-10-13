import { openChatRotating } from './upstream.mjs';
import { isQuotaError } from './pool.mjs';
import { warn } from './log.mjs';

export function canSwitch(status, text, cfg) {
  if (status===429 || isQuotaError(status, text)) return cfg.pool?.switchSiteOnExhausted !== false;
  return [401,403,502, 503, 504].includes(status) || (status === 400 && /service info not found|model \[[^\]]+\] .*not found|no such model/i.test(String(text || '')));
}

// 三种协议复用同一条切换路径；只在尚未向客户端输出回复时重试。
export async function openRoutedChat(cfg, target, body, { signal, open = openChatRotating } = {}) {
  const candidates = [target, ...(target.fallbacks || (target.fallback ? [target.fallback] : []))];
  let lastError;
  for (let i = 0; i < candidates.length; i++) {
    if (signal?.aborted) throw signal.reason || new Error('请求已取消');
    const c = candidates[i];
    const hasNext = i + 1 < candidates.length;
    try {
      const { up } = await open(cfg, c.site, { ...body, model: c.model }, { signal });
      if (up.ok || !hasNext || !canSwitch(up.status, up.text, cfg)) return { up, site: c.site, model: c.model };
      up.close?.();
      warn(`[${c.site}] ${c.model} HTTP ${up.status}，账号重试后切换到允许的备用站点 ${candidates[i + 1].site}`);
    } catch (e) {
      if (signal?.aborted) throw e;
      const recoverable = e.transport === true || [401, 502, 503, 504].includes(e.status) || canSwitch(e.status,e.message,cfg);
      if (!hasNext || !recoverable) throw e;
      lastError = e;
      warn(`[${c.site}] ${c.model} ${e.message}，切换到允许的备用站点 ${candidates[i + 1].site}`);
    }
  }
  throw lastError || new Error('没有可用站点');
}

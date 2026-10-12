const reference = require('../src/workbuddy-reference.json');
function normalizeChannels(config) {
  config.workbuddyOnly = true;
  config.sites ||= {};
  delete config.sites['intl-cli'];
  const rename = s => s === 'intl-cli' ? 'intl-work' : s;
  const model = s => typeof s === 'string' ? s.replace(/^intl-cli\//, 'intl-work/') : s;
  config.defaultSite = rename(config.defaultSite);
  config.defaultModel = model(config.defaultModel);
  for (const key of ['modelRoutes','modelAliases']) {
    for (const [k,v] of Object.entries(config[key] || {})) config[key][k] = key === 'modelRoutes' ? rename(v) : model(v);
  }
  for (const p of config.routingPolicies || []) {
    p.site = rename(p.site);
    if (p.schedule) p.schedule.site = rename(p.schedule.site);
    p.fallbackSites = [...new Set((p.fallbackSites || []).map(rename))];
  }
  for (const [site,label] of [['cn-cli','国内版WorkBuddy'],['intl-work','国际版WorkBuddy AI']]) {
    const settings = config.sites[site] ||= {};
    settings.label = label;
    // 名称参考不是权限证明；不复制另一个产品的价格。
    const entries = new Map(reference[site].map(m => [m.id,m]));
    for (const m of settings.seedModels || []) entries.set(m.id,{...m,reference:true,credits:null});
    settings.seedModels = [...entries.values()];
  }
  config.channelLayoutVersion = 2;
  return config;
}
module.exports={normalizeChannels};

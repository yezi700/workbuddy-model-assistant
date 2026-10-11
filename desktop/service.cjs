const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class ProxyService extends EventEmitter {
  constructor({ root, dataDir, fork }) {
    super(); this.root = root; this.dataDir = dataDir; this.fork = fork;
    this.child = null; this.running = false; this.error = ''; this.instance = ''; this.stopping = false;
    this.transition = Promise.resolve();
  }
  config() {
    const file = path.join(this.dataDir, 'config.json');
    const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { host:'127.0.0.1',port:8788 };
    if (!['127.0.0.1','localhost','::1'].includes(cfg.host || '127.0.0.1')) throw new Error('桌面版只允许本机地址，请将 host 改为 127.0.0.1');
    if (!Number.isInteger(cfg.port) || cfg.port < 1024 || cfg.port > 65535) throw new Error('端口需为 1024–65535 的整数');
    const host = cfg.host === '::1' ? '[::1]' : (cfg.host || '127.0.0.1');
    return { ...cfg, base:`http://${host}:${cfg.port}`, key:(Array.isArray(cfg.apiKey) ? cfg.apiKey : [cfg.apiKey]).find(k => typeof k === 'string' && k.trim())?.trim() || '' };
  }
  status() {
    let port=8788, base='';
    try { const c=this.config();port=c.port;base=c.base; } catch(e) { this.error=e.message; }
    return {running:this.running,error:this.error,port,base_url:base,data_dir:this.dataDir};
  }
  queue(fn) { const p=this.transition.then(fn,fn);this.transition=p.catch(()=>{});return p; }
  start() { return this.queue(()=>this.startNow()); }
  stop() { return this.queue(()=>this.stopNow()); }
  restart() { return this.queue(async()=>{await this.stopNow();return this.startNow();}); }
  async startNow() {
    if (this.running) return this.status();
    this.error='';this.stopping=false;
    fs.mkdirSync(this.dataDir,{recursive:true});
    const cfg=this.config();
    try {
      const probe=await fetch(cfg.base+'/health',{signal:AbortSignal.timeout(800)});
      if (probe) throw Object.assign(new Error(`端口 ${cfg.port} 已有程序在运行。请停止旧代理，或在下方更换端口；应用不会关闭其他程序。`),{occupied:true});
    } catch(e) { if(e.occupied){this.error=e.message;this.emit('status');throw e;} }
    this.instance=crypto.randomUUID();
    const child=this.fork(path.join(this.root,'desktop','server-bootstrap.cjs'),[],{
      cwd:this.dataDir,env:{...process.env,WB_CONFIG_DIR:this.dataDir,WB_DESKTOP_INSTANCE:this.instance},stdio:'pipe',serviceName:'WorkBuddy 本机代理',
    });
    this.child=child;
    const log=chunk=>{try{fs.appendFileSync(path.join(this.dataDir,'desktop.log'),chunk);}catch{}};
    child.stdout?.on('data',log);child.stderr?.on('data',log);
    child.on('exit',code=>{if(this.child===child){this.child=null;this.running=false;if(!this.stopping)this.error=code ? '代理启动失败，请查看数据目录里的 desktop.log。' : '代理服务已停止。';this.emit('status');}});
    const expires=Date.now()+20000;
    while(Date.now()<expires && this.child===child){
      try {const r=await fetch(cfg.base+'/health',{signal:AbortSignal.timeout(1000)});const h=await r.json();if(h.desktop_instance===this.instance){this.running=true;this.error='';this.emit('status');return this.status();}}catch{}
      await delay(100);
    }
    child.kill();this.error=this.error || '启动超时。请打开数据目录查看 desktop.log。';this.emit('status');throw new Error(this.error);
  }
  async stopNow() {
    const child=this.child;
    this.stopping=true;
    if(!child){this.running=false;this.error='';return this.status();}
    const cfg=this.config();
    try {
      const h=await (await fetch(cfg.base+'/health',{signal:AbortSignal.timeout(1000)})).json();
      if(h.desktop_instance===this.instance) await fetch(cfg.base+'/admin/shutdown',{method:'POST',headers:{Authorization:'Bearer '+cfg.key},signal:AbortSignal.timeout(1500)});
    }catch{}
    for(let i=0;i<30 && this.child===child;i++)await delay(100);
    if(this.child===child){child.kill();for(let i=0;i<20 && this.child===child;i++)await delay(100);}
    this.running=false;this.error='';this.emit('status');return this.status();
  }
}
module.exports={ProxyService};

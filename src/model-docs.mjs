// 公开 WorkBuddy 文档仅作说明参考，不用于覆盖账号价格或确认免费资格。
import fs from 'node:fs';
import path from 'node:path';
import {paths} from './config.mjs';
import {writeFileAtomic} from './util.mjs';

export const MODEL_DOC_URLS = Object.freeze({
  'cn-cli':'https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model',
  'intl-work':'https://www.codebuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model',
});
const memory=new Map(), pending=new Map();
const ttl=5*60*1000;
export const modelNameKey=name=>String(name||'').toLowerCase().replace(/[\s_-]/g,'');
function text(html){return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<br\s*\/?>/gi,' ').replace(/<[^>]*>/g,' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g,e=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[e])).replace(/\s+/g,' ').trim();}
export function parseModelDocument(html){
  const models=[];
  for(const table of html.match(/<table\b[^>]*>[\s\S]*?<\/table>/gi)||[]){
    const rows=(table.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)||[]).map(row=>(row.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi)||[]).map(text));
    const head=rows.shift()||[];
    if(!/^(模型名称|Model Name)$/i.test(head[0]||''))continue;
    const desc=head.findIndex(h=>/简介|Description/i.test(h));
    for(const row of rows)if(row[0]&&row[0].length<100)models.push({name:row[0],description:desc>=0?(row[desc]||'').slice(0,280):''});
  }
  return models.slice(0,100);
}
export async function getModelDocument(site,{force=false,fetcher=fetch,now=Date.now()}={}){
  const url=MODEL_DOC_URLS[site];if(!url)return null;
  const file=path.join(paths.root,`model-docs-${site}.json`),key=file;
  let cached=memory.get(key);
  if(!cached)try{const d=JSON.parse(fs.readFileSync(file,'utf8'));if(d.url===url&&Number.isFinite(d.fetchedAt)&&Array.isArray(d.models))cached=d;}catch{}
  if(!force&&cached&&now-cached.checkedAt<ttl)return cached;
  if(pending.has(key))return pending.get(key);
  const task=(async()=>{
    try{
      const r=await fetcher(url,{signal:AbortSignal.timeout(5000),redirect:'error',headers:{Accept:'text/html'}});
      if(!r.ok)throw new Error(`HTTP ${r.status}`);
      let html='';let bytes=0;const decoder=new TextDecoder();
      for await(const chunk of r.body){bytes+=chunk.byteLength;if(bytes>1024*1024)throw new Error('文档过大');html+=decoder.decode(chunk,{stream:true});}html+=decoder.decode();
      if(!/<(?:html|table)\b/i.test(html))throw new Error('返回内容不是文档');
      const d={url,fetchedAt:now,checkedAt:now,source:'live',models:parseModelDocument(html),error:null};
      memory.set(key,d);try{writeFileAtomic(file,JSON.stringify(d));}catch{}
      return d;
    }catch(e){const d={url,fetchedAt:cached?.fetchedAt||null,checkedAt:now,source:cached?'cache':'unavailable',models:cached?.models||[],error:e.message};memory.set(key,d);return d;}
  })();
  pending.set(key,task);try{return await task;}finally{pending.delete(key);}
}

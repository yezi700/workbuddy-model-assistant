import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {paths} from './config.mjs';
export function catalogIdentity(cfg,site,auth) {
  const identity=auth.uid || auth.id || crypto.createHash('sha256').update(auth.accessToken || '').digest('hex');
  return crypto.createHash('sha256').update(JSON.stringify([site,cfg.sites[site]?.apiBase,identity,auth.enterpriseId || '',auth.domain || ''])).digest('hex');
}
const file=()=>path.join(paths.root,'model-catalog-cache.json');
function read() {try{if(fs.statSync(file()).size>5*1024*1024)return {};const j=JSON.parse(fs.readFileSync(file(),'utf8'));return j.schema===1 && j.entries && typeof j.entries==='object' ? j.entries : {};}catch{return {};}}
export function readCatalogCache(key) {
  const entry=read()[key];
  if(!entry || !Number.isFinite(entry.fetchedAt) || !Array.isArray(entry.models) || !entry.models.length || entry.models.length>500 || entry.models.some(m=>typeof m.id!=='string'))return null;
  return entry;
}
export function writeCatalogCache(key,entry) {
  const entries=read();entries[key]=entry;
  const bounded=Object.fromEntries(Object.entries(entries).sort((a,b)=>b[1].fetchedAt-a[1].fetchedAt).slice(0,32));
  const temp=file()+'.tmp';
  fs.writeFileSync(temp,JSON.stringify({schema:1,entries:bounded}),{encoding:'utf8',mode:0o600});fs.renameSync(temp,file());
}

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {normalizeChannels}=require('./channels.cjs');

// 解析失败时带上文件路径：原先只有一句 JSON 语法错误，用户不知道该去改哪个文件。
function readJson(file,what){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(e){throw new Error(`${what}无法解析：${file}\n${e.message}\n可用记事本修正，或备份后删除该文件让程序重新生成。`);}
}
function initData(dir) {
  fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'config.json');
  if(fs.existsSync(file)){
    const existing=readJson(file,'配置文件');
    if(existing.channelLayoutVersion===2)return;
    const backup=path.join(dir,'backups','before-workbuddy-channels-'+Date.now());
    fs.mkdirSync(backup,{recursive:true});fs.copyFileSync(file,path.join(backup,'config.json'));
    fs.writeFileSync(file,JSON.stringify(normalizeChannels(existing),null,2)+'\n',{encoding:'utf8',mode:0o600});return;
  }
  const basic={enabled:false,start:'',end:'',startDate:'',endDate:'',site:'cn-cli',timezone:'Asia/Shanghai',outside:'block'};
  const config={host:'127.0.0.1',port:8788,apiKey:'sk-wb-'+crypto.randomBytes(24).toString('hex'),defaultSite:'cn-cli',defaultModel:'step-5-preview',routing:{fallbackMode:'off'},routingPolicies:[
    {model:'deepseek-v4.1-flash',site:'intl-work',enabled:true,requireFree:true,fallbackMode:'off',fallbackSites:[],schedule:{...basic,site:'intl-work'}},
    {model:'step-5-preview',site:'cn-cli',enabled:true,requireFree:true,fallbackMode:'freeOnly',fallbackSites:['cn-cli','intl-work'],schedule:basic},
    {model:'hy4-preview',site:'cn-cli',enabled:false,requireFree:true,fallbackMode:'off',fallbackSites:[],schedule:basic},
  ],sites:{'intl-work':{seedModels:[{id:'auto',name:'Auto'},{id:'deepseek-v4.1-flash',name:'DeepSeek V4.1 Flash'},{id:'step-5-preview',name:'Step-5 Preview'}]}}};
  fs.writeFileSync(file,JSON.stringify(normalizeChannels(config),null,2)+'\n',{encoding:'utf8',mode:0o600});
}
function importData(source,destination) {
  const from=fs.realpathSync(source),to=path.resolve(destination);
  if(from===to)throw new Error('不能从当前数据目录导入');
  const configFile=path.join(from,'config.json');
  if(!fs.existsSync(configFile))throw new Error('所选文件夹里没有 config.json，请选择旧代理的根目录');
  if(!fs.lstatSync(configFile).isFile())throw new Error('配置文件不能是目录或链接');
  const config=readJson(configFile,'旧配置文件');
  if(!Number.isInteger(config.port) || config.port<1024 || config.port>65535)throw new Error('导入配置端口无效');
  config.host='127.0.0.1';normalizeChannels(config);
  const names=fs.readdirSync(from).filter(name=>/^auth(?:\.[a-z0-9-]+(?:\.pool)?)?\.json$/i.test(name));
  const files=names.map(name=>{const file=path.join(from,name);if(!fs.lstatSync(file).isFile())throw new Error('凭证文件不能是目录或链接');const content=fs.readFileSync(file,'utf8');try{JSON.parse(content);}catch(e){throw new Error(`凭证文件 ${name} 无法解析：${e.message}`);}return {name,content};});
  fs.mkdirSync(to,{recursive:true});
  const backup=path.join(to,'backups',new Date().toISOString().replace(/[:.]/g,'-'));
  fs.mkdirSync(backup,{recursive:true});
  for(const name of fs.readdirSync(to).filter(n=>n==='config.json' || /^auth.*\.json$/i.test(n))) {
    const file=path.join(to,name);if(fs.lstatSync(file).isFile()){fs.copyFileSync(file,path.join(backup,name));if(name!=='config.json')fs.unlinkSync(file);}
  }
  fs.writeFileSync(path.join(to,'config.json'),JSON.stringify(config,null,2)+'\n',{encoding:'utf8',mode:0o600});
  for(const {name,content} of files)fs.writeFileSync(path.join(to,name),content,{encoding:'utf8',mode:0o600});
  return {imported_accounts:files.length,backup_dir:backup};
}
module.exports={initData,importData};

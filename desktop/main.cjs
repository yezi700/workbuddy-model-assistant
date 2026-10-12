const {app,BrowserWindow,Tray,Menu,nativeImage,utilityProcess,ipcMain,dialog,shell,Notification}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {ProxyService}=require('./service.cjs');
const {initData,importData}=require('./data.cjs');

const root=path.join(__dirname,'..');
const arg=name=>process.argv.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
const smoke=arg('--smoke-result');
app.setName('WorkBuddy 模型助手');
app.setAppUserModelId('io.github.yezi700.workbuddy-model-assistant');
const userData=arg('--desktop-user-data') || path.join(app.getPath('appData'),'WorkBuddyModelAssistant');
app.setPath('userData',userData);
const dataDir=path.join(userData,'proxy-data');
const startupExecutable=process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
const startupSettings=()=>app.getLoginItemSettings({path:startupExecutable});
const loadingURL=pathToFileURL(path.join(__dirname,'loading.html')).href;
let window,tray,service,quitting=false,closeNotified=false;
let action=Promise.resolve();

function externalAllowed(raw){try{const u=new URL(raw);const host=u.hostname.toLowerCase();return u.protocol==='https:' && (['codebuddy.ai','codebuddy.cn','workbuddy.ai','copilot.tencent.com'].some(d=>host===d || host.endsWith('.'+d)) || (host==='github.com' && u.pathname.startsWith('/yezi700/workbuddy-model-assistant')));}catch{return false;}}
function openExternal(url){if(externalAllowed(url))void shell.openExternal(url);}
function updateTray(){
  if(!tray)return;
  tray.setToolTip('WorkBuddy 模型助手 · '+(service.running?'服务运行中':'服务已停止'));
  tray.setContextMenu(Menu.buildFromTemplate([
    {label:'打开模型助手',click:()=>{window.show();window.focus();}},
    {label:service.running?'停止代理服务':'启动代理服务',click:()=>void perform(service.running?'stop':'start')},
    {label:'重启代理服务',enabled:service.running,click:()=>void perform('restart')},
    {label:'开机自动启动',type:'checkbox',checked:startupSettings().openAtLogin,enabled:app.isPackaged,click:item=>app.setLoginItemSettings({openAtLogin:item.checked,path:startupExecutable})},
    {type:'separator'}, {label:'打开数据目录',click:()=>void shell.openPath(dataDir)},
    {label:'退出并停止服务',click:()=>app.quit()},
  ]));
}
async function perform(operation){
  const run=async()=>{try{await service[operation]();if(service.running)await window.loadURL(service.config().base+'/console');else await window.loadFile(path.join(__dirname,'loading.html'));}catch{await window.loadFile(path.join(__dirname,'loading.html'));}updateTray();return status();};
  action=action.then(run,run);return action;
}
function status(){return {...service.status(),app_version:app.getVersion(),startup:startupSettings().openAtLogin,startup_supported:app.isPackaged,packaged:app.isPackaged};}
function trusted(event){
  if(!window || event.sender.id!==window.webContents.id || event.senderFrame!==window.webContents.mainFrame)throw new Error('仅主窗口可操作桌面功能');
  const url=event.senderFrame.url;
  if(url===loadingURL)return;
  const u=new URL(url);
  if(u.origin!==service.config().base || !['/console','/console/'].includes(u.pathname))throw new Error('不允许此页面操作桌面功能');
}
function handle(name,fn){ipcMain.handle('desktop:'+name,async(event,...args)=>{trusted(event);return fn(...args);});}
async function smokeTest(){
  const report={packaged:app.isPackaged,version:app.getVersion(),checks:[],passed:false};
  const check=(name,condition)=>{report.checks.push({name,passed:!!condition});if(!condition)throw new Error(name);};
  try {
    check('service started',service.running);
    const base=service.config().base;
    const h=await (await fetch(base+'/health')).json();check('bundled service identity',h.desktop_instance===service.instance);
    check('console loads',window.webContents.getURL()===base+'/console');
    const prefs=window.webContents.getLastWebPreferences();check('renderer sandbox',prefs.sandbox && prefs.contextIsolation && !prefs.nodeIntegration);
    window.close();check('close keeps tray and service',!window.isDestroyed() && !window.isVisible() && service.running && !tray.isDestroyed());
    await perform('stop');check('stop service',!service.running);
    await perform('start');check('start service',service.running);
    await perform('restart');check('restart service',service.running);
    // 新配置未登录，无真实上游请求。给页面一点时间完成本机读取。
    await new Promise(resolve=>setTimeout(resolve,1500));
    const html=await (await fetch(service.config().base+'/console')).text();check('beginner interface',html.includes('WorkBuddy 模型助手') && html.includes('quickModels'));
    check('console actually initialized',await window.webContents.executeJavaScript('Boolean(STATE && MODELS && ROUTING)'));
    check('Electron input dialog works',await window.webContents.executeJavaScript(`(async()=>{ const value=askText('测试账号名',''); setTimeout(()=>{const d=document.querySelector('dialog');d.querySelector('input').value='测试账号';d.querySelector('.primary').click();},50);return await value==='测试账号';})()`));
    check('login cancellation stays local',await window.webContents.executeJavaScript(`(async()=>{ const value=startLogin('intl-cli');setTimeout(()=>document.querySelector('dialog .btn').click(),50);await value;return document.getElementById('loginBox').classList.contains('hidden');})()`));
    check('expired read session recovers',await window.webContents.executeJavaScript(`(async()=>{TOKEN='stale-session';const state=await api('/state');return Array.isArray(state.sites);})()`));
    check('expired write is not replayed',await window.webContents.executeJavaScript(`(async()=>{TOKEN='stale-session';try{await api('/default-model',{method:'POST',body:{model:'auto',site:'intl-cli'}});return false;}catch(e){return e.message.includes('刚才的操作未执行');}})()`));
    check('logged out channels hidden by default',await window.webContents.executeJavaScript(`(async()=>{await loadModels();return MODELS.data.length===0;})()`));
    check('logged out catalog cannot be selected',await window.webContents.executeJavaScript(`(async()=>{$('showLoggedOut').checked=true;await loadModels();const ok=MODELS.data.length>0 && MODELS.data.every(m=>m.pending_login && !m.selectable) && !document.querySelector('#modelTable .model-select');$('showLoggedOut').checked=false;await loadModels();return ok;})()`));
    window.show();
    await new Promise(resolve=>setTimeout(resolve,400));
    const image=await window.webContents.capturePage();fs.writeFileSync(smoke.replace(/\.json$/,'.png'),image.toPNG());
    report.passed=true;
  }catch(e){report.error=e.message;}
  await service.stop();checkFinal();
  function checkFinal(){report.checks.push({name:'exit stops owned service',passed:!service.running});fs.writeFileSync(smoke,JSON.stringify(report,null,2));quitting=true;app.exit(report.passed?0:1);}
}

if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{if(window){window.show();window.focus();}});
  app.whenReady().then(async()=>{
    initData(dataDir);
    service=new ProxyService({root,dataDir,fork:utilityProcess.fork});
    window=new BrowserWindow({width:1280,height:920,minWidth:780,minHeight:600,show:!smoke,title:'WorkBuddy 模型助手',backgroundColor:'#f4f6fa',icon:path.join(__dirname,'assets','icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    Menu.setApplicationMenu(null);
    tray=new Tray(nativeImage.createFromPath(path.join(__dirname,'assets','tray.png')));
    tray.on('double-click',()=>{window.show();window.focus();});
    window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();if(!closeNotified && !smoke){closeNotified=true;new Notification({title:'已收起到托盘',body:'代理继续运行。右键任务栏托盘图标可打开窗口，或退出并停止服务。'}).show();}}});
    window.webContents.setWindowOpenHandler(({url})=>{openExternal(url);return {action:'deny'};});
    window.webContents.on('will-navigate',(event,url)=>{let allowed=url===loadingURL;try{const u=new URL(url);allowed ||= u.origin===service.config().base && ['/console','/console/'].includes(u.pathname);}catch{}if(!allowed){event.preventDefault();openExternal(url);}});
    window.webContents.session.setPermissionRequestHandler((_contents,permission,callback)=>callback(['clipboard-sanitized-write'].includes(permission)));
    window.webContents.session.setPermissionCheckHandler((_contents,permission)=>permission==='clipboard-sanitized-write');
    handle('status',()=>status());
    for(const op of ['start','stop','restart'])handle(op,()=>perform(op));
    handle('open-data',()=>shell.openPath(dataDir));
    handle('startup',enabled=>{if(!app.isPackaged)throw new Error('安装或便携版才能设置开机启动');app.setLoginItemSettings({openAtLogin:enabled===true,path:startupExecutable});updateTray();return status();});
    handle('port',async port=>{if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('端口需为 1024–65535 的整数');await service.stop();const file=path.join(dataDir,'config.json');const c=JSON.parse(fs.readFileSync(file,'utf8'));c.port=port;fs.writeFileSync(file,JSON.stringify(c,null,2)+'\n');return perform('start');});
    handle('quit',()=>{setImmediate(()=>app.quit());return {ok:true};});
    handle('import',async()=>{
      const selected=await dialog.showOpenDialog(window,{title:'选择旧代理的文件夹（包含 config.json）',properties:['openDirectory']});
      if(selected.canceled)return {canceled:true};
      const answer=await dialog.showMessageBox(window,{type:'question',buttons:['导入并替换','取消'],defaultId:1,cancelId:1,message:'导入旧配置和登录账号？',detail:'当前桌面版数据会先备份。旧文件夹内容不会修改。若旧服务仍占用相同端口，请先停止它。'});
      if(answer.response!==0)return {canceled:true};
      await service.stop();const result=importData(selected.filePaths[0],dataDir);await perform('start');return result;
    });
    service.on('status',()=>{updateTray();if(!service.running && !service.stopping && !quitting)void window.loadFile(path.join(__dirname,'loading.html'));});
    await window.loadFile(path.join(__dirname,'loading.html'));updateTray();await perform('start');
    if(smoke)await smokeTest();
  }).catch(e=>{if(smoke){fs.writeFileSync(smoke,JSON.stringify({passed:false,error:e.message}));app.exit(1);}else{dialog.showErrorBox('WorkBuddy 模型助手启动失败',e.message);quitting=true;app.quit();}});
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;void action.finally(async()=>{await service?.stop();tray?.destroy();app.quit();});});
  app.on('window-all-closed',()=>{});
}

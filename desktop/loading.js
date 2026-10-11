async function refresh(){const s=await window.desktop.status();document.getElementById('message').textContent=s.error || (s.running?'服务已启动，正在打开首页…':'服务已停止，可以点击启动。');document.getElementById('port').value=s.port;}
async function run(fn){try{await fn();await refresh();}catch(e){document.getElementById('message').textContent=e.message;}}
document.getElementById('start').onclick=()=>run(()=>window.desktop.start());
document.getElementById('import').onclick=()=>run(()=>window.desktop.importData());
document.getElementById('folder').onclick=()=>run(()=>window.desktop.openData());
document.getElementById('change').onclick=()=>run(()=>window.desktop.changePort(Number(document.getElementById('port').value)));
refresh().catch(e=>document.getElementById('message').textContent=e.message);

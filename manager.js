import {buildZip} from './zip.js';
const $=id=>document.getElementById(id);
const sourceId=Number(new URL(location.href).searchParams.get('source'));
const STORE='wm_ui';
let ui={gallery:[],selected:{},key:'',useKey:false},zipRun=null,zipTaskId=null,zipHeartbeat=null;
const store=()=>chrome.storage.local.set({[STORE]:ui});
async function api(type,data={}){const r=await chrome.runtime.sendMessage({type,...data});if(!r?.ok)throw Error(r?.error||'操作失败');return r;}
function toast(s){$('toast').textContent=s;$('toast').style.display='block';setTimeout(()=>$('toast').style.display='none',4500);}
function selected(){return Object.values(ui.selected);}
async function confirmAction(title,text){$('confirm-title').textContent=title;$('confirm-text').textContent=text;$('confirm').showModal();return new Promise(resolve=>{$('confirm-yes').onclick=()=>{$('confirm').close();resolve(true);};$('confirm-no').onclick=()=>{$('confirm').close();resolve(false);};$('confirm').onclose=()=>resolve(false);});}
function renderSelection(){
  const n=selected().length;$('selected-count').textContent=`${n} 张待下载`;
  $('selected-list').replaceChildren();
  for(const x of selected()){
    const b=document.createElement('button');b.textContent=`#${x.id} ×`;b.title=`从已选清单移除 ${x.id}`;
    b.onclick=async()=>{delete ui.selected[x.id];await store();renderSelection();};$('selected-list').append(b);
  }
  $('urls').value=selected().filter(x=>x.url).map(x=>x.url).join('\n');
  $('resolve-status').textContent=`已选 ${n} 张 · 已解析 ${selected().filter(x=>x.url).length} 张`;
  $('gallery').replaceChildren();
  for(const x of ui.gallery){
    const card=document.createElement('label');card.className=`card ${ui.selected[x.id]?'selected':''}`;
    const img=document.createElement('img');img.src=x.thumb;img.alt=`壁纸 ${x.id}`;img.loading='lazy';
    const line=document.createElement('span'),box=document.createElement('input');box.type='checkbox';box.checked=!!ui.selected[x.id];
    box.onchange=async()=>{if(box.checked)ui.selected[x.id]={...x,url:ui.selected[x.id]?.url||''};else delete ui.selected[x.id];await store();renderSelection();};
    line.append(box,`#${x.id}`);card.append(img,line);$('gallery').append(card);
  }
}
async function scan(){
  if(!sourceId)throw Error('请从 Wallhaven 网页点击扩展图标打开管理页');
  const tab=await chrome.tabs.get(sourceId);
  if(!tab.url?.startsWith('https://wallhaven.cc/'))throw Error('来源网页不是 Wallhaven');
  $('source').textContent=tab.url;
  const [r]=await chrome.scripting.executeScript({target:{tabId:sourceId},func:()=>{
    const found=new Map();
    for(const el of document.querySelectorAll('[data-wallpaper-id],a[href*="/w/"]')){
      const id=el.getAttribute('data-wallpaper-id')||el.getAttribute('href')?.match(/\/w\/([a-z0-9]{6})/i)?.[1];
      if(!/^[a-z0-9]{6}$/i.test(id||'')||found.has(id))continue;
      const img=el.querySelector('img')||el.closest('figure')?.querySelector('img');
      const thumb=img?.getAttribute('data-src')||img?.currentSrc||img?.src||`https://th.wallhaven.cc/small/${id.slice(0,2)}/${id}.jpg`;
      found.set(id,{id,thumb});
    }
    return [...found.values()];
  }});
  ui.gallery=r.result||[];await store();
  $('scope').textContent=ui.gallery.length?`当前网页找到 ${ui.gallery.length} 张图片。只对下方勾选的图片执行操作。`:'当前网页没有壁纸缩略图；如果这里是收藏夹首页，请进入具体收藏夹后再读取。';
  renderSelection();
}
async function resolveFromSite(id){
  if(!sourceId)throw Error('请从已登录的 Wallhaven 网页点击扩展图标打开管理页');
  const tab=await chrome.tabs.get(sourceId);
  if(!tab.url?.startsWith('https://wallhaven.cc/'))throw Error('来源标签页已关闭或不是 Wallhaven');
  const [r]=await chrome.scripting.executeScript({target:{tabId:sourceId},args:[id],func:async imageId=>{
    const response=await fetch(`/w/${imageId}`,{credentials:'include'});
    if(!response.ok)throw Error(`图片详情页 HTTP ${response.status}`);
    const doc=new DOMParser().parseFromString(await response.text(),'text/html');
    const src=doc.querySelector('img#wallpaper')?.getAttribute('src')||doc.querySelector('img#wallpaper')?.getAttribute('data-src');
    if(!src)throw Error('详情页中没有找到原图；请确认已登录且可以手动打开这张图片');
    return new URL(src,response.url).href;
  }});
  return r.result;
}
async function resolveFromApi(id){
  if(!ui.key)throw Error('未填写 API Key');
  const r=await fetch(`https://wallhaven.cc/api/v1/w/${id}`,{headers:{'X-API-Key':ui.key}});
  if(!r.ok)throw Error(`API HTTP ${r.status}`);
  const j=await r.json();return j.data?.path;
}
async function resolveUrls(){
  const list=selected();if(!list.length)throw Error('请先勾选图片');
  for(let i=0;i<list.length;i++){
    const x=list[i];if(x.url)continue;
    $('resolve-status').textContent=`解析中 ${i+1}/${list.length}：${x.id}`;
    let raw,apiError='';
    if(ui.useKey){try{raw=await resolveFromApi(x.id);}catch(e){apiError=e.message;}}
    if(!raw){try{raw=await resolveFromSite(x.id);}catch(e){throw Error(`${x.id} 解析失败：${e.message}${apiError?`（API：${apiError}）`:''}`);}}
    const u=new URL(raw||'');
    if(u.protocol!=='https:'||u.hostname!=='w.wallhaven.cc'||!/^\/full\/[a-z0-9]{2}\/wallhaven-[a-z0-9]{6}\.(jpg|png)$/i.test(u.pathname))throw Error(`${x.id} 的原图地址不符合预期`);
    ui.selected[x.id].url=u.href;await store();renderSelection();
    if(i<list.length-1)await new Promise(r=>setTimeout(r,1400));
  }
  toast(`已解析 ${list.length} 张图片的真实 URL`);
}
async function readyItems(){const list=selected();if(!list.length)throw Error('请先勾选图片');if(list.some(x=>!x.url))await resolveUrls();return selected().map(x=>({id:x.id,url:x.url}));}
async function refreshTasks(){
  const tasks=(await api('tasks')).tasks;$('tasks').replaceChildren();
  if(!tasks.length){$('tasks').textContent='尚无任务。';return;}
  for(const t of tasks){
    const done=t.items.filter(x=>x.status==='done').length,remaining=t.items.length-done;
    const div=document.createElement('div');div.className='task';
    const h=document.createElement('h3');h.textContent=`${t.mode==='zip'?'单个 ZIP':'逐张保存'} · ${t.items.length} 张 · ${t.id.slice(0,8)}`;
    const p=document.createElement('p');p.textContent=`状态：${({paused:'已暂停',running:'进行中',saving:'等待 ZIP 保存',done:'已完成',cancelled:'已取消'})[t.status]||t.status} · 已完成 ${done} 张 · 剩余 ${remaining} 张${t.error?' · '+t.error:''}`;
    const active=t.items.find(x=>x.status==='downloading'&&x.downloadId!=null);
    if(active){try{const [d]=await chrome.downloads.search({id:active.downloadId});if(d)p.textContent+=` · 当前 ${active.id}: ${Math.round((d.bytesReceived||0)/1048576*10)/10} MB / ${d.totalBytes>0?`${Math.round(d.totalBytes/1048576*10)/10} MB`:'大小未知'}`;}catch{}}
    const progress=document.createElement('progress');progress.max=t.items.length;progress.value=done;
    const buttons=document.createElement('div');buttons.className='toolbar';
    if(t.status==='paused'){
      const go=document.createElement('button');go.className='primary';go.textContent=t.mode==='zip'?'继续制作并保存 ZIP':'继续逐张保存';
      go.onclick=()=>run(async()=>{
        const count=t.items.filter(x=>x.status!=='done'&&x.status!=='cancelled').length;
        const dialogs=t.mode==='zip'?1:count;
        if(!await confirmAction(`确认本次任务：${count} 张图片`,`模式：${t.mode==='zip'?'生成 1 个 ZIP 文件':'逐张保存'}。Chrome 开启“每次询问保存位置”时，预计出现 ${dialogs} 次保存窗口。已完成 ${done} 张，剩余 ${count} 张。确认后才会继续。`))return;
        if(t.mode==='zip')await startZip(t);else await api('start',{id:t.id});
      });buttons.append(go);
    }
    if(t.status==='running'){
      const pause=document.createElement('button');pause.textContent='暂停后续下载';pause.onclick=()=>run(async()=>{if(t.mode==='zip'){zipRun?.abort();await api('update',{id:t.id,status:'paused'});}else await api('pause',{id:t.id});});buttons.append(pause);
    }
    if(!['done','cancelled'].includes(t.status)){
      const cancel=document.createElement('button');cancel.textContent='取消此任务';cancel.onclick=()=>run(async()=>{
        if(!await confirmAction('取消任务',`取消任务 ${t.id.slice(0,8)}？未完成的 ${remaining} 张将不再下载。`))return;
        if(zipTaskId===t.id)zipRun?.abort();await api('cancel',{id:t.id});
      });buttons.append(cancel);
    }
    div.append(h,p,progress,buttons);$('tasks').append(div);
  }
}
async function startZip(t){
  if(zipRun)throw Error('已有 ZIP 任务运行中');
  zipRun=new AbortController();zipTaskId=t.id;const signal=zipRun.signal;
  try{await api('update',{id:t.id,status:'running',error:'',heartbeat:true});}catch(e){zipRun=null;zipTaskId=null;throw e;}
  zipHeartbeat=setInterval(()=>api('update',{id:t.id,heartbeat:true}).catch(()=>{}),2000);
  try{
    const file=await buildZip(t,items=>api('update',{id:t.id,items}),signal);
    if(signal.aborted)throw Error('已暂停');
    await api('update',{id:t.id,status:'saving',items:t.items});
    const blob=URL.createObjectURL(file);
    try{
      const id=await chrome.downloads.download({url:blob,filename:`Wallhaven/wallhaven-${t.id.slice(0,8)}.zip`,saveAs:false,conflictAction:'uniquify'});
      while(true){
        if(signal.aborted)throw Error('已暂停');
        const [d]=await chrome.downloads.search({id});
        if(d?.state==='complete')break;
        if(d?.state==='interrupted')throw Error(`ZIP 保存中断：${d.error}`);
        await new Promise(r=>setTimeout(r,1000));
      }
      await api('update',{id:t.id,status:'done',items:t.items});toast('ZIP 已保存完成');
    }finally{URL.revokeObjectURL(blob);}
  }catch(e){
    const now=(await api('tasks')).tasks.find(x=>x.id===t.id);
    if(now?.status!=='cancelled')await api('update',{id:t.id,status:'paused',items:t.items,error:e.message});
    if(!signal.aborted)toast(e.message);
  }finally{clearInterval(zipHeartbeat);zipHeartbeat=null;zipRun=null;zipTaskId=null;refreshTasks();}
}
async function run(fn){try{await fn();await refreshTasks();}catch(e){toast(e.message);}}
(async()=>{
  ui={...ui,...(await chrome.storage.local.get(STORE))[STORE]};ui.selected ||= {};ui.gallery ||= [];
  $('key').value=ui.key||'';
  $('use-key').checked=!!ui.useKey;
  $('use-key').onchange=async()=>{ui.useKey=$('use-key').checked;await store();toast(ui.useKey?'优先使用 API Key，失败后回退网站登录状态':'使用网站登录状态解析');};
  $('save-key').onclick=()=>run(async()=>{ui.key=$('key').value.trim();ui.useKey=$('use-key').checked;await store();toast('解析设置已保存于本机');});
  $('scan').onclick=()=>run(scan);
  $('select-all').onclick=()=>run(async()=>{for(const x of ui.gallery)ui.selected[x.id]={...x,url:ui.selected[x.id]?.url||''};await store();renderSelection();});
  $('select-none').onclick=()=>run(async()=>{for(const x of ui.gallery)delete ui.selected[x.id];await store();renderSelection();});
  $('clear').onclick=()=>run(async()=>{ui.selected={};await store();renderSelection();});
  $('resolve').onclick=()=>run(resolveUrls);
  $('copy').onclick=()=>run(async()=>{const list=await readyItems();await navigator.clipboard.writeText(list.map(x=>x.url).join('\n'));toast(`已复制 ${list.length} 条 URL`);});
  $('txt').onclick=()=>run(async()=>{const list=await readyItems();if(!await confirmAction('保存 URL 文本',`${list.length} 条 URL，每行 1 条。本次将产生 1 次 Chrome 下载保存窗口。`))return;const blob=URL.createObjectURL(new Blob([list.map(x=>x.url).join('\n')+'\n'],{type:'text/plain'}));try{await chrome.downloads.download({url:blob,filename:'Wallhaven/wallhaven-urls.txt',saveAs:false,conflictAction:'uniquify'});}finally{setTimeout(()=>URL.revokeObjectURL(blob),60000);}});
  $('create-files').onclick=()=>run(async()=>{const items=await readyItems();await api('create',{mode:'files',label:'逐张保存',items});toast(`已建立 ${items.length} 张的任务；尚未下载`);});
  $('create-zip').onclick=()=>run(async()=>{const items=await readyItems();await api('create',{mode:'zip',label:'单个 ZIP',items});toast(`已建立 ${items.length} 张的 ZIP 任务；尚未下载`);});
  renderSelection();await refreshTasks();
  await refreshTasks();
  if(sourceId)await run(scan);
  setInterval(async()=>{
    const tasks=(await api('tasks')).tasks;
    for(const t of tasks)if(t.mode==='zip'&&['running','saving'].includes(t.status)&&Date.now()-(t.heartbeat||0)>6000){
      await api('update',{id:t.id,status:'paused',error:'管理页关闭后已暂停，请手动继续'});
    }
    refreshTasks();
  },2000);
})();

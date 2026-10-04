const TASKS='wm_tasks', SETTINGS='wm_download_settings', COUNTERS='wm_folder_counters';
const defaults={dir:'Wallhaven',taskFolder:false,intervalSec:0,timeoutSec:0,autoRetry:false,retryCount:2,retryDelaySec:5};
let chain=Promise.resolve();
const lock=fn=>{const p=chain.then(fn,fn);chain=p.catch(()=>{});return p;};
const load=async()=>((await chrome.storage.local.get(TASKS))[TASKS]||[]);
const save=tasks=>chrome.storage.local.set({[TASKS]:tasks});
const loadSettings=async()=>({...defaults,...(await chrome.storage.local.get(SETTINGS))[SETTINGS]});
function pathPart(value){
  const dir=String(value??'').trim().replaceAll('\\','/');
  if(!dir)return '';
  const parts=dir.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[:*?"<>|\x00-\x1f]/.test(p)||/[. ]$/.test(p)))throw Error('子目录只能使用相对路径，不能包含空段、.. 或 Windows 禁用字符');
  if(dir.length>180)throw Error('子目录过长');
  return parts.join('/');
}
function integer(value,min,max,label){const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw Error(`${label}必须为 ${min}–${max} 的整数`);return n;}
function normalize(raw){return {
  dir:pathPart(raw.dir),taskFolder:!!raw.taskFolder,
  intervalSec:integer(raw.intervalSec,0,300,'下载间隔'),
  timeoutSec:integer(raw.timeoutSec,0,3600,'无进度超时'),
  autoRetry:!!raw.autoRetry,
  retryCount:integer(raw.retryCount,0,5,'重试次数'),
  retryDelaySec:integer(raw.retryDelaySec,1,300,'重试等待')
};}
function folderDate(date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
async function taskDirectory(settings){
  if(!settings.taskFolder)return settings.dir;
  const date=folderDate(new Date()),counters=(await chrome.storage.local.get(COUNTERS))[COUNTERS]||{};
  const n=(counters[date]||0)+1;counters[date]=n;await chrome.storage.local.set({[COUNTERS]:counters});
  const sub=`${date}_${String(n).padStart(4,'0')}`;
  return [settings.dir,sub].filter(Boolean).join('/');
}
function nameInTask(task,name){return [task.relativeDir??'Wallhaven',name].filter(Boolean).join('/');}
chrome.action.onClicked.addListener(tab=>chrome.tabs.create({url:chrome.runtime.getURL(`manager.html?source=${tab.id}`)}));
function schedule(task){
  if(task.status!=='running'||task.mode!=='files')return;
  const wait=Math.max(0,(task.nextAt||0)-Date.now());
  if(wait<=0){setTimeout(()=>pump(task.id),0);return;}
  if(wait<30000)setTimeout(()=>pump(task.id),wait);
  chrome.alarms.create(`wm-next-${task.id}`,{when:Date.now()+Math.max(wait,30000)}).catch(()=>{});
}
async function submitNext(tasks,task){
  if(task.status!=='running'||task.mode!=='files')return;
  if(tasks.some(t=>t.id!==task.id&&t.status==='running'&&t.mode==='files'))return;
  if(task.items.some(x=>x.status==='downloading'||x.status==='submitting'))return;
  if((task.nextAt||0)>Date.now()){schedule(task);return;}
  const item=task.items.find(x=>x.status==='pending');
  if(!item){task.status='done';await save(tasks);return;}
  item.status='submitting';item.error='';await save(tasks);
  const options={url:item.url,filename:nameInTask(task,item.url.split('/').pop()),saveAs:false,conflictAction:'uniquify'};
  chrome.downloads.download(options).then(id=>lock(async()=>{
    const fresh=await load(),t=fresh.find(x=>x.id===task.id),i=t?.items.find(x=>x.id===item.id);
    if(!i||i.status==='cancelled'||t.status==='cancelled'){try{await chrome.downloads.cancel(id);}catch{}return;}
    i.downloadId=id;i.status='downloading';i.lastProgressAt=Date.now();i.bytesReceived=0;await save(fresh);
    const [d]=await chrome.downloads.search({id});
    if(d?.state==='complete')await completed(fresh,t,i);
    else if(d?.state==='interrupted')await failed(fresh,t,i,d.error||'下载中断');
  })).catch(error=>lock(async()=>{
    const fresh=await load(),t=fresh.find(x=>x.id===task.id),i=t?.items.find(x=>x.id===item.id);
    if(t&&i&&i.status==='submitting')await failed(fresh,t,i,error.message||String(error));
  }));
}
async function pump(id){return lock(async()=>{const tasks=await load(),task=tasks.find(t=>t.id===id);if(task)await submitNext(tasks,task);});}
async function completed(tasks,task,item){
  item.status='done';item.downloadId=null;item.error='';task.nextAt=Date.now()+(task.settings?.intervalSec||0)*1000;
  await save(tasks);schedule(task);
}
async function failed(tasks,task,item,error){
  item.downloadId=null;item.attempts=(item.attempts||0)+1;item.error=String(error);
  const s=task.settings||defaults;
  const mayRetry=s.autoRetry&&item.attempts<=s.retryCount&&!/USER_|cancel/i.test(item.error)&&task.status==='running';
  if(mayRetry){item.status='pending';task.nextAt=Date.now()+Math.min(300000,s.retryDelaySec*1000*2**(item.attempts-1));}
  else{item.status='error';task.status='paused';}
  await save(tasks);if(mayRetry)schedule(task);
}
chrome.runtime.onMessage.addListener((m,_sender,reply)=>{
  lock(async()=>{
    if(m.type==='settings')return {ok:true,settings:await loadSettings()};
    if(m.type==='saveSettings'){
      const settings=normalize(m.settings||{});await chrome.storage.local.set({[SETTINGS]:settings});return {ok:true,settings};
    }
    const tasks=await load();let task;
    if(m.type==='tasks')return {ok:true,tasks};
    if(m.type==='create'){
      if(!['files','zip'].includes(m.mode)||!Array.isArray(m.items)||!m.items.length)throw Error('任务内容无效');
      const settings=normalize(await loadSettings()),id=crypto.randomUUID();
      task={id,mode:m.mode,label:m.label||'Wallhaven 图片',createdAt:Date.now(),status:'paused',settings,relativeDir:await taskDirectory(settings),nextAt:0,
        items:m.items.map(x=>({id:x.id,url:x.url,status:'pending',downloadId:null,attempts:0,error:''}))};
      tasks.unshift(task);await save(tasks);return {ok:true,task};
    }
    task=tasks.find(t=>t.id===m.id);if(!task)throw Error('找不到任务');
    if(m.type==='start'){
      if(task.mode!=='files')throw Error('ZIP 任务请在管理页启动');
      if(tasks.some(t=>t.id!==task.id&&t.status==='running'&&t.mode==='files'))throw Error('已有单文件任务运行中');
      for(const x of task.items)if(x.status==='error'){x.status='pending';x.attempts=0;}
      task.status='running';task.nextAt=0;await save(tasks);await submitNext(tasks,task);
    }else if(m.type==='pause'){
      task.status='paused';await save(tasks);
    }else if(m.type==='cancel'){
      task.status='cancelled';
      for(const x of task.items){
        if(x.status==='downloading'&&x.downloadId!=null){const id=x.downloadId;x.downloadId=null;try{await chrome.downloads.cancel(id);}catch{}}
        if(['pending','submitting','downloading','error'].includes(x.status)){x.status='cancelled';x.downloadId=null;}
      }
      await save(tasks);
    }else if(m.type==='update'){
      if(task.mode!=='zip')throw Error('任务类型错误');
      if(m.status==='running'&&task.status==='running')throw Error('该 ZIP 任务已在另一个管理页运行');
      if(m.status==='running'&&tasks.some(t=>t.id!==task.id&&t.mode==='zip'&&t.status==='running'))throw Error('已有 ZIP 任务运行中');
      task.status=m.status||task.status;
      if(m.heartbeat)task.heartbeat=Date.now();
      if(m.items)task.items=m.items;
      if(m.error!==undefined)task.error=m.error;
      await save(tasks);
    }else throw Error('未知操作');
    return {ok:true,task};
  }).then(reply).catch(e=>reply({ok:false,error:e.message}));return true;
});
chrome.downloads.onChanged.addListener(d=>{
  if(!d.state)return;
  lock(async()=>{
    const tasks=await load(),task=tasks.find(t=>t.items.some(x=>x.downloadId===d.id));if(!task)return;
    const item=task.items.find(x=>x.downloadId===d.id);
    if(d.state.current==='complete')await completed(tasks,task,item);
    else if(d.state.current==='interrupted')await failed(tasks,task,item,d.error?.current||'下载中断');
  });
});
async function watchdog(){return lock(async()=>{
  const tasks=await load();
  for(const task of tasks){
    if(task.status!=='running'||task.mode!=='files')continue;
    const item=task.items.find(x=>x.status==='downloading'&&x.downloadId!=null);if(!item)continue;
    const [d]=await chrome.downloads.search({id:item.downloadId});
    if(!d)continue;
    if(d.state==='complete'){await completed(tasks,task,item);continue;}
    if(d.state==='interrupted'){await failed(tasks,task,item,d.error||'下载中断');continue;}
    if(d.bytesReceived>=(item.bytesReceived||0)+1){item.bytesReceived=d.bytesReceived;item.lastProgressAt=Date.now();await save(tasks);}
    const timeout=(task.settings?.timeoutSec||0)*1000;
    if(timeout&&Date.now()-(item.lastProgressAt||Date.now())>=timeout){
      const id=item.downloadId;item.downloadId=null;try{await chrome.downloads.cancel(id);}catch{}
      await failed(tasks,task,item,'无进度超时');
    }
  }
});}
chrome.alarms.create('wm-watchdog',{periodInMinutes:0.5}).catch(()=>{});
chrome.alarms.onAlarm.addListener(a=>{if(a.name==='wm-watchdog')watchdog();else if(a.name.startsWith('wm-next-'))pump(a.name.slice(8));});
async function pauseAtStartup(){await lock(async()=>{
  const tasks=await load();
  for(const t of tasks)if(t.status==='running'||t.status==='saving'){
    t.status='paused';
    for(const x of t.items){
      if(x.status==='downloading'&&x.downloadId!=null){const id=x.downloadId;x.downloadId=null;try{await chrome.downloads.cancel(id);}catch{}x.status='pending';}
      if(x.status==='submitting')x.status='pending';
    }
  }
  await save(tasks);
});}
chrome.runtime.onStartup.addListener(pauseAtStartup);
chrome.runtime.onInstalled.addListener(pauseAtStartup);

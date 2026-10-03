const KEY='wm_tasks';
let chain=Promise.resolve();
const lock=fn=>{const p=chain.then(fn,fn);chain=p.catch(()=>{});return p;};
const load=async()=>((await chrome.storage.local.get(KEY))[KEY]||[]);
const save=tasks=>chrome.storage.local.set({[KEY]:tasks});
chrome.action.onClicked.addListener(tab=>chrome.tabs.create({url:chrome.runtime.getURL(`manager.html?source=${tab.id}`)}));
async function submitNext(tasks,task){
  if(task.status!=='running'||task.mode!=='files')return;
  if(tasks.some(t=>t.id!==task.id&&t.status==='running'&&t.mode==='files'))return;
  if(task.items.some(x=>x.status==='downloading'||x.status==='submitting'))return;
  const item=task.items.find(x=>x.status==='pending');
  if(!item){task.status='done';await save(tasks);return;}
  item.status='submitting';await save(tasks);
  try{
    item.downloadId=await chrome.downloads.download({url:item.url,filename:`Wallhaven/${item.url.split('/').pop()}`,saveAs:false,conflictAction:'uniquify'});
    item.status='downloading';
  }catch(e){item.status='error';item.error=String(e.message||e);task.status='paused';}
  await save(tasks);
}
chrome.runtime.onMessage.addListener((m,_sender,reply)=>{
  lock(async()=>{
    const tasks=await load();let task;
    if(m.type==='tasks')return {ok:true,tasks};
    if(m.type==='create'){
      const id=crypto.randomUUID();
      task={id,mode:m.mode,label:m.label||'Wallhaven 图片',createdAt:Date.now(),status:'paused',items:m.items.map(x=>({id:x.id,url:x.url,status:'pending',downloadId:null,error:''}))};
      tasks.unshift(task);await save(tasks);return {ok:true,task};
    }
    task=tasks.find(t=>t.id===m.id);if(!task)throw Error('找不到任务');
    if(m.type==='start'){
      if(task.mode!=='files')throw Error('ZIP 任务请在管理页启动');
      if(tasks.some(t=>t.id!==task.id&&t.status==='running'&&t.mode==='files'))throw Error('已有单文件任务运行中');
      for(const x of task.items)if(x.status==='error')x.status='pending';
      task.status='running';await save(tasks);await submitNext(tasks,task);
    }else if(m.type==='pause'){
      task.status='paused';await save(tasks);
    }else if(m.type==='cancel'){
      task.status='cancelled';
      for(const x of task.items){
        if(x.status==='downloading'&&x.downloadId!=null){try{await chrome.downloads.cancel(x.downloadId);}catch{}}
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
      if(m.error)task.error=m.error;
      await save(tasks);
    }else throw Error('未知操作');
    return {ok:true,task};
  }).then(reply).catch(e=>reply({ok:false,error:e.message}));return true;
});
chrome.downloads.onChanged.addListener(d=>{
  if(!d.state)return;
  lock(async()=>{
    const tasks=await load();const task=tasks.find(t=>t.items.some(x=>x.downloadId===d.id));if(!task)return;
    const item=task.items.find(x=>x.downloadId===d.id);
    if(d.state.current==='complete'){item.status='done';item.downloadId=null;}
    if(d.state.current==='interrupted'){item.status='error';item.error=d.error?.current||'下载中断';item.downloadId=null;task.status='paused';}
    await save(tasks);
    if(task.status==='running'&&d.state.current==='complete')await submitNext(tasks,task);
  });
});
async function pauseAtStartup(){await lock(async()=>{
  const tasks=await load();
  for(const t of tasks)if(t.status==='running'||t.status==='saving'){
    t.status='paused';
    for(const x of t.items)if(x.status==='downloading'&&x.downloadId!=null){
      try{await chrome.downloads.cancel(x.downloadId);}catch{}
      x.status='pending';x.downloadId=null;
    }
  }
  await save(tasks);
});}
chrome.runtime.onStartup.addListener(pauseAtStartup);
chrome.runtime.onInstalled.addListener(pauseAtStartup);

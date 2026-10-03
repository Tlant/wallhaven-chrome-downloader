import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
let state={},downloads=[],onMessage,onChanged,onStartup;
const chrome={
  storage:{local:{get:async key=>({[key]:state[key]}),set:async x=>Object.assign(state,x)}},
  action:{onClicked:{addListener(){}}},tabs:{create:async()=>{},},runtime:{getURL:x=>x,onMessage:{addListener:f=>onMessage=f},onStartup:{addListener:f=>onStartup=f},onInstalled:{addListener(){}}},
  downloads:{download:async x=>{downloads.push(x);return downloads.length},cancel:async()=>{},onChanged:{addListener:f=>onChanged=f}}
};
vm.runInNewContext(fs.readFileSync('background.js','utf8'),{chrome,crypto:globalThis.crypto,console});
const send=m=>new Promise((resolve,reject)=>onMessage(m,null,x=>x.ok?resolve(x):reject(Error(x.error))));
const items=['aabbcc','ddeeff','112233'].map(id=>({id,url:`https://w.wallhaven.cc/full/${id.slice(0,2)}/wallhaven-${id}.jpg`}));
const created=await send({type:'create',mode:'files',items});
assert.equal(downloads.length,0,'creating a task must not download');
assert.equal(created.task.status,'paused');
await send({type:'start',id:created.task.id});
assert.equal(downloads.length,1);
onChanged({id:1,state:{current:'complete'}});
await new Promise(r=>setTimeout(r,10));
assert.equal(downloads.length,2);
await send({type:'pause',id:created.task.id});
onChanged({id:2,state:{current:'complete'}});
await new Promise(r=>setTimeout(r,10));
assert.equal(downloads.length,2,'pause must prevent the next download');
await onStartup();
assert.equal((await send({type:'tasks'})).tasks[0].status,'paused');
console.log('background task safety checks passed');

import fs from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
let bytes=new Uint8Array(),cursor=0;
const handle={
  getFile:async()=>new Blob([bytes]),
  createWritable:async()=>({
    truncate:async n=>{bytes=bytes.slice(0,n);},
    seek:async n=>{cursor=n;},
    write:async chunk=>{const part=new Uint8Array(chunk),next=new Uint8Array(Math.max(bytes.length,cursor+part.length));next.set(bytes);next.set(part,cursor);bytes=next;cursor+=part.length;},
    close:async()=>{}
  })
};
Object.defineProperty(globalThis,'navigator',{value:{storage:{getDirectory:async()=>({getFileHandle:async()=>handle})}},configurable:true});
let secondFails=true;
globalThis.fetch=async url=>{
  if(url.includes('ddeeff')&&secondFails){secondFails=false;throw Error('network interruption');}
  return new Response(new TextEncoder().encode(url.includes('ddeeff')?'second-data':'wallpaper-data'),{status:200,headers:{'content-type':'image/jpeg'}});
};
const source=fs.readFileSync('zip.js','utf8');
const {buildZip}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const task={id:'test',items:[
  {id:'aabbcc',url:'https://w.wallhaven.cc/full/aa/wallhaven-aabbcc.jpg',status:'pending'},
  {id:'ddeeff',url:'https://w.wallhaven.cc/full/dd/wallhaven-ddeeff.jpg',status:'pending'}
]};
await assert.rejects(buildZip(task,async()=>{},new AbortController().signal));
assert.equal(task.items[0].status,'done');
await buildZip(task,async()=>{},new AbortController().signal);
assert.equal(task.items[1].status,'done');
fs.writeFileSync(path.join(os.tmpdir(),'wallhaven-test.zip'),bytes);
console.log('ZIP bytes:',bytes.length);

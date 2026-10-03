const enc=new TextEncoder();
const u16=(a,o,v)=>new DataView(a.buffer).setUint16(o,v,true);
const u32=(a,o,v)=>new DataView(a.buffer).setUint32(o,v>>>0,true);
const table=Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crcNext(c,bytes){for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return c>>>0;}
function local(name){const n=enc.encode(name),a=new Uint8Array(30+n.length);u32(a,0,0x04034b50);u16(a,4,20);u16(a,6,8);u16(a,8,0);u16(a,26,n.length);a.set(n,30);return a;}
function descriptor(crc,size){const a=new Uint8Array(16);u32(a,0,0x08074b50);u32(a,4,crc);u32(a,8,size);u32(a,12,size);return a;}
function central(name,z){const n=enc.encode(name),a=new Uint8Array(46+n.length);u32(a,0,0x02014b50);u16(a,4,20);u16(a,6,20);u16(a,8,8);u32(a,16,z.crc);u32(a,20,z.size);u32(a,24,z.size);u16(a,28,n.length);u32(a,42,z.offset);a.set(n,46);return a;}
function end(count,size,offset){const a=new Uint8Array(22);u32(a,0,0x06054b50);u16(a,8,count);u16(a,10,count);u32(a,12,size);u32(a,16,offset);return a;}
export async function buildZip(task,onItem,signal){
  const root=await navigator.storage.getDirectory();
  const handle=await root.getFileHandle(`${task.id}.zip`,{create:true});
  let offset=0;
  for(const x of task.items){if(x.status==='done'&&x.zip)offset=x.zip.end;else break;}
  const old=await handle.getFile();
  if(old.size<offset)throw Error('ZIP 临时文件缺失或损坏，请新建任务');
  const out=await handle.createWritable({keepExistingData:true});
  try{
    await out.truncate(offset);await out.seek(offset);
    for(const x of task.items){
      if(x.status==='done'&&x.zip)continue;
      if(signal.aborted)throw Error('已暂停');
      const name=`wallhaven-${x.id}.${x.url.split('.').pop().toLowerCase()}`;
      const start=offset,head=local(name);await out.write(head);offset+=head.length;
      const r=await fetch(x.url,{credentials:'include',signal});
      if(!r.ok)throw Error(`${x.id}: HTTP ${r.status}`);
      if(!r.headers.get('content-type')?.startsWith('image/'))throw Error(`${x.id}: 返回内容不是图片`);
      let crc=0xffffffff,size=0;
      for await(const chunk of r.body){
        if(signal.aborted)throw Error('已暂停');
        size+=chunk.length;
        if(size>0xffffffff)throw Error('单张图片超过 ZIP 格式上限');
        crc=crcNext(crc,chunk);await out.write(chunk);offset+=chunk.length;
      }
      crc=(crc^0xffffffff)>>>0;
      const desc=descriptor(crc,size);await out.write(desc);offset+=desc.length;
      x.status='done';x.zip={offset:start,size,crc,end:offset};await onItem(task.items);
    }
    if(task.items.length>65535||offset>0xffffffff)throw Error('ZIP 超过 4GB 或 65535 项上限，请分批建立任务');
    const start=offset;
    for(const x of task.items){const bytes=central(`wallhaven-${x.id}.${x.url.split('.').pop().toLowerCase()}`,x.zip);await out.write(bytes);offset+=bytes.length;}
    await out.write(end(task.items.length,offset-start,start));
    await out.close();
    return await handle.getFile();
  }catch(e){await out.close();throw e;}
}

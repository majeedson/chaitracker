import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=(await fs.readFile(new URL('../src/attendancePhoto.js',import.meta.url),'utf8')).replaceAll('export ','');
function harness({bitmap=true,bitmapError=false,toBlob=true,encodeError=false,invalidSize=false}={}){
  const calls=[],canvas={width:0,height:0,getContext:()=>({fillRect(){},drawImage(){calls.push(['draw',canvas.width,canvas.height]);}}),toDataURL:()=> 'data:image/jpeg;base64,/9j/'};
  if(toBlob)canvas.toBlob=(fn,type)=>{calls.push(['encode',type]);fn(encodeError?null:new Blob(['photo'],{type}));};
  class Image {naturalWidth=invalidSize?10:4000;naturalHeight=invalidSize?10:3000;set src(value){if(value)queueMicrotask(()=>this.onload?.());}}
  const context=vm.createContext({Blob,Uint8Array,atob,Image,queueMicrotask,setTimeout,clearTimeout,document:{createElement:()=>canvas},URL:{createObjectURL:()=>{calls.push(['url']);return 'blob:test';},revokeObjectURL:()=>calls.push(['revoke'])}});
  if(bitmap)context.createImageBitmap=async(file,options)=>{calls.push(['bitmap',options.resizeWidth]);if(bitmapError)throw Error('Unsupported');return {width:960,height:1280,close:()=>calls.push(['close'])};};
  vm.runInContext(source,context);return {context,calls,canvas};
}
test('large portrait selfie becomes a bounded JPEG and releases its pixel buffers',async()=>{
  const h=harness(),blob=await h.context.prepareAttendancePhoto(new Blob(['original'],{type:'image/jpeg'}));
  assert.equal(blob.type,'image/jpeg');assert.ok(blob.size<=512*1024);assert.deepEqual(h.calls.find(x=>x[0]==='draw'),['draw',720,960]);assert.ok(h.calls.some(x=>x[0]==='close'));assert.equal(h.canvas.width,1);
});
test('older phones without bitmap or toBlob support still produce a small JPEG',async()=>{
  for(const options of [{bitmap:false,toBlob:false},{bitmapError:true}]){
    const h=harness(options),blob=await h.context.prepareAttendancePhoto(new Blob(['original'],{type:'image/jpeg'}));
    assert.equal(blob.type,'image/jpeg');assert.deepEqual(h.calls.find(x=>x[0]==='draw'),['draw',960,720]);assert.ok(h.calls.some(x=>x[0]==='revoke'));
  }
});
test('invalid images and encoder failures release resources and provide retry guidance',async()=>{
  for(const options of [{bitmap:false,invalidSize:true},{encodeError:true}]){
    const h=harness(options);await assert.rejects(h.context.prepareAttendancePhoto(new Blob(['original'],{type:'image/jpeg'})));assert.equal(h.canvas.width,1);assert.ok(h.calls.some(x=>['close','revoke'].includes(x[0])));
  }
  const h=harness();await assert.rejects(h.context.prepareAttendancePhoto(new Blob([])),/Take a selfie/);assert.match(h.context.attendancePhotoError(Error('maxMemoryUsageInMB limit exceeded by at least 11MB')),/Refresh the app/);
});

// Keep server decoding and older phones within a small, predictable image budget.
const MAX_EDGE=960;
const MAX_BYTES=512*1024;
const PHOTO_ERROR='Could not prepare the selfie. Please retake it, or use a lower camera resolution.';

async function loadPhoto(file){
  if(typeof globalThis.createImageBitmap==='function'){
    try{
      // Native resize avoids a full-size JavaScript pixel buffer. A single width
      // preserves aspect ratio; the canvas also bounds tall portrait images.
      const bitmap=await globalThis.createImageBitmap(file,{resizeWidth:MAX_EDGE,resizeQuality:'low'});
      return {image:bitmap,width:bitmap.width,height:bitmap.height,release:()=>bitmap.close()};
    }catch{/* Older browsers may not implement bitmap options. Use their image decoder. */}
  }
  const image=new Image(),url=URL.createObjectURL(file);
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{image.onload=image.onerror=null;image.src='';reject(new Error(PHOTO_ERROR));},20000);
      image.onload=()=>{clearTimeout(timer);resolve();};
      image.onerror=()=>{clearTimeout(timer);reject(new Error(PHOTO_ERROR));};
      image.src=url;
    });
    return {image,width:image.naturalWidth,height:image.naturalHeight,release:()=>{image.onload=image.onerror=null;image.src='';URL.revokeObjectURL(url);}};
  }catch(error){image.onload=image.onerror=null;image.src='';URL.revokeObjectURL(url);throw error;}
}

function encode(canvas,quality){
  if(typeof canvas.toBlob==='function')return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?.size?resolve(blob):reject(new Error(PHOTO_ERROR)),'image/jpeg',quality));
  // Older Android browsers only expose toDataURL. This canvas is already small.
  const data=canvas.toDataURL('image/jpeg',quality),type=data.slice(5,data.indexOf(';'));
  const binary=atob(data.split(',')[1]),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  return Promise.resolve(new Blob([bytes],{type}));
}

export async function prepareAttendancePhoto(file){
  if(!file?.size)throw new Error('Take a selfie to check in.');
  if(file.type&&!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Use a JPG, PNG or WebP selfie.');
  const source=await loadPhoto(file),canvas=document.createElement('canvas');
  try{
    if(source.width<32||source.height<32)throw new Error('Take a clear check-in photo.');
    const scale=Math.min(1,MAX_EDGE/Math.max(source.width,source.height));
    canvas.width=Math.max(32,Math.round(source.width*scale));
    canvas.height=Math.max(32,Math.round(source.height*scale));
    const context=canvas.getContext('2d');
    if(!context)throw new Error(PHOTO_ERROR);
    context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
    context.drawImage(source.image,0,0,canvas.width,canvas.height);
    let blob=await encode(canvas,0.72);
    if(blob.size>MAX_BYTES)blob=await encode(canvas,0.5);
    if(blob.type!=='image/jpeg'||blob.size>MAX_BYTES)throw new Error(PHOTO_ERROR);
    return blob;
  }finally{source.release();canvas.width=canvas.height=1;}
}

export function attendancePhotoError(error){
  const message=error?.message||'Check-in failed. Please retry.';
  if(/maxMemoryUsageInMB|maxResolutionInMP|memory limit|resource.*limit/i.test(message))return 'The selfie is too large to process. Refresh the app and retake it with a lower camera resolution.';
  return message;
}

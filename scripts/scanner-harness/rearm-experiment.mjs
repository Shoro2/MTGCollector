// Measure production whole-card fingerprints on public reference images.
// node scripts/scanner-harness/rearm-experiment.mjs [scan-log] [output-dir]
// Read-only catalogue access; images/results go to ignored data/ by default.
// This measures reference-image separation and simulated image/quad noise,
// not real camera replacement recall or false-positive rates.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const logFile = resolve(process.argv[2] ?? 'data/scan-logs/2026-10-04/031135-3517d3b2.log');
const out = resolve(process.argv[3] ?? 'data/rearm-experiment');
await mkdir(out,{recursive:true});
const module = await build({entryPoints:[resolve(root,'src/lib/scanner/rearm.ts')],bundle:true,write:false,platform:'node',format:'esm'});
const {cardFingerprint,contentDistance,CONTENT_CHANGE_BITS} = await import('data:text/javascript;base64,' + Buffer.from(module.outputFiles[0].text).toString('base64'));
const log = await readFile(logFile,'utf8');
const wanted = [...log.matchAll(/identity confirmed "([^"]+)", printing (?:confirmed (\S+)#([^,]+)|unknown)/g)].map((m)=>({name:m[1],set:m[2],number:m[3]}));
const db = new Database(resolve(root,'data/mtg.db'),{readonly:true});
const cards = wanted.map((c)=> c.set
 ? db.prepare('SELECT id,name,set_code,collector_number,image_uri FROM cards WHERE name=? AND set_code=? AND collector_number=?').get(c.name,c.set,c.number)
 : db.prepare("SELECT id,name,set_code,collector_number,image_uri FROM cards WHERE name=? AND image_uri IS NOT NULL ORDER BY released_at DESC LIMIT 1").get(c.name));
db.close();
if (cards.some((c)=>!c?.image_uri)) throw new Error('A requested reference has no catalogue image; no partial run.');
const width=244,height=340;
const corners=[[0,0],[width-1,0],[width-1,height-1],[0,height-1]];
// Secondary continuous samples: identical 32x32 bilinear card coordinates and
// 3x3 pixel averaging as cardFingerprint, pooled into an 8x8 luminance grid.
function gridOf(rgba,q) {
 const grid=Array(64).fill(0);
 for(let y=0;y<32;y++) for(let x=0;x<32;x++) {
  const u=.1+.8*(x+.5)/32,v=.12+.76*(y+.5)/32;
  const tx=q[0][0]+(q[1][0]-q[0][0])*u,ty=q[0][1]+(q[1][1]-q[0][1])*u;
  const bx=q[3][0]+(q[2][0]-q[3][0])*u,by=q[3][1]+(q[2][1]-q[3][1])*u;
  const px=Math.round(tx+(bx-tx)*v),py=Math.round(ty+(by-ty)*v);
  let sum=0;
  for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
   const i=(Math.max(0,Math.min(height-1,py+dy))*width+Math.max(0,Math.min(width-1,px+dx)))*4;
   sum+=rgba[i]*.299+rgba[i+1]*.587+rgba[i+2]*.114;
  }
  grid[Math.floor(y/4)*8+Math.floor(x/4)]+=sum/144;
 }
 return grid;
}
function correlationDistance(a,b,aligned=false) {
 let best=2;
 for(let dy=aligned?-1:0;dy<=(aligned?1:0);dy++) for(let dx=aligned?-1:0;dx<=(aligned?1:0);dx++) {
  let n=0,sa=0,sb=0,saa=0,sbb=0,sab=0;
  for(let y=Math.max(0,-dy);y<Math.min(8,8-dy);y++) for(let x=Math.max(0,-dx);x<Math.min(8,8-dx);x++) {
   const av=a[y*8+x],bv=b[(y+dy)*8+x+dx];n++;sa+=av;sb+=bv;saa+=av*av;sbb+=bv*bv;sab+=av*bv;
  }
  const denom=Math.sqrt(Math.max(0,saa-sa*sa/n)*Math.max(0,sbb-sb*sb/n));
  best=Math.min(best,denom>1e-8?1-(sab-sa*sb/n)/denom:0);
 }
 return best;
}
const variant=(label,rgba,q=corners)=>({label,hash:cardFingerprint(rgba,width,height,q),grid:gridOf(rgba,q)});
const samples=[];
for (const [index,card] of cards.entries()) {
 const file=resolve(out,card.id+'.jpg');
 let image;
 try {image=await readFile(file);} catch {
  const response=await fetch(card.image_uri,{headers:{'User-Agent':'MTGCollector scanner verification','Accept':'image/*'},signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error(`${card.name}: image HTTP ${response.status}`);
  image=Buffer.from(await response.arrayBuffer()); await writeFile(file,image);
  await new Promise((r)=>setTimeout(r,220));
 }
 const rgba=await sharp(image).resize(width,height,{fit:'fill'}).ensureAlpha().raw().toBuffer();
 const hash=cardFingerprint(rgba,width,height,corners);
 const variants=[variant('base',rgba)];
 for(const shift of [-25,25]) {
  const data=Uint8ClampedArray.from(rgba);
  for(let p=0;p<data.length;p+=4) for(let c=0;c<3;c++) data[p+c]+=shift;
  variants.push(variant(`exposure ${shift}`,data));
 }
 for(const sigma of [.7,1.5]) {
  const data=await sharp(rgba,{raw:{width,height,channels:4}}).blur(sigma).raw().toBuffer();
  variants.push(variant(`blur ${sigma}`,data));
 }
 for(const frac of [-.02,.02,.05]) {
  const q=corners.map(([x,y])=>[x+(x<width/2?1:-1)*frac*width,y+(y<height/2?1:-1)*frac*height]);
  variants.push(variant(`quad inset ${frac*100}%`,rgba,q));
 }
 let seed=123456+index;
 const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
 for(let n=0;n<30;n++) {
  const q=corners.map(([x,y])=>[x+(rand()*2-1)*width*.02,y+(rand()*2-1)*height*.02]);
  variants.push(variant(`quad jitter ±2% #${n}`,rgba,q));
 }
 let worst={distance:0,a:'',b:''};
 let worstModest={distance:0,a:'',b:''};
 for(let a=0;a<variants.length;a++) for(let b=a+1;b<variants.length;b++) {
  const distance=contentDistance(variants[a].hash,variants[b].hash);
  if(distance>worst.distance) worst={distance,a:variants[a].label,b:variants[b].label};
  if(![variants[a].label,variants[b].label].includes('quad inset 5%') && distance>worstModest.distance) worstModest={distance,a:variants[a].label,b:variants[b].label};
 }
 const baseDistances=variants.map((v)=>({label:v.label,distance:contentDistance(hash,v.hash)}));
 samples.push({card,sha256:createHash('sha256').update(image).digest('hex'),hash,variants,baseDistances,worst,worstModest});
 console.log(`${card.name}: maximum base perturbation ${Math.max(...baseDistances.map(v=>v.distance))}, variant-pair ${worst.distance}`);
}
const pairs=[];
for(let a=0;a<samples.length;a++) for(let b=a+1;b<samples.length;b++) {
 let worstSeparation={distance:64,a:'',b:''};
 for(const av of samples[a].variants) for(const bv of samples[b].variants) {
  if([av.label,bv.label].includes('quad inset 5%')) continue;
  const distance=contentDistance(av.hash,bv.hash);
  if(distance<worstSeparation.distance) worstSeparation={distance,a:av.label,b:bv.label};
 }
 pairs.push({a:samples[a].card.name,b:samples[b].card.name,distance:contentDistance(samples[a].hash,samples[b].hash),worstSeparation});
}
pairs.sort((a,b)=>a.distance-b.distance);
const report={logFile,threshold:CONTENT_CHANGE_BITS,count:samples.length,pairs,belowThreshold:pairs.filter(p=>p.distance<CONTENT_CHANGE_BITS),samples};
report.continuous=[];
for(const aligned of [false,true]) {
 const result={aligned,maxSame:0,maxSameModest:0,minDifferentClean:2,minDifferentModest:2,minDifferent:2,worstSame:null,closestDifferent:null};
 for(let a=0;a<samples.length;a++) {
  for(const av of samples[a].variants) for(const bv of samples[a].variants) {
   const d=correlationDistance(av.grid,bv.grid,aligned);
   if(d>result.maxSame) {result.maxSame=d;result.worstSame={name:samples[a].card.name,a:av.label,b:bv.label};}
   if(![av.label,bv.label].includes('quad inset 5%')) result.maxSameModest=Math.max(result.maxSameModest,d);
  }
  for(let b=a+1;b<samples.length;b++) {
   result.minDifferentClean=Math.min(result.minDifferentClean,correlationDistance(samples[a].variants[0].grid,samples[b].variants[0].grid,aligned));
   for(const av of samples[a].variants) for(const bv of samples[b].variants) {
    const d=correlationDistance(av.grid,bv.grid,aligned);
    if(d<result.minDifferent) {result.minDifferent=d;result.closestDifferent={a:samples[a].card.name,b:samples[b].card.name,av:av.label,bv:bv.label};}
    if(![av.label,bv.label].includes('quad inset 5%')) result.minDifferentModest=Math.min(result.minDifferentModest,d);
   }
  }
 }
 report.continuous.push(result);
}
report.guardOptions=[];
for(const guard of [{hash:18,correlation:.25},{hash:18,correlation:.3},{hash:26,correlation:0}]) {
 let samePairs=0,cleanReplacements=0,missed=[];
 const changes=(a,b)=>contentDistance(a.hash,b.hash)>=guard.hash && correlationDistance(a.grid,b.grid)>=guard.correlation;
 for(let a=0;a<samples.length;a++) {
  for(let x=0;x<samples[a].variants.length;x++) for(let y=x+1;y<samples[a].variants.length;y++) if(changes(samples[a].variants[x],samples[a].variants[y])) samePairs++;
  for(let b=a+1;b<samples.length;b++) if(changes(samples[a].variants[0],samples[b].variants[0])) cleanReplacements++;
  else missed.push([samples[a].card.name,samples[b].card.name]);
 }
 report.guardOptions.push({...guard,samePairs,cleanReplacements,totalReplacements:pairs.length,missed});
}
await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({cards:samples.length,pairs:pairs.length,minDistance:pairs[0]?.distance,belowThreshold:report.belowThreshold,continuous:report.continuous,guardOptions:report.guardOptions,report:resolve(out,'report.json')},null,2));

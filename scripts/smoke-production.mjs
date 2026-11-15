#!/usr/bin/env node
// Founder Engine production smoke test. Node >=20; no external dependencies.
// Usage: node scripts/smoke-production.mjs https://founder-engine-five.vercel.app
const base=(process.argv[2]||'https://founder-engine-five.vercel.app').replace(/\/$/,'');
const results=[];
async function probe(name,path,opts,validate){
 const started=Date.now();
 try{
  const r=await fetch(base+path,{...opts,signal:AbortSignal.timeout(65000)});
  const raw=await r.text();let body;try{body=JSON.parse(raw)}catch{body=null}
  const ok=validate(r,body,raw);
  results.push({name,ok,http:r.status,ms:Date.now()-started,detail:ok?'pass':raw.slice(0,500)});
 }catch(e){results.push({name,ok:false,ms:Date.now()-started,error:String(e)})}
}
const json=(body)=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
await probe('page','/',{},(r,b,s)=>r.ok&&s.includes('Founder Engine')&&s.includes('Curate my stack'));
await probe('health','/api/health',{},(r,b)=>r.ok&&b?.ok===true&&b?.engine==='founder-engine');
await probe('validation','/api/curate',json({intent:'short'}),(r,b)=>r.status===400);
await probe('extract','/api/extract',json({notes:'- Dana: follow up with the printer next Friday'}),(r,b)=>r.ok&&Array.isArray(b?.items));
await probe('curate-example','/api/curate',json({intent:'I run a small agency. Build an offline meeting notes processor that extracts action items, owners and natural-language due dates.'}),(r,b)=>r.ok&&typeof b?.status==='string'&&Array.isArray(b?.receipts)&&typeof b?.chain_intact==='boolean');
await probe('curate-off-catalogue','/api/curate',json({intent:'Build a neighborhood bicycle repair booking app with appointment reminders, parts inventory and technician dispatch.'}),(r,b)=>r.ok&&typeof b?.status==='string'&&Array.isArray(b?.registry)&&Array.isArray(b?.receipts));
console.log(JSON.stringify({target:base,checked_at:new Date().toISOString(),results,passed:results.filter(x=>x.ok).length,total:results.length},null,2));
if(results.some(x=>!x.ok))process.exitCode=1;

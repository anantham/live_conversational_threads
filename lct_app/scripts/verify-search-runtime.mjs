import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';

// Built-worker/model integration, not a physical browser or network latency benchmark.
// Usage: node --experimental-vm-modules scripts/verify-search-runtime.mjs CLIENT_DIR PUBLIC_MODEL_PROOF_DIR
const assets=resolve(process.argv[2] ?? 'dist/client');
const proof=resolve(process.argv[3] ?? (()=>{throw new Error('Provide the pinned public model proof directory');})());
const model=join(proof,'model');
const identity=JSON.parse(await readFile(join(proof,'public-model-main-identity.json'),'utf8'));
assert.equal(identity.sha,'751bff37182d3f1213fa05d7196b954e230abad9','Public metadata identity must match the pinned model');
const weights=await readFile(join(model,'onnx/model_quantized.onnx'));
assert.equal(createHash('sha256').update(weights).digest('hex'),'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1','Use actual pinned q8 model weights');
const worker=(await readdir(join(assets,'assets'))).find(n=>n.startsWith('conversationSearch.worker-')&&n.endsWith('.js'));
const code=await readFile(join(assets,'assets',worker),'utf8');
async function run({blockWasm=false,long=false}={}) {
  const messages=[], requests=[], waiters=new Map(), modules=new Map();let instantiations=0;
  async function request(input,init={}) {
    const url=new URL(typeof input==='string'?input:input.url??input.href);
    requests.push({origin:url.origin,path:url.pathname});
    if(url.protocol==='blob:') return fetch(input);
    let target;
    if(url.origin==='https://cpu-search.test') target=join(assets,url.pathname);
    else if(url.hostname==='huggingface.co') {
      const prefix='/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/';
      // Library metadata discovery uses main; the fetched public identity proves main equals this pin.
      const current=identity;
      assert.equal(current.sha,'751bff37182d3f1213fa05d7196b954e230abad9');
      const pathname=url.pathname.replace('/resolve/main/','/resolve/'+current.sha+'/');
      assert(pathname.startsWith(prefix),'Only the verified public model may be requested: '+url.pathname);
      target=join(model,pathname.slice(prefix.length));
    } else throw new Error('Unexpected external request: '+url.origin);
    let response;
    try {
      if(blockWasm&&url.pathname.endsWith('.wasm'))throw new Error('blocked');
      const bytes=await readFile(target);
      const range=new Headers(init.headers??input?.headers).get('range');
      response=range==='bytes=0-0'?new Response(bytes.subarray(0,1),{status:206,headers:{'content-length':'1','content-range':`bytes 0-0/${bytes.length}`}}):new Response(bytes,{headers:{'content-length':String(bytes.length),'content-type':url.pathname.endsWith('.wasm')?'application/wasm':url.pathname.endsWith('.json')?'application/json':'text/javascript'}});
    } catch {response=new Response('Synthetic asset unavailable',{status:404});}
    Object.defineProperty(response,'url',{value:url.href});return response;
  }
  const cacheStores=new Map();
  const keyOf=input=>typeof input==='string'?input:input.url??input.href;
  const caches={async open(name){if(!cacheStores.has(name))cacheStores.set(name,new Map());const entries=cacheStores.get(name);return {async match(input){return entries.get(keyOf(input))?.clone();},async put(input,response){entries.set(keyOf(input),response.clone());},async delete(input){return entries.delete(keyOf(input));}};}};
  const wasm=Object.create(WebAssembly);
  wasm.instantiate=(...args)=>{instantiations++;return WebAssembly.instantiate(...args);};
  wasm.instantiateStreaming=(...args)=>{instantiations++;return WebAssembly.instantiateStreaming(...args);};
  class XMLHttpRequest {
    open(method,url){assert(blockWasm&&new URL(url).origin==='https://cpu-search.test'&&new URL(url).pathname.endsWith('.wasm'));assert.equal(method,'GET');}
    send(){this.status=404;this.statusText='Synthetic missing WASM';this.response=null;}
  }
  const sandbox={XMLHttpRequest,caches,URL,Blob,Request,Response,Headers,fetch:request,TextEncoder,TextDecoder,AbortController,AbortSignal,ReadableStream,TransformStream,WebAssembly:wasm,crypto,performance,structuredClone,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,atob,btoa,navigator:{userAgent:'Synthetic CPU runtime validation',hardwareConcurrency:1,vendor:''},WorkerGlobalScope:class WorkerGlobalScope{},location:new URL('https://cpu-search.test/assets/'+worker),console};
  sandbox.self=sandbox;sandbox.constructor={name:'DedicatedWorkerGlobalScope'};
  sandbox.postMessage=message=>{messages.push(message);if(['results','error'].includes(message.type)){waiters.get(message.requestId)?.(message);waiters.delete(message.requestId);}};
  const context=vm.createContext(sandbox);
  async function dynamicImport(specifier,referrer) {
    const url=new URL(specifier,referrer.identifier??sandbox.location.href).href;
    if(!modules.has(url)) {
      const response=await request(url);assert(response.ok,'Runtime module must be available');
      const m=new vm.SourceTextModule(await response.text(),{context,identifier:url,initializeImportMeta(meta){meta.url=url;},importModuleDynamically:dynamicImport});modules.set(url,m);
      await m.link(()=>{throw new Error('Unexpected static runtime import');});await m.evaluate();
    }return modules.get(url);
  }
  new vm.Script(code,{filename:'built-search-worker.js',importModuleDynamically:dynamicImport}).runInContext(context,{timeout:10000});
  let docs=[{key:'bike',id:'bike',text:'Repairing a bicycle involves replacing worn chains, adjusting brakes, fixing flat tyres and checking gears.'},{key:'garden',id:'garden',text:'Growing tomatoes requires fertile soil, sunlight, watering vegetable seedlings and protecting plants from pests.'},{key:'space',id:'space',text:'Astronomers observe stars, galaxies, distant planets and the expanding universe through telescopes.'}];
  if(long) docs=Array.from({length:66},(_,i)=>{const base=docs[i%3];return {...base,key:base.key+':'+i,id:base.id+':'+i,text:Array(4).fill(base.text).join(' ')};});
  async function query(id,query) {
    const start=performance.now();let timer;
    try {const result=await Promise.race([new Promise(resolve=>{waiters.set(id,resolve);sandbox.onmessage({data:{requestId:id,query,documents:docs}});}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Worker timeout')),90000);})]);return {result,elapsed_ms:performance.now()-start};}finally{clearTimeout(timer);}
  }
  const first=await query(1,'How can I mend my cycle and make its brakes work?');
  if(blockWasm){assert.equal(first.result.type,'error');assert(!first.result.message.includes('is not defined'),'Refusal must not be a missing harness API');assert(!messages.some(m=>m.type==='results'));assert(!requests.some(r=>r.origin.includes('jsdelivr')));return {missing_asset_refused:true,requests};}
  assert.equal(first.result.type,'results',JSON.stringify(first.result));assert.equal(first.result.results[0].id.split(':')[0],'bike');
  const second=await query(2,'How should I care for vegetables in my allotment?');
  assert.equal(second.result.type,'results');assert.equal(second.result.results[0].id.split(':')[0],'garden');
  for(const r of [...first.result.results,...second.result.results])assert(Number.isFinite(r.score)&&r.score>=-1.001&&r.score<=1.001);
  assert(instantiations>0,'A real WASM module must run');
  assert(requests.some(r=>r.path.endsWith('.wasm'))&&requests.some(r=>r.path.endsWith('.mjs')));
  assert(!requests.some(r=>r.path.includes('asyncify')||r.path.includes('jsep')||r.origin.includes('jsdelivr')));
  assert.equal(messages.filter(m=>m.type==='progress'&&m.stage==='model'&&!('loadedBytes'in m)).length,1);
  return {documents:docs.length,first_query_ms:first.elapsed_ms,second_query_ms:second.elapsed_ms,first_top:first.result.results[0].id,second_top:second.result.results[0].id,wasm_instantiations:instantiations,requests};
}
const result={short:await run(),long:await run({long:true}),refusal:await run({blockWasm:true}),limitations:['Node VM browser-API adapter; not physical browser/device proof','Model and assets read locally; timings exclude download latency']};
console.log(JSON.stringify(result,null,2));

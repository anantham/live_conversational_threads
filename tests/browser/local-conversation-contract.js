// Browser fixture: bind to a page with a button and pre#result on a disposable localhost origin. Bundle with the existing esbuild. No user databases or network/provider calls.
import { saveLocalConversation, readLocalConversation, deleteLocalConversation } from '../../lct_app/src/services/cloud/localConversationStore.js';
const out=document.querySelector('#result');
document.querySelector('button').onclick=async()=>{
 const id='synthetic-contract-'+crypto.randomUUID(), recording={id,startedAt:Date.now(),transcribe:true};
 const initial={id,recording,title:'Synthetic storage contract',transcript:{finalText:'First synthetic words',partialText:'',finalTokens:[{text:'First synthetic words'}],partialTokens:[]},map:null,stage:'stopped',segments:[{number:1,mimeType:'audio/webm',complete:true,bytes:4}],updatedAt:Date.now()};
 try{
 const first=await saveLocalConversation(initial,[{recordingId:id,segment:1,index:0,mimeType:'audio/webm',blob:new Blob(['tone'])}]);
 const opened=await readLocalConversation(id);
 if(await opened.audio.blob.text()!=='tone'||!opened.audio.complete)throw Error('Audio byte recovery failed');
 const second=await saveLocalConversation({...initial,transcript:{...initial.transcript,finalText:'Newer words'},map:{invalid:'synthetic corruption'}},[],first);
 const recovered=await readLocalConversation(id);
 if(!recovered.mapUnreadable||recovered.map!==null||await recovered.audio.blob.text()!=='tone')throw Error('Corrupt map hid audio');
 const third=await saveLocalConversation({...initial,transcript:{...initial.transcript,finalText:'Newer words'},segments:[...initial.segments,{number:2,mimeType:'audio/webm',complete:true,bytes:4}]},[],second);
 if((await readLocalConversation(id)).audio.complete)throw Error('Missing whole audio part marked complete');
 let conflict=false;try{await saveLocalConversation(initial,[],first)}catch(e){conflict=e.code==='archive_conflict'}
 if(!conflict||(await readLocalConversation(id)).transcript.finalText!=='Newer words')throw Error('Stale snapshot overwrote source');
 await deleteLocalConversation(id);let resurrected=false;try{await saveLocalConversation(initial,[],third);resurrected=true}catch(e){if(e.code!=='archive_conflict')throw e}
 if(resurrected||await readLocalConversation(id))throw Error('Deleted record resurrected');
 out.textContent='PASS 5/5: exact audio recovery; corrupt-map recovery; missing audio part marked incomplete; stale-write refusal with newer transcript preserved; deleted-copy resurrection refused. Disposable synthetic ID only.';
 }catch(e){out.textContent='FAIL: '+e.message}
};

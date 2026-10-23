import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {RpcRejected,sameQueueInput} from './codex-queue.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const read=async file=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
// Ticks are serialized by the owning oneshot. A leftover scratch file from a
// crash is not authoritative; replace it from the durable state before rename.
async function replace(file,value){await fs.writeFile(file+'.pending',JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(file+'.pending',file);}
const retryableRejection=error=>error instanceof RpcRejected&&(error.code===-32001||/already has an active writer|already.*(?:active|running).*turn|turn.*already.*(?:active|running)/i.test(error.message));

/** One logical handoff, separate delivery attempts and receiver acknowledgment.
 * Caller serializes ticks (the systemd oneshot does); exclusive attempt files
 * additionally prevent concurrent sends. Unknown transport outcomes never retry
 * an add. Only a proven RPC refusal permits another delivery attempt. */
export async function deliverHandoff(dir,binding,prompt,client,{now=Date.now(),retryMs=60_000}={}) {
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const deliveryId=hash({binding,prompt}),clientUserMessageId=`nwh-${deliveryId}`;
  const text=`${prompt}\n\n宿主交接编号：${clientUserMessageId}。先读取本次 delivery.json；核验新指令与证据后，使用本次编号写入 handoff-ack.json，不能复用旧 claim。`;
  const intent={version:1,deliveryId,clientUserMessageId,binding,input:[{type:'text',text}]};
  const intentFile=path.join(dir,'delivery.json'),stateFile=path.join(dir,'delivery-state.json');
  const prior=await read(intentFile);
  if(prior&&hash(prior)!==hash(intent))throw Error('Handoff binding changed; preserve the original delivery');
  if(!prior)await fs.writeFile(intentFile,JSON.stringify(intent,null,2)+'\n',{flag:'wx',mode:0o600});
  let state=await read(stateFile)??{version:1,deliveryId,status:'pending',attempts:0};
  if(state.deliveryId!==deliveryId)throw Error('Delivery state belongs to another handoff');
  const save=async patch=>{state={...state,...patch,updatedAt:new Date(now).toISOString()};await replace(stateFile,state);return state;};
  const ack=await read(path.join(dir,'handoff-ack.json'));
  if(ack){
    if(ack.deliveryId!==deliveryId||ack.clientUserMessageId!==clientUserMessageId||ack.reportHash!==binding.reportHash)throw Error('Receiver acknowledgment belongs to another handoff');
    return save({status:'completed',ack});
  }
  if(state.status==='completed'||state.status==='host-review')return state;
  if(state.nextAttemptAt&&Date.parse(state.nextAttemptAt)>now)return state;
  let found;
  try{found=await client.snapshot(binding.threadId,clientUserMessageId,intent.input);}
  catch(error){return save({lastError:String(error),nextAttemptAt:new Date(now+retryMs).toISOString()});}
  if(found.kind==='owner-unavailable')return save({lastError:'Owning daemon has not loaded this thread; no writer takeover or new session is permitted.',nextAttemptAt:new Date(now+retryMs).toISOString()});
  if(found.kind==='consumed')return save({status:'accepted',itemId:found.itemId,nextAttemptAt:new Date(now+retryMs).toISOString()});
  if(found.kind==='queued') {
    await save({status:'accepted',queuedSubmissionId:found.queuedSubmissionId});
    if(found.idle){
      try{const result=await client.start(binding.threadId,found.queuedSubmissionId);return save({turnId:result.turn.id,nextAttemptAt:new Date(now+retryMs).toISOString()});}
      catch(error){return save({lastError:String(error),nextAttemptAt:new Date(now+retryMs).toISOString()});}
    }
    return save({nextAttemptAt:new Date(now+retryMs).toISOString()});
  }
  if(state.status==='accepted')return save({status:'host-review',lastError:'Acknowledged input is no longer queued and receiver acceptance is not proven. Preserve it; never send a replacement.'});
  if(state.status==='dispatching'||state.status==='uncertain')return save({status:'uncertain',lastError:'A prior send may have been accepted. Await exact queue/history/receiver evidence; never resend.',nextAttemptAt:new Date(now+retryMs).toISOString()});
  const attempt=state.attempts+1;
  try{await fs.writeFile(path.join(dir,`delivery-attempt-${attempt}.json`),JSON.stringify({deliveryId,attempt,at:new Date(now).toISOString()}),{flag:'wx',mode:0o600});}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    return save({status:'uncertain',attempts:attempt,lastError:'An exclusive attempt already exists without a settled state. Reconcile queue/history/receiver evidence; never resend.',nextAttemptAt:new Date(now+retryMs).toISOString()});
  }
  await save({status:'dispatching',attempts:attempt});
  let result;
  try{result=await client.add(binding.threadId,clientUserMessageId,intent.input);}
  catch(error){
    const definitelyRejected=error instanceof RpcRejected;
    return save({status:retryableRejection(error)?'pending':definitelyRejected?'host-review':'uncertain',lastError:String(error),nextAttemptAt:new Date(now+retryMs).toISOString()});
  }
  const queued=result.queuedSubmission;
  if(!queued?.id||queued.clientUserMessageId!==clientUserMessageId||!sameQueueInput(queued.input,intent.input))return save({status:'uncertain',lastError:'Queue acknowledgment did not match the exact handoff; never resend.'});
  return save({status:'accepted',queuedSubmissionId:queued.id,nextAttemptAt:new Date(now+retryMs).toISOString()});
}

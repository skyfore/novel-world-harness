import WebSocket from 'ws';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';

// Rust's UserInput may serialize the optional empty text-elements default.
// Compare typed inputs rather than object key order; preserve all actual text.
export const sameQueueInput=(left,right)=>isDeepStrictEqual(
  left?.map(item=>item.type==='text'?{...item,text_elements:item.text_elements??[]}:item),
  right?.map(item=>item.type==='text'?{...item,text_elements:item.text_elements??[]}:item));

export class RpcRejected extends Error {
  constructor(error) { super(error.message); this.code=error.code; }
}

/** Connect to the existing owning daemon. Never spawn/resume a second Codex
 * process, alter a thread's model, or take its writer lease. */
export async function connectCodexQueue(socketPath, timeoutMs=10_000) {
  if(!path.isAbsolute(socketPath))throw Error('An explicit local Codex socket is required');
  const socket=new WebSocket(`ws+unix://${socketPath}:/`),pending=new Map();let next=0;
  const failAll=error=>{for(const wait of pending.values()){clearTimeout(wait.timer);wait.reject(error);}pending.clear();};
  socket.on('error',failAll);socket.on('close',()=>failAll(Error('Codex queue connection closed')));
  socket.on('message',bytes=>{
    let value;try{value=JSON.parse(String(bytes));}catch{return;}
    const wait=pending.get(value.id);if(!wait)return;
    pending.delete(value.id);clearTimeout(wait.timer);
    if(value.error)wait.reject(new RpcRejected(value.error));else wait.resolve(value.result);
  });
  const close=()=>{failAll(Error('Codex queue client closed'));socket.terminate();};
  const request=(method,params)=>new Promise((resolve,reject)=>{
    const id=++next,timer=setTimeout(()=>{pending.delete(id);reject(Error(`Codex RPC timeout: ${method}`));},timeoutMs);
    pending.set(id,{resolve,reject,timer});
    socket.send(JSON.stringify({id,method,params}),error=>{if(error){clearTimeout(timer);pending.delete(id);reject(error);}});
  });
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{socket.terminate();reject(Error('Codex socket connection timeout'));},timeoutMs);
      socket.once('open',()=>{clearTimeout(timer);resolve();});socket.once('error',e=>{clearTimeout(timer);reject(e);});
    });
    await request('initialize',{clientInfo:{name:'nwh_compile_wakeup',version:'1.0.0'},capabilities:{experimentalApi:true}});
    socket.send(JSON.stringify({method:'initialized'}));
  }catch(error){close();throw error;}
  return {
    close, request,
    async snapshot(threadId,clientUserMessageId,input) {
      let cursor,ownsThread=false;
      do{const loaded=await request('thread/loaded/list',cursor?{cursor}:{});ownsThread=loaded.data.includes(threadId);cursor=loaded.nextCursor;}while(!ownsThread&&cursor);
      if(!ownsThread)return {kind:'owner-unavailable'};
      const {thread}=await request('thread/read',{threadId,includeTurns:false});
      if(thread.id!==threadId)throw Error('Codex returned a different thread');
      cursor=undefined;let queued;
      do{const page=await request('thread/queue/list',{threadId,...(cursor?{cursor}:{})});queued=page.data.find(item=>item.clientUserMessageId===clientUserMessageId);cursor=page.nextCursor;}while(!queued&&cursor);
      if(queued){
        if(!sameQueueInput(queued.input,input))throw Error('Queued handoff input changed');
        return {kind:'queued',queuedSubmissionId:queued.id,idle:thread.status?.type==='idle'};
      }
      // A lost queue/start acknowledgment must not create a second message.
      // Search recent retained inputs; absence is deliberately NOT proof that
      // an uncertain submission was never received.
      const {data:items}=await request('thread/items/list',{threadId,limit:100,sortDirection:'desc'});
      const match=items.find(({item})=>item.type==='userMessage'&&item.content?.some(c=>c.type==='text'&&input.some(i=>i.type==='text'&&i.text===c.text)));
      return match ? {kind:'consumed',itemId:match.item.id,turnId:match.turnId} : {kind:'absent',idle:thread.status?.type==='idle'};
    },
    add(threadId,clientUserMessageId,input){return request('thread/queue/add',{threadId,clientUserMessageId,input});},
    start(threadId,queuedSubmissionId){return request('thread/queue/start',{threadId,queuedSubmissionId});},
  };
}

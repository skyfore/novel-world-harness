import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {deliverHandoff} from '../tools/compiler-wakeup/delivery.mjs';
import {connectCodexQueue,RpcRejected} from '../tools/compiler-wakeup/codex-queue.mjs';

const binding={threadId:'original-thread',sourceId:'source',runId:'failed-run',planHash:'plan',reportHash:'report',predecessorWakeEvidence:'previous.json'};
async function fixture(run){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nwh-delivery-'));
  let found={kind:'absent',idle:false},adds=0,starts=0,queued;
  const client={snapshot:async()=>found,add:async(thread,id,input)=>{adds++;queued={id:'queue-id',clientUserMessageId:id,input};found={kind:'queued',queuedSubmissionId:queued.id,idle:false};return {queuedSubmission:queued};},start:async()=>{starts++;found={kind:'consumed',itemId:'message-id'};return {turn:{id:'turn-id'}};}};
  const tick=(now=1)=>deliverHandoff(dir,binding,'Continue the authorized compilation.',client,{now,retryMs:10});
  try{await run({dir,client,tick,setFound:value=>{found=value;},counts:()=>({adds,starts}),queued:()=>queued});}
  finally{await fs.rm(dir,{recursive:true,force:true});}
}
test('queues in the owning active thread once, then starts only its acknowledged queued message when idle',()=>fixture(async f=>{
  assert.equal((await f.tick()).status,'accepted');
  assert.deepEqual(f.counts(),{adds:1,starts:0});
  assert.equal((await f.tick(12)).status,'accepted');
  f.setFound({kind:'queued',queuedSubmissionId:'queue-id',idle:true});
  const started=await f.tick(23);assert.equal(started.turnId,'turn-id');
  const intent=JSON.parse(await fs.readFile(f.dir+'/delivery.json','utf8'));
  await fs.writeFile(f.dir+'/handoff-ack.json',JSON.stringify({deliveryId:intent.deliveryId,clientUserMessageId:intent.clientUserMessageId,reportHash:binding.reportHash}));
  assert.equal((await f.tick(34)).status,'completed');
  await f.tick(45);assert.deepEqual(f.counts(),{adds:1,starts:1});
}));
test('a definite writer refusal retains the logical handoff and permits a later delivery without consuming it',()=>fixture(async f=>{
  const add=f.client.add;f.client.add=async()=>{throw new RpcRejected({code:-32600,message:'thread already has an active writer'});};
  const first=await f.tick();assert.equal(first.status,'pending');assert.equal(first.attempts,1);
  f.client.add=add;const accepted=await f.tick(12);
  assert.equal(accepted.status,'accepted');assert.equal(accepted.deliveryId,first.deliveryId);assert.equal(accepted.attempts,2);
}));
test('lost add acknowledgment reconciles the exact queue item without resending',()=>fixture(async f=>{
  const add=f.client.add;f.client.add=async(...args)=>{await add(...args);throw Error('socket closed before response');};
  assert.equal((await f.tick()).status,'uncertain');
  assert.equal((await f.tick(12)).status,'accepted');assert.equal(f.counts().adds,1);
}));
test('accepts normalized empty text elements in the acknowledgment body',()=>fixture(async f=>{
  const add=f.client.add;
  f.client.add=async(...args)=>{const result=await add(...args);result.queuedSubmission.input=result.queuedSubmission.input.map(i=>({...i,text_elements:[]}));return result;};
  assert.equal((await f.tick()).status,'accepted');
}));
test('refuses a changed acknowledgment body without sending a replacement',()=>fixture(async f=>{
  const add=f.client.add;
  f.client.add=async(...args)=>{const result=await add(...args);result.queuedSubmission.input=[{type:'text',text:'different work'}];return result;};
  assert.equal((await f.tick()).status,'uncertain');
  f.setFound({kind:'absent',idle:true});
  assert.equal((await f.tick(12)).status,'uncertain');assert.equal(f.counts().adds,1);
}));
test('an uncertain delivery absent from recent history never creates another message',()=>fixture(async f=>{
  let calls=0;f.client.add=async()=>{calls++;throw Error('transport outcome unknown');};
  assert.equal((await f.tick()).status,'uncertain');
  assert.equal((await f.tick(12)).status,'uncertain');assert.equal(calls,1);
}));
test('a consumed queue entry is acceptance evidence, not a reason to enqueue again',()=>fixture(async f=>{
  await f.tick();f.setFound({kind:'consumed',itemId:'original-message'});
  assert.equal((await f.tick(12)).itemId,'original-message');assert.equal(f.counts().adds,1);
}));
test('an unloaded owner waits without spawning or stealing a writer',()=>fixture(async f=>{
  f.setFound({kind:'owner-unavailable'});assert.equal((await f.tick()).status,'pending');assert.equal(f.counts().adds,0);
}));
test('changed report binding and mismatched receiver acknowledgment stop instead of replacing the handoff',()=>fixture(async f=>{
  await f.tick();
  await assert.rejects(deliverHandoff(f.dir,{...binding,reportHash:'other'},'Continue the authorized compilation.',f.client),/binding changed/);
  await fs.writeFile(f.dir+'/handoff-ack.json',JSON.stringify({deliveryId:'other'}));
  await assert.rejects(f.tick(12),/acknowledgment belongs to another/);assert.equal(f.counts().adds,1);
}));
test('a crash after an exclusive send attempt cannot silently re-add the same handoff',()=>fixture(async f=>{
  f.client.add=async()=>{throw Error('crash');};await f.tick();
  const file=f.dir+'/delivery-state.json',state=JSON.parse(await fs.readFile(file,'utf8'));
  state.status='dispatching';await fs.writeFile(file,JSON.stringify(state));
  let calls=0;f.client.add=async()=>{calls++;};
  assert.equal((await f.tick(12)).status,'uncertain');assert.equal(calls,0);
}));
test('recovers a leftover state scratch file without losing a durable receiver acknowledgment',()=>fixture(async f=>{
  await f.tick();const intent=JSON.parse(await fs.readFile(f.dir+'/delivery.json','utf8'));
  await fs.writeFile(f.dir+'/delivery-state.json.pending','interrupted write');
  await fs.writeFile(f.dir+'/handoff-ack.json',JSON.stringify({deliveryId:intent.deliveryId,clientUserMessageId:intent.clientUserMessageId,reportHash:binding.reportHash}));
  f.client.snapshot=async()=>{throw Error('daemon unavailable');};
  assert.equal((await f.tick(12)).status,'completed');assert.equal(f.counts().adds,1);
}));
test('a crash before saving dispatching preserves the exclusive attempt and never retries it',()=>fixture(async f=>{
  await fs.writeFile(f.dir+'/delivery-attempt-1.json',JSON.stringify({attempt:1}));
  assert.equal((await f.tick()).status,'uncertain');
  assert.equal((await f.tick(12)).status,'uncertain');assert.equal(f.counts().adds,0);
}));
test('Unix websocket client honors the real RPC envelopes and never invokes thread/resume or turn/start',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nwh-rpc-')),socketPath=path.join(dir,'control.sock');
  const server=http.createServer(),wss=new WebSocketServer({server}),methods=[],input=[{type:'text',text:'unique handoff'}];
  let queued=false;
  wss.on('connection',socket=>socket.on('message',raw=>{
    const {method,id,params}=JSON.parse(String(raw));methods.push(method);if(!id)return;
    let result={};
    if(method==='thread/loaded/list')result=params.cursor?{data:['original-thread']}:{data:['unrelated-thread'],nextCursor:'loaded-next'};
    if(method==='thread/read')result={thread:{id:params.threadId,status:{type:'idle'}}};
    if(method==='thread/queue/list')result=queued?(params.cursor?{data:[{id:'q',clientUserMessageId:'client-id',input}]}:{data:[],nextCursor:'queue-next'}):{data:[]};
    if(method==='thread/items/list')result={data:[{turnId:'turn',item:{id:'item',type:'userMessage',content:input}}]};
    if(method==='thread/queue/add'){queued=true;result={queuedSubmission:{id:'q',clientUserMessageId:params.clientUserMessageId,input:params.input}};}
    socket.send(JSON.stringify({id,result}));
  }));
  await new Promise(resolve=>server.listen(socketPath,resolve));let client;
  try{
    client=await connectCodexQueue(socketPath);
    assert.deepEqual(await client.snapshot('original-thread','client-id',input),{kind:'consumed',itemId:'item',turnId:'turn'});
    await client.add('original-thread','client-id',input);
    assert.deepEqual(await client.snapshot('original-thread','client-id',input),{kind:'queued',queuedSubmissionId:'q',idle:true});
    assert(!methods.includes('thread/resume'));assert(!methods.includes('turn/start'));
  }finally{client?.close();for(const c of wss.clients)c.terminate();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});}
});

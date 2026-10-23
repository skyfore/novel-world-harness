import type {AgentSession} from '@earendil-works/pi-coding-agent';
import {contentHash} from '../world/canonical.js';
type Model=Parameters<AgentSession['agent']['streamFunction']>[0];
export type RequestObservation={phase:'context'|'provider-payload';value:unknown;model:Model};
export type RequestObserver=(observation:RequestObservation)=>Promise<void>;
/** Byte accounting is exact JSON UTF-8, never mislabeled as tokenizer usage. */
export function describeRequest(observation:RequestObservation){
 const size=(v:unknown)=>Buffer.byteLength(JSON.stringify(v)??'');
 const value=observation.value as Record<string,unknown>;
 const messages=Array.isArray(value?.messages)?value.messages:Array.isArray(value?.input)?value.input:[];
 const sections=value&&typeof value==='object'?Object.entries(value).map(([name,section])=>({name,bytes:size(section)})):[];
 return {phase:observation.phase,bytes:size(value),sections,messages:messages.map((m,index)=>({index,role:m?.role??m?.type??'unknown',...(typeof m?.toolName==='string'?{toolName:m.toolName}:{}),bytes:size(m)})),
  modelId:observation.model.id,provider:observation.model.provider,modelContextTokens:observation.model.contextWindow,tokenEstimate:null,compositionHash:contentHash(value)};
}

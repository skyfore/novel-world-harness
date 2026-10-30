import fs from "node:fs/promises";
import path from "node:path";
import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { contentHash } from "../world/canonical.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";
import { identityRecordDirectory, type IdentityRecord } from "./identity-requirements.js";
import type { ModelRequestUsage } from "../runtime/model-request-budget.js";
import { jsonDictionaryProfile, losslessJsonContext } from "../agent/lossless-json-context.js";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import { identityReadTools } from "./identity-context-plan.js";

export function assertIdentitySubmissionTurn(message: Message, terminalTool = "submit_identity_requirements") {
  if (message.role !== "assistant") return;
  const calls = message.content.filter(b => b.type === "toolCall");
  if (calls.some(b => b.name === terminalTool) && calls.length !== 1)
    throw prerequisiteStop("Identity submission must follow a request containing all completed evidence reads; no simultaneous read/submission or retry");
}

/** Validate the complete, unredacted Pi journal, not an observational trace or
 * its header. New identity sessions are linear, uncompacted and single-use. */
export type IdentitySessionContract = { terminalTool: string; readTools: readonly string[]; receipt: "retained" | "staged"; allowCorrectedSubmission?: boolean };
const defaultContract: IdentitySessionContract = { terminalTool: "submit_identity_requirements", readTools: identityReadTools, receipt: "retained" };
export const identityQuotaRefusal = "Codex error: The usage limit has been reached";
function inspectTranscript(text: string, root: string, record: Pick<IdentityRecord, "sessionId" | "provider" | "model"> & { output: unknown }, prompt: string, contract = defaultContract, unsubmitted = false, rejectedSubmissionError?: string, settledFailure = false, quotaRefusal = false) {
  if (!text.endsWith("\n")) throw prerequisiteStop("Identity transcript has an incomplete final entry; preserve it, no redispatch");
  const entries = text.trimEnd().split("\n").map(line => JSON.parse(line)) as FileEntry[];
  const header = entries[0];
  if (header?.type !== "session" || header.id !== record.sessionId || header.cwd !== root || header.parentSession)
    throw prerequisiteStop("Identity transcript has a foreign or resumed session header");
  const ids = new Set<string>(); let parent: string | null = null;
  const messages: Message[] = [];
  for (const entry of entries.slice(1)) {
    if (entry.type === "session" || !entry.id || ids.has(entry.id) || entry.parentId !== parent
      || ["compaction", "context_edit", "branch_summary", "custom_message"].includes(entry.type))
      throw prerequisiteStop("Identity transcript is truncated, forked or edited; retain its complete original evidence");
    ids.add(entry.id); parent = entry.id;
    if (entry.type === "message") {
      if (!["system", "user", "assistant", "toolResult"].includes(entry.message.role)) throw prerequisiteStop("Identity transcript contains a message outside its stage protocol");
      messages.push(entry.message as Message);
    }
  }
  const users = messages.filter(m => m.role === "user");
  const userText = users[0]?.content;
  if (users.length !== 1 || (typeof userText === "string" ? userText : userText?.filter(b => b.type === "text").map(b => b.text).join("")) !== prompt)
    throw prerequisiteStop("Identity transcript lost its exact initial input");
  const assistants = messages.filter(m => m.role === "assistant");
  const lastMessage = messages.at(-1);
  // Pi persists the host beforeModelRequest stop as an empty, zero-usage error
  // message. It is retained verbatim but is not another provider response.
  const localStop = rejectedSubmissionError && lastMessage?.role === "assistant" && lastMessage.stopReason === "error"
    && lastMessage.errorMessage === rejectedSubmissionError && lastMessage.content.every(b => b.type === "text" && b.text === "")
    && Object.values(lastMessage.usage).every(v => typeof v === "number" ? v === 0 : typeof v === "object" && Object.values(v).every(n => n === 0))
    ? lastMessage : undefined;
  const refused = quotaRefusal && assistants.length === 1 && lastMessage?.role === "assistant"
    && lastMessage.stopReason === "error" && lastMessage.errorMessage === identityQuotaRefusal
    && lastMessage.content.length === 0 && messages.every(m => m.role !== "toolResult")
    && Object.values(lastMessage.usage).every(v => typeof v === "number" ? v === 0 : typeof v === "object" && Object.values(v).every(n => n === 0))
    ? lastMessage : undefined;
  if (quotaRefusal && !refused) throw prerequisiteStop("Quota continuation requires exactly one empty, zero-usage provider refusal and no tools; preserve the failure, no retry");
  if (!assistants.length || assistants.some(m => m.provider !== record.provider || m.model !== record.model || m !== localStop && m !== refused && ["error", "aborted", "pending"].includes(m.stopReason)))
    throw prerequisiteStop("Identity transcript lacks settled provider responses");
  const pending = new Map<string, string>(), callIds = new Set<string>();
  const submissions: { id: string; arguments: unknown }[] = [];
  for (const message of messages) {
    if (message.role === "assistant") {
      if (pending.size) throw prerequisiteStop("Identity response preceded its unsettled tool results; no authority or retry");
      const calls = message.content.filter(b => b.type === "toolCall");
      assertIdentitySubmissionTurn(message, contract.terminalTool);
      for (const block of calls) {
        if (![...contract.readTools, contract.terminalTool].includes(block.name)) throw prerequisiteStop("Identity transcript used a tool outside its exact stage");
        if (callIds.has(block.id)) throw prerequisiteStop("Identity transcript reused a tool call ID");
        callIds.add(block.id); pending.set(block.id, block.name);
        if (block.name === contract.terminalTool) submissions.push(block);
      }
    }
    if (message.role === "toolResult") {
      if (pending.get(message.toolCallId) !== message.toolName) throw prerequisiteStop("Identity transcript contains an unmatched tool result");
      pending.delete(message.toolCallId);
    }
  }
  const last = messages.at(-1);
  if (unsubmitted) {
    if (pending.size || submissions.length || last?.role !== "assistant" || (last.stopReason !== "stop" && last !== refused && last !== localStop))
      throw prerequisiteStop("Unsubmitted continuation requires a settled read-only session with no attempted submission; preserve its original stop, no replay");
    return { messages, localStop, summary: { entries: entries.length, lastEntryId: parent, responses: assistants.length - (localStop ? 1 : 0),
      toolResults: messages.filter(m => m.role === "toolResult").length } };
  }
  const terminal = submissions.at(-1), corrected = contract.allowCorrectedSubmission && submissions.length === 2
    && contentHash(submissions[0]!.arguments) !== contentHash(terminal!.arguments)
    && messages.some(m => m.role === "toolResult" && m.toolCallId === submissions[0]!.id && m.isError);
  if (settledFailure) {
    if (pending.size || (submissions.length !== 1 && !corrected) || !terminal || contentHash(terminal.arguments) !== contentHash(record.output)
      || last?.role !== "assistant" || last.stopReason !== "stop"
      || submissions.some(s => !messages.some(m => m.role === "toolResult" && m.toolCallId === s.id && m.isError))
      || messages.some(m => m.role === "toolResult" && m.isError && m.toolName !== contract.terminalTool))
      throw prerequisiteStop("Failed slot recovery requires settled rejected proposals and the original final stop; no successful receipt or replay");
    return { messages, localStop: undefined, summary: { entries: entries.length, lastEntryId: parent, responses: assistants.length,
      toolResults: messages.filter(m => m.role === "toolResult").length } };
  }
  if (rejectedSubmissionError) {
    const rejected = localStop ? messages.at(-2) : last;
    if (pending.size || submissions.length !== 1 || !terminal || contentHash(terminal.arguments) !== contentHash(record.output)
      || rejected?.role !== "toolResult" || !rejected.isError || rejected.toolCallId !== terminal.id || rejected.toolName !== contract.terminalTool
      || !rejected.content.some(b => b.type === "text" && (b.text === rejectedSubmissionError || b.text.startsWith(rejectedSubmissionError + "\n\n<nwh-tool-recovery>")))
      || messages.some(m => m.role === "toolResult" && m.isError && m !== rejected))
      throw prerequisiteStop("Rejected submission recovery requires exactly one settled sole submission and its exact host diagnostic after successful reads; no replay");
    return { messages, localStop, summary: { entries: entries.length, lastEntryId: parent, responses: assistants.length - (localStop ? 1 : 0),
      toolResults: messages.filter(m => m.role === "toolResult").length } };
  }
  if (pending.size || (submissions.length !== 1 && !corrected) || !terminal || contentHash(terminal.arguments) !== contentHash(record.output)
    || last?.role !== "toolResult" || last.isError || last.toolCallId !== terminal.id
    || !last.content.some(b => b.type === "text" && JSON.parse(b.text)[contract.receipt] === true))
    throw prerequisiteStop("Identity transcript has no complete terminal submission receipt");
  return { messages, localStop: undefined, summary: { entries: entries.length, lastEntryId: parent, responses: assistants.length,
    toolResults: messages.filter(m => m.role === "toolResult").length } };
}

export function inspectIdentityTranscript(text: string, root: string, record: IdentityRecord, prompt: string) {
  return inspectTranscript(text, root, record, prompt).summary;
}

/** Three independent observations must agree: message_end before Pi persists,
 * the durable Pi file, and every pre-transport request prefix. This also covers
 * the final response/signature and terminal tool result (never sent again).
 * A hash computed after data was lost is not evidence of complete persistence. */
export function verifyIdentitySessionEvidence(text: string, root: string, record: Pick<IdentityRecord, "sessionId" | "provider" | "model"> & { output: unknown }, prompt: string,
  rawRequests: string, rawMessages: string, contract = defaultContract) {
  return verifySessionObservations(inspectTranscript(text, root, record, prompt, contract), rawRequests, rawMessages, contract);
}

/** This proves only an immutable failed read session, never a semantic result.
 * It deliberately cannot satisfy the terminal-receipt verifier above. */
export function verifyUnsubmittedIdentitySession(text: string, root: string, record: Pick<IdentityRecord, "sessionId" | "provider" | "model">,
  prompt: string, rawRequests: string, rawMessages: string, contract: IdentitySessionContract) {
  return verifySessionObservations(inspectTranscript(text, root, { ...record, output: null }, prompt, contract, true), rawRequests, rawMessages, contract);
}

/** A host-side stop after read-only work is not a provider response or a
 * submission. The final unsent context can be retained for byte OR call stops;
 * the caller must separately validate the original stop and budget policy. */
export function verifyStoppedReadOnlyIdentitySession(text: string, root: string, record: Pick<IdentityRecord, "sessionId" | "provider" | "model">,
  prompt: string, rawRequests: string, rawMessages: string, contract: IdentitySessionContract, error: string, unsentContext: boolean) {
  return verifySessionObservations(inspectTranscript(text, root, { ...record, output: null }, prompt, contract, true, error),
    rawRequests, rawMessages, contract, unsentContext);
}

/** A first-request quota refusal proves no semantic output. Only the explicit
 * host continuation path may use this evidence; successful receipt checks stay strict. */
export function verifyQuotaRefusedIdentitySession(text: string, root: string, record: Pick<IdentityRecord, "sessionId" | "provider" | "model">,
  prompt: string, rawRequests: string, rawMessages: string, contract: IdentitySessionContract) {
  return verifySessionObservations(inspectTranscript(text, root, { ...record, output: null }, prompt, contract, true, undefined, false, true), rawRequests, rawMessages, contract);
}

/** Evidence of a rejected proposal only. It does not synthesize a successful
 * tool receipt; its caller must revalidate the exact proposal and retain a
 * separate narrowly scoped host recovery proof before independent review. */
export function verifyRejectedIdentitySubmission(text: string, root: string, record: Pick<IdentityRecord, "sessionId" | "provider" | "model"> & { output: unknown },
  prompt: string, rawRequests: string, rawMessages: string, contract: IdentitySessionContract, error: string) {
  return verifySessionObservations(inspectTranscript(text, root, record, prompt, contract, false, error), rawRequests, rawMessages, contract);
}

/** Retain a settled failed slot and all of its actual charges. This proves no
 * successful proposal; a separately authorized Pi correction must be validated. */
export function verifyFailedIdentitySession(text: string, root: string, record: Pick<IdentityRecord, "sessionId" | "provider" | "model"> & { output: unknown },
  prompt: string, rawRequests: string, rawMessages: string, contract: IdentitySessionContract) {
  return verifySessionObservations(inspectTranscript(text, root, record, prompt, contract, false, undefined, true), rawRequests, rawMessages, contract);
}

function verifySessionObservations({ messages, summary, localStop }: ReturnType<typeof inspectTranscript>, rawRequests: string, rawMessages: string, contract: IdentitySessionContract, requestSizeStop = false) {
  const lines = (raw: string) => {
    if (!raw.endsWith("\n")) throw prerequisiteStop("Identity evidence journal is incomplete; preserve the original, no authority or retry");
    return raw.trimEnd().split("\n").map(line => JSON.parse(line));
  };
  const observed = lines(rawMessages) as { sequence: number; message: Message }[];
  if (observed.some((row, i) => row.sequence !== i + 1) || contentHash(observed.map(row => row.message)) !== contentHash(messages))
    throw prerequisiteStop("Identity persisted transcript differs from its live message evidence; preserve both journals, no registration or retry");
  const journal = lines(rawRequests);
  if (journal.length !== summary.responses * 3 + (requestSizeStop ? 1 : 0)) throw prerequisiteStop("Identity request journal is incomplete");
  const originals = [], contexts = [], payloads = [];
  for (let i = 0; i < summary.responses * 3; i += 3) {
    const [original, context, payload] = journal.slice(i, i + 3);
    if (original.phase !== "original-context" || context.phase !== "context" || payload.phase !== "provider-payload"
      || contentHash(losslessJsonContext(normalizeContext(original.value), contract.readTools, jsonDictionaryProfile(context.value)).context) !== contentHash(context.value))
      throw prerequisiteStop("Identity context transport does not losslessly reconstruct the complete request");
    originals.push(original.value); contexts.push(context.value); payloads.push(payload.value);
  }
  let response = 0, systemHash: string | undefined;
  const prefix: Message[] = [];
  for (const [index, { message }] of observed.entries()) {
    if (message.role === "assistant" && !(localStop && index === observed.length - 1)) {
      const actual = originals[response++]?.messages as Message[] | undefined;
      // The trusted request policy rebuilds one system head with a fresh
      // timestamp. Its prompt/tools are stable; every other field/message is exact.
      if (!actual || actual[0]?.role !== "system" || actual.slice(1).some(m => m.role === "system")
        || contentHash(actual.slice(1)) !== contentHash(prefix.filter(m => m.role !== "system")))
        throw prerequisiteStop("Identity actual request omitted, reordered or changed its complete transcript prefix; preserve all evidence, no authority or retry");
      const { timestamp: _, ...system } = actual[0];
      if (systemHash && systemHash !== contentHash(system)) throw prerequisiteStop("Identity system prompt or tools changed between requests; no retry");
      systemHash = contentHash(system);
    }
    prefix.push(message);
  }
  let blockedRequestBytes: number | undefined;
  if (requestSizeStop) {
    const blocked = journal.at(-1), actual = blocked?.value?.messages as Message[] | undefined;
    if (!localStop || blocked?.phase !== "original-context" || !actual || actual[0]?.role !== "system"
      || contentHash(actual.slice(1)) !== contentHash(messages.filter(m => m.role !== "system" && m !== localStop)))
      throw prerequisiteStop("Blocked request lost its exact unsent transcript prefix; no recovery or retry");
    const { timestamp: _, ...system } = actual[0];
    if (contentHash(system) !== systemHash) throw prerequisiteStop("Blocked request changed its system contract; no recovery");
    blockedRequestBytes = Buffer.byteLength(JSON.stringify(losslessJsonContext(normalizeContext(blocked.value), contract.readTools,
      jsonDictionaryProfile(contexts.at(-1)!)).context));
  }
  return { transcript: summary, payloads, contexts, originals, messages, blockedRequestBytes };
}

export async function verifyIdentitySession(root: string, record: IdentityRecord, prompt: string, usage: ModelRequestUsage,
  expectedResponses: number, expectedToolResults: number) {
  const dir = identityRecordDirectory(root, record);
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(dir, `${record.stage}.${name}.json`), "utf8"));
  const session = await read("session"), checkpoint = await read("session-checkpoint");
  if (!record.sessionCheckpointHash || contentHash(checkpoint) !== record.sessionCheckpointHash || checkpoint.version !== 2
    || checkpoint.status !== "complete" || !checkpoint.persisted || checkpoint.sessionId !== record.sessionId
    || checkpoint.traceRunId !== record.traceRunId || checkpoint.inputHash !== record.inputHash || checkpoint.stage !== record.stage
    || checkpoint.promptHash !== contentHash(prompt) || contentHash(checkpoint.usage) !== contentHash(usage)
    || session.sessionId !== record.sessionId || session.inputHash !== record.inputHash || session.promptHash !== contentHash(prompt)
    || session.sessionFile !== checkpoint.sessionFile || session.model !== `${record.provider}/${record.model}`)
    throw prerequisiteStop("Identity session checkpoint is missing or detached from its committed record");
  const allowed = path.join(dir, "sessions", record.stage) + path.sep;
  if (typeof checkpoint.sessionFile !== "string" || !checkpoint.sessionFile.startsWith(allowed)
    || await fs.realpath(checkpoint.sessionFile) !== checkpoint.sessionFile)
    throw prerequisiteStop("Identity session checkpoint is outside its original stage");
  const bytes = await fs.readFile(checkpoint.sessionFile);
  if (bytes.length !== checkpoint.transcriptBytes || contentHash(bytes.toString("utf8")) !== checkpoint.transcriptHash)
    throw prerequisiteStop("Identity complete transcript changed after sealing; no authority or redispatch");
  const rawRequests = await fs.readFile(path.join(dir, `${record.stage}.requests.jsonl`), "utf8");
  const rawMessages = await fs.readFile(path.join(dir, `${record.stage}.messages.jsonl`), "utf8");
  if (contentHash(rawRequests) !== checkpoint.requestsHash || contentHash(rawMessages) !== checkpoint.messagesHash)
    throw prerequisiteStop("Identity raw request or live message journal changed or was truncated");
  const journal = verifyIdentitySessionEvidence(bytes.toString("utf8"), root, record, prompt, rawRequests, rawMessages);
  if (contentHash(journal.transcript) !== contentHash(checkpoint.transcript) || journal.transcript.responses !== expectedResponses || journal.transcript.toolResults !== expectedToolResults)
    throw prerequisiteStop("Identity transcript and settled trace disagree");
  const plan = await read("context-plan");
  if (contentHash(plan) !== checkpoint.contextPlanHash || plan.allowed !== true || plan.inputHash !== record.inputHash)
    throw prerequisiteStop("Identity complete-evidence admission receipt changed or was not admitted");
  if (!record.phase.endsWith("-check")) {
    const next = await read("next-context-plan");
    if (contentHash(next) !== checkpoint.nextContextPlanHash || next.allowed !== true)
      throw prerequisiteStop("Identity proposal has no sealed admission for its complete independent check");
  }
  return journal;
}

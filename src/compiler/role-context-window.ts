import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ModelRequestBudget } from "../runtime/model-request-budget.js";
import { contentHash } from "../world/canonical.js";
import { worldStorageRoot } from "../world/paths.js";
import { roleWorkStop } from "./role-review-work.js";

export const ROLE_CONTEXT_SOFT_BYTES = 36_000;
export class RoleContextPressure extends Error {
  constructor(readonly bytes: number, readonly phase: string) {
    super(`ROLE_CONTEXT_REPACK_REQUIRED: ${phase} requires ${bytes} bytes; host must repack this work with its existing budget and evidence obligations.`);
  }
}
/** Observe context sizes without predicting model capacity. Pi owns compaction.
 * Explicit pressure is reserved for a diagnosed recovery failure, never bytes. */
export class RoleContextWindow extends ModelRequestBudget {
  pressure?: RoleContextPressure;
  private measured = 0;
  private observations: Array<{phase:string;bytes:number;fields?:Record<string,number>;argumentBytes?:number;resultBytes?:number}> = [];
  private forecastBytes = 0;
  constructor() { super({ maxModelCalls: 12, maxRequestBytes: 48_000, maxTotalPayloadBytes: 1_572_864 }); }
  override beginCall(context: unknown) { this.checkWindow(context, "context"); }
  override admitPayload(payload: unknown) { this.checkWindow(payload, "provider-payload"); }
  private checkWindow(value: unknown, phase: string) {
    this.assertUsable();
    if (this.pressure) throw this.pressure;
    this.measured = Buffer.byteLength(JSON.stringify(value));
    const fields = value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,Buffer.byteLength(JSON.stringify(item)??'')])) : undefined;
    this.observe({phase,bytes:this.measured,fields});

  }
  requestFallback(phase: string) { this.pressure = new RoleContextPressure(this.measured, phase); return this.pressure; }
  /** Forecast is diagnostic, never a reason to end a session. Admission above
   * measures the actual context and provider payload before transport. */
  observeResult(args: unknown, result: unknown) {
    const argumentBytes=Buffer.byteLength(JSON.stringify(args)??''),resultBytes=Buffer.byteLength(JSON.stringify(result)??'');
    this.measured += argumentBytes + resultBytes;
    this.forecastBytes=this.measured;
    this.observe({phase:'tool-result',bytes:this.measured,argumentBytes,resultBytes});
  }
  private observe(item:typeof this.observations[number]){this.observations.push(item);if(this.observations.length>64)this.observations.shift();}
  metrics(){return {observationalWatermarkBytes:ROLE_CONTEXT_SOFT_BYTES,forecastBytes:this.forecastBytes,observations:this.observations};}
}
const accessSchema = z.object({
  id: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()), responseHash: z.string(),
  refs: z.array(z.string()), nextOffset: z.number().optional(),
  delivered: z.array(z.object({unitId:z.string(),startOffset:z.number().int().nonnegative(),endOffset:z.number().int().positive()})).optional()
}).strict();
const checkpointSchema = z.object({
  version: z.literal(1), planHash: z.string(), workId: z.string(), packetHash: z.string(),
  recoveryRunId: z.string().optional(), accesses: z.array(accessSchema), handoffs: z.array(z.object({ generation: z.number().int(), accessCount: z.number().int(), bytes: z.number(), phase: z.string() }).strict())
}).strict();
type Checkpoint = z.infer<typeof checkpointSchema>;
/** Host access metadata only, never a semantic summary or a second truth ledger. */
export class RoleContextCheckpoint {
  private constructor(private root: string, private file: string, private state: Checkpoint) { }
  static async open(root: string, planHash: string, workId: string, packetHash: string) {
    const file = path.join(worldStorageRoot(root), "compiler", "role-review-work", "context", planHash, `${contentHash(workId)}.json`);
    try { await fs.access(`${file}.pending`); throw roleWorkStop("uncertain context checkpoint publication"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let state: Checkpoint = { version: 1, planHash, workId, packetHash, accesses: [], handoffs: [] };
    try {
      const record = JSON.parse(await fs.readFile(file, "utf8")); state = checkpointSchema.parse(record.state);
      if (contentHash(state) !== record.hash || state.planHash !== planHash || state.workId !== workId || state.packetHash !== packetHash) throw roleWorkStop("context checkpoint scope or integrity changed");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return new RoleContextCheckpoint(root, file, state);
  }
  async restoreNavigation(runId: string) {
    if (this.state.recoveryRunId === runId) return;
    if (this.state.recoveryRunId || this.generation) throw roleWorkStop("context recovery navigation conflicts with retained handoff");
    const { TraceStore } = await import("../trace/store.js");
    // Root is explicit: do not infer workspace paths from state directory layout.
    const traceStore = new TraceStore(this.root);
    const events = await traceStore.peekEvents(runId);
    for (const event of events.filter(e => e.type === "tool.call.started" && typeof e.data?.toolName === "string" && e.data.toolName.startsWith("read_"))) {
      const completed = events.find(e => e.type === "tool.call.completed" && e.toolCallId === event.toolCallId && e.data?.isError !== true);
      if (!event.blobRef || !completed?.blobRef) continue;
      await this.record(String(event.data!.toolName), await traceStore.peekBlob(event.blobRef), await traceStore.peekBlob(completed.blobRef));
    }
    this.state.recoveryRunId = runId;
    this.state.handoffs.push({ generation: 1, accessCount: this.state.accesses.length, bytes: 0, phase: "trace-proven-legacy-recovery" });
    await this.save();
  }
  originalAccesses() { return this.state.accesses.map(({ tool, args, delivered }) => ({ tool, args, delivered })); }
  get generation() { return this.state.handoffs.length; }
  directory(offset = 0) {
    if (!Number.isInteger(offset) || offset < 0 || (offset !== 0 && offset >= this.state.accesses.length)) throw new Error("Unknown context history offset. Call read_role_context_history offset=0, copy nextOffset and retry once; never guess or repeat unchanged.");
    return { accesses: this.state.accesses.slice(offset, offset + 5), total: this.state.accesses.length, ...(offset + 5 < this.state.accesses.length ? { nextOffset: offset + 5 } : {}) };
  }
  manifest() {
    return {
      generation: this.generation, historyCount: this.state.accesses.length, historyTool: "read_role_context_history", recentAccess: this.state.accesses.slice(-3),
      guidance: "Access history is navigation, not evidence or resolved questions. Do not replay all pages. Use originals actually delivered in contextEvidence; read missing decisive units and exact claims. Preserve every assigned question and revision."
    };
  }
  async record(tool: string, args: unknown, result: unknown) {
    if (!tool.startsWith("read_") || tool === "read_role_context_history") return;
    const argument = z.record(z.string(), z.unknown()).parse(args);
    if (Buffer.byteLength(JSON.stringify(argument)) > 2000) throw roleWorkStop("context lookup arguments cannot fit a bounded handoff");
    let body: Record<string, unknown> = {};
    const response = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    if (response.isError) return;
    try { body = JSON.parse(response.content?.find(c => c.type === "text")?.text ?? "{}"); } catch { return; }
    if (!body || typeof body !== "object") return;
    if(body.alreadyDeliveredInCurrentContext===true)return;
    if (Array.isArray(body.units) && body.units.every(unit => unit?.alreadyDeliveredInCurrentContext === true)) return;
    const refs: string[] = [];
    for (const key of ["units", "records", "candidates", "pages", "fragments"]) if (Array.isArray(body[key])) for (const item of body[key] as Record<string, unknown>[]) {
      const ref = item.unitId ?? item.noteId ?? item.id ?? item.page;
      if (typeof ref === "string" || typeof ref === "number") refs.push(String(ref));
    }
    const responseHash = contentHash(result), id = contentHash({ tool, args: argument, responseHash });
    if (this.state.accesses.some(a => a.id === id)) return;
    const delivered=tool==='read_role_work_evidence'&&Array.isArray(body.units)?body.units.filter(u=>typeof u.text==='string'&&Number.isInteger(u.startOffset)&&Number.isInteger(u.endOffset)).map(u=>({unitId:u.unitId,startOffset:u.startOffset,endOffset:u.endOffset})):[];
    this.state.accesses.push({ id, tool, args: argument, responseHash, refs: [...new Set(refs)], ...(delivered.length?{delivered}:{}), ...(typeof body.nextOffset === "number" ? { nextOffset: body.nextOffset } : {}) });
    await this.save();
  }
  async handoff(pressure: RoleContextPressure) {
    const previous = this.state.handoffs.at(-1)?.accessCount ?? 0;
    if (this.generation >= 2) throw roleWorkStop("context handoff allowance exhausted; preserve questions and budget");
    if (this.state.accesses.length <= previous) throw roleWorkStop("context repack has no new access evidence; required material needs a narrower semantic task");
    this.state.handoffs.push({ generation: this.generation + 1, accessCount: this.state.accesses.length, bytes: pressure.bytes, phase: pressure.phase });
    await this.save();
  }
  private async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const pending = `${this.file}.pending`;
    try {
      await fs.writeFile(pending, JSON.stringify({ state: this.state, hash: contentHash(this.state) }), { flag: "wx", mode: 0o600 });
      await fs.rename(pending, this.file);
    } catch (error) { throw roleWorkStop(`uncertain context checkpoint publication: ${String(error)}`); }
  }
}

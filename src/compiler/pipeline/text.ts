import { z } from "zod";
import type { EvidenceRef, TextAnchor } from "../../world/model.js";
import { baseStructuralUnits, type SourceStructureManifest } from "../structure.js";
import { textAnchorForByteRange } from "../text-anchors.js";
import type { ByteRange } from "../world-completeness.js";

/**
 * Model-facing source text for one scope. The model sees base units labelled
 * `u<ordinal>` and cites them with copied text; the host resolves every
 * citation to exact bytes, lines and hashes. The model never supplies offsets.
 */
export type WindowUnit = { label: string; unitId: string; startByte: number; endByte: number; text: string; narrative: boolean };

const decoder = new TextDecoder("utf-8", { fatal: false });
const slice = (bytes: Uint8Array, range: ByteRange) => decoder.decode(bytes.subarray(range.startByte, range.endByte));
export const unitLabel = (ordinal: number) => `u${String(ordinal).padStart(4, "0")}`;

export function windowUnits(structure: SourceStructureManifest, bytes: Uint8Array, range: ByteRange): WindowUnit[] {
  return baseStructuralUnits(structure).flatMap((unit, ordinal) => unit.anchor.startByte >= range.startByte && unit.anchor.endByte <= range.endByte
    ? [{ label: unitLabel(ordinal), unitId: unit.id, startByte: unit.anchor.startByte, endByte: unit.anchor.endByte, text: slice(bytes, unit.anchor), narrative: unit.kind !== "non-scene" }]
    : []);
}

/** One line per unit; blank units are omitted. */
export function renderUnits(units: readonly WindowUnit[]): string {
  return units.filter((unit) => unit.text.trim()).map((unit) => `[${unit.label}] ${unit.text.replace(/\s+$/u, "").replace(/\n/gu, " ")}`).join("\n");
}

export function sourceText(bytes: Uint8Array, range: ByteRange): string { return slice(bytes, range); }

export const spanSelectorSchema = z.object({
  unit: z.string().regex(/^u\d{4,}$/u).describe("Unit label from the scope text, e.g. u0012"),
  text: z.string().min(1).max(2_000).describe("Exact text copied from that unit"),
  nth: z.number().int().positive().optional().describe("Which occurrence inside the unit (default 1)"),
}).strict();
export type SpanSelector = z.infer<typeof spanSelectorSchema>;
export const extentSelectorSchema = z.object({
  from: z.string().regex(/^u\d{4,}$/u),
  to: z.string().regex(/^u\d{4,}$/u),
}).strict();
export type ExtentSelector = z.infer<typeof extentSelectorSchema>;

export class ScopeText {
  private readonly byLabel: Map<string, WindowUnit>;
  constructor(readonly sourceId: string, readonly bytes: Uint8Array, readonly units: readonly WindowUnit[]) {
    this.byLabel = new Map(units.map((unit) => [unit.label, unit]));
  }
  get range(): ByteRange { return { startByte: this.units[0]?.startByte ?? 0, endByte: this.units.at(-1)?.endByte ?? 0 }; }
  render(): string { return renderUnits(this.units); }
  unit(label: string): WindowUnit {
    const unit = this.byLabel.get(label);
    if (!unit) throw new Error(`Unknown unit ${label}: cite a [uNNNN] label shown in this scope's text.`);
    return unit;
  }
  /** Exact bytes of copied text inside one unit. */
  span(selector: SpanSelector): ByteRange {
    const unit = this.unit(selector.unit);
    let from = 0, index = -1;
    for (let count = 0; count < (selector.nth ?? 1); count += 1) {
      index = unit.text.indexOf(selector.text, from);
      if (index < 0) throw new Error(`Text "${selector.text.slice(0, 40)}" occurs ${count} time(s) in ${selector.unit}; copy it exactly from that unit (nth ${selector.nth ?? 1}).`);
      from = index + selector.text.length;
    }
    const startByte = unit.startByte + Buffer.byteLength(unit.text.slice(0, index), "utf8");
    return { startByte, endByte: startByte + Buffer.byteLength(selector.text, "utf8") };
  }
  extent(selector: ExtentSelector): ByteRange {
    const from = this.unit(selector.from), to = this.unit(selector.to);
    if (to.startByte < from.startByte) throw new Error(`Extent ${selector.from}..${selector.to} runs backwards.`);
    return { startByte: from.startByte, endByte: to.endByte };
  }
  anchor(range: ByteRange): TextAnchor { return textAnchorForByteRange(this.sourceId, this.bytes, range.startByte, range.endByte); }
  evidence(range: ByteRange, strength: EvidenceRef["strength"] = "explicit"): EvidenceRef {
    const anchor = this.anchor(range);
    return { span: { sourceId: this.sourceId, startByte: anchor.startByte, endByte: anchor.endByte, startLine: anchor.startLine, endLine: anchor.endLine, quoteHash: anchor.exactHash }, strength };
  }
  text(range: ByteRange): string { return slice(this.bytes, range); }
  /** The unit containing a byte offset, if it is in this scope. */
  unitAt(byte: number): WindowUnit | undefined { return this.units.find((unit) => unit.startByte <= byte && byte < unit.endByte); }
}

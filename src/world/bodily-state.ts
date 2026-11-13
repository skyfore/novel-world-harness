import type { EvidenceAssertion, StateFieldSpec, ValidationIssue } from "./model.js";

export const BODILY_STATE_FIELDS: StateFieldSpec[] = [
  // Missing values remain unknown. These observations imply neither identity,
  // location, numeric health nor permission/capacity to perform another action.
  { key: "character.posture", appliesTo: ["character"], valueType: "string", cardinality: "one", visibility: "self", worldAssumption: "open", entryContext: "bodily", allowedValues: ["lying", "sitting", "standing", "kneeling", "crouching"] },
  { key: "character.breathing", appliesTo: ["character"], valueType: "string", cardinality: "one", visibility: "self", worldAssumption: "open", entryContext: "bodily", allowedValues: ["steady", "labored", "held"] },
  { key: "character.sweating", appliesTo: ["character"], valueType: "string", cardinality: "one", visibility: "self", worldAssumption: "open", entryContext: "bodily", allowedValues: ["absent", "present", "cold-sweat"] },
  { key: "character.wakefulness", appliesTo: ["character"], valueType: "string", cardinality: "one", visibility: "self", worldAssumption: "open", entryContext: "bodily", allowedValues: ["awake", "asleep", "unconscious"] },
];

export const BODILY_STATE_INPUT_GUIDANCE = `Qualitative bodily fields and exact allowed values: ${BODILY_STATE_FIELDS.map(field => `${field.key}=[${field.allowedValues!.join(",")}]`).join("; ")}. Each set needs explicit or strong-inference supports evidence_selector at its exact operation JSON Pointer. Missing values stay unknown; never infer identity, location, numeric health or action capacity from these states.`;

/** A new qualitative state must have exact source support in compiler data.
 * Runtime actions keep their existing mechanism/commit provenance boundary. */
export function bodilyStateEvidenceIssues(payload: unknown, assertions: readonly EvidenceAssertion[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bodilyFields = new Set(BODILY_STATE_FIELDS.map(field => field.key));
  const visit = (node: unknown, pointer: string) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((value, index) => visit(value, `${pointer}/${index}`)); return; }
    const record = node as Record<string, unknown>;
    if (record.op === "set" && "entityId" in record && bodilyFields.has(String(record.field)) && !assertions.some(item => item.target.jsonPointer === pointer
      && item.relation === "supports" && item.strength !== "weak-inference" && item.anchors.length)) {
      issues.push({ code: "BODILY_STATE_EVIDENCE_REQUIRED", path: pointer,
        message: "Qualitative bodily state requires exact explicit or strong-inference support for this typed operation (subject, field and value). Read the same-source evidence and correct its selector once; if unsupported, stop without deriving numeric health, identity, place or action capacity." });
    }
    for (const [key, value] of Object.entries(record)) visit(value, `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
  };
  visit(payload, "");
  return issues;
}

import { expect, it } from "vitest";
import { attributionContentTraceIssues } from "../src/compiler/attribution-trace.js";
import type { Attribution, EvidenceAssertion } from "../src/world/model.js";
import { SOURCE_ANNOTATION_ONTOLOGY_VERSION, type Quotation } from "../src/compiler/annotations.js";
import { textAnchorForByteRange } from "../src/compiler/text-anchors.js";

it("uses field-level coverage at the production attribution validation boundary", () => {
  const bytes = Buffer.from("Help now. People are trapped.");
  const quoteAnchor = textAnchorForByteRange("source", bytes, 0, 9);
  const outside = textAnchorForByteRange("source", bytes, 10, bytes.length);
  const quotation: Quotation = {
    version: 1, id: "q", sourceId: "source", annotationType: "quotation", anchor: quoteAnchor,
    mode: "direct", addresseeMentionIds: [], attributionConfidence: 1,
    derivation: { runId: "test", worker: "test", ontologyVersion: SOURCE_ANNOTATION_ONTOLOGY_VERSION },
  };
  const attribution: Attribution = { id: "a", propositionId: "p", holderKind: "narrator", attitude: "reports", certainty: 1, quotationIds: ["q"], evidence: [] };
  const assertion = (id: string, jsonPointer: string, anchor = quoteAnchor): EvidenceAssertion => ({
    version: 1, id, target: { artifactKind: "proposition", artifactId: "p", jsonPointer },
    anchors: [anchor], relation: "supports", strength: "explicit",
    derivation: { runId: "test", worker: "test", ontologyVersion: "evidence-v1" },
  });
  const catalog = new Map([["q", quotation]]);
  const bad = assertion("bad", "/object/value", outside);
  expect(attributionContentTraceIssues(attribution, [bad, assertion("kind", "/object/kind")], catalog).join()).toContain("outside its cited quotation content");
  expect(attributionContentTraceIssues(attribution, [assertion("kind", "/object/kind")], catalog).join()).toContain("unverified");
  expect(attributionContentTraceIssues(attribution, [bad, assertion("alternative", "/object/value")], catalog)).toEqual([]);
  // Legacy readability is intentionally not upgraded to a semantic certificate.
  expect(attributionContentTraceIssues(attribution, [], catalog)).toEqual([]);
});

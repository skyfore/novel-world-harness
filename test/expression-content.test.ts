import { expect, it } from "vitest";
import { assessExpressionObjectSupport } from "../src/compiler/expression-content.js";
import type { ContentAssertion, ContentSpan } from "../src/compiler/content-support.js";
import type { PropositionObject } from "../src/world/model.js";

const scenes = [
  { text: 'Ada says, "The river is rising." Later Bo repeats, "The river is rising."', content: "The river is rising." },
  { text: 'A door closes. "The road is blocked," says Neri. Venn later says, "The road is blocked."', content: "The road is blocked" },
];
it.each(scenes)("uses the actual object schema and this expression's source fragments: $content", scene => {
  const bytes = Buffer.from(scene.text), first = bytes.indexOf(scene.content), second = bytes.indexOf(scene.content, first + 1), length = Buffer.byteLength(scene.content);
  const span = (startByte: number, endByte = startByte + length): ContentSpan => ({ sourceId: "original-source", startByte, endByte });
  const a = span(first), b = span(second);
  const assertion = (id: string, jsonPointer: string, anchors = [a]): ContentAssertion => ({ target: { artifactKind: "proposition", artifactId: id, jsonPointer }, relation: "supports", anchors });
  const literal = { id: "p", object: { kind: "literal" as const, value: scene.content } }, catalog = new Map([[literal.id, literal]]);
  const assess = (proof: ContentAssertion[], fragments = [a]) => assessExpressionObjectSupport("p", catalog, proof, fragments);
  expect(assess([assertion("p", "/object/entityId")])).toMatchObject({ status: "unverified", objects: [{ missingPaths: ["/object/value"] }] });
  expect(assess([assertion("p", "/object/kind")]).status).toBe("unverified");
  expect(assess([assertion("p", "/object/value")]).status).toBe("supported");
  expect(assess([assertion("p", "/object/value")], [b]).status).toBe("unsupported");
  expect(assess([assertion("p", "/object/value", [b])], [b]).status).toBe("supported");
  expect(assess([assertion("p", "/object/value", [a, b])], [a, b]).status).toBe("supported");
  expect(assess([assertion("p", "/object/value", [span(first, second + length)])], [a, b]).status).toBe("unsupported");
  expect(assess([assertion("p", "/object/value", [a, b])]).status).toBe("unsupported");
  expect(assess([assertion("p", "/object/value", [b]), assertion("p", "/object/value")]).status).toBe("supported");

  const outer = { id: "outer", object: { kind: "proposition" as const, propositionId: "p" } };
  const nested = new Map<string, { id: string; object: PropositionObject }>([[literal.id, literal], [outer.id, outer]]);
  const reference = assertion("outer", "/object/propositionId");
  expect(assessExpressionObjectSupport("outer", nested, [reference], [a])).toMatchObject({ status: "unverified", issues: [{ code: "EXPRESSION_CONTENT_MISSING", propositionId: "p" }] });
  expect(assessExpressionObjectSupport("outer", nested, [assertion("outer", "/object"), assertion("p", "/object/value", [b])], [a]).status).toBe("unsupported");
  expect(assessExpressionObjectSupport("outer", nested, [reference, assertion("p", "/object/value")], [a]).status).toBe("supported");
  nested.set("p", { id: "p", object: { kind: "proposition", propositionId: "outer" } });
  expect(assessExpressionObjectSupport("outer", nested, [assertion("outer", "/object"), assertion("p", "/object")], [a])).toMatchObject({ status: "unsupported", issues: [{ code: "EXPRESSION_PROPOSITION_CYCLE", propositionId: "outer" }] });
});

it("keeps missing nested content unverified and bounds cyclic or deep expansion", () => {
  const catalog = new Map<string, { id: string; object: PropositionObject }>();
  const assertions: ContentAssertion[] = [], fragment = { sourceId: "source", startByte: 0, endByte: 10 };
  for (let index = 0; index < 40; index++) {
    const id = `p${index}`;
    catalog.set(id, { id, object: { kind: "proposition", propositionId: `p${index + 1}` } });
    assertions.push({ target: { artifactKind: "proposition", artifactId: id, jsonPointer: "/object" }, relation: "supports", anchors: [fragment] });
  }
  const result = assessExpressionObjectSupport("p0", catalog, assertions, [fragment]);
  expect(result.status).toBe("unsupported");
  expect(result.objects).toHaveLength(32);
  expect(result.issues).toEqual([{ code: "EXPRESSION_EXPANSION_LIMIT", propositionId: "p32" }]);
  expect(assessExpressionObjectSupport("p39", catalog, assertions, [fragment])).toMatchObject({ status: "unverified", issues: [{ code: "EXPRESSION_PROPOSITION_MISSING", propositionId: "p40" }] });
});

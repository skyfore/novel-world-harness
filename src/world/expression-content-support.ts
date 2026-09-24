/**
 * Field-level quotation coverage (plan D2/T1). This checks source containment,
 * not natural-language entailment, source authenticity, or character access.
 * Callers must first validate immutable source anchors and identity scope.
 */
export type ContentSpan = {
  readonly sourceId: string;
  readonly startByte: number;
  readonly endByte: number;
};
export type ContentAssertion = {
  readonly target: {
    readonly artifactKind: string;
    readonly artifactId: string;
    readonly jsonPointer: string;
  };
  readonly relation: string;
  readonly anchors: readonly ContentSpan[];
};
export type ContentSupportAssessment = {
  status: "supported" | "unsupported" | "unverified";
  supportedPaths: string[];
  missingPaths: string[];
};

// These are the content-bearing variants of propositionObjectSchema. The
// discriminator /object/kind is intentionally NOT a content obligation.
const CONTENT_PATHS = new Set([
  "/object/value", "/object/entityId", "/object/propositionId",
]);

function validSpan(span: ContentSpan): boolean {
  return span.sourceId.length > 0
    && Number.isSafeInteger(span.startByte) && Number.isSafeInteger(span.endByte)
    && span.startByte >= 0 && span.endByte > span.startByte;
}

export function assessQuotationContentSupport(
  propositionId: string,
  assertions: readonly ContentAssertion[],
  quotationSpans: readonly ContentSpan[],
  requiredPaths?: readonly string[],
): ContentSupportAssessment {
  const content = assertions.filter(assertion =>
    assertion.target.artifactKind === "proposition"
    && assertion.target.artifactId === propositionId
    && assertion.relation === "supports"
    && (assertion.target.jsonPointer === "/object"
      || (requiredPaths ? requiredPaths.includes(assertion.target.jsonPointer) : CONTENT_PATHS.has(assertion.target.jsonPointer))));
  if (!content.length) return { status: "unverified", supportedPaths: [], missingPaths: requiredPaths ? [...requiredPaths] : ["/object"] };

  const covered = (assertion: ContentAssertion): boolean => assertion.anchors.length > 0
    && assertion.anchors.every(anchor => validSpan(anchor) && quotationSpans.some(quote =>
      validSpan(quote) && quote.sourceId === anchor.sourceId
      && quote.startByte <= anchor.startByte && quote.endByte >= anchor.endByte));
  // A whole-object assertion is an alternative proof of the complete object.
  if (content.some(assertion => assertion.target.jsonPointer === "/object" && covered(assertion))) {
    return { status: "supported", supportedPaths: ["/object"], missingPaths: [] };
  }
  const paths = [...new Set(requiredPaths ?? content.map(assertion => assertion.target.jsonPointer)
    .filter(pointer => pointer !== "/object"))].sort();
  if (!paths.length) return { status: "unsupported", supportedPaths: [], missingPaths: ["/object"] };
  const supportedPaths = paths.filter(pointer => content.some(assertion =>
    assertion.target.jsonPointer === pointer && covered(assertion)));
  const missingPaths = paths.filter(pointer => !supportedPaths.includes(pointer));
  return { status: missingPaths.length ? "unsupported" : "supported", supportedPaths, missingPaths };
}

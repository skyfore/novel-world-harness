import type { CanonicalModelStore } from "./canonical-model.js";
import type { Claim, EvidenceRef } from "./model.js";

export type NarrativeMetaKind =
  | "theme"
  | "motif"
  | "arc"
  | "foreshadowing"
  | "dramatic-irony"
  | "framing"
  | "genre"
  | "symbolism"
  | "interpretation";

export type NarrativeObservation = {
  id: string;
  kind: NarrativeMetaKind;
  subject: string;
  statement: unknown;
  speaker?: string;
  evidence: EvidenceRef[];
  claimId: string;
};

const META_PREDICATES: Record<string, NarrativeMetaKind> = {
  theme: "theme",
  motif: "motif",
  arc: "arc",
  foreshadowing: "foreshadowing",
  "dramatic-irony": "dramatic-irony",
  framing: "framing",
  genre: "genre",
  symbolism: "symbolism",
};

export class NarrativeMetaView {
  constructor(private readonly canon: CanonicalModelStore) {}

  async list(options: { kind?: NarrativeMetaKind; subject?: string } = {}): Promise<NarrativeObservation[]> {
    const claims = await this.canon.listClaims();
    return claims
      .filter((claim) => claim.epistemicType === "interpretation")
      .map(toObservation)
      .filter((observation) => !options.kind || observation.kind === options.kind)
      .filter((observation) => !options.subject || observation.subject === options.subject)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async bySubject(subject: string): Promise<NarrativeObservation[]> {
    return this.list({ subject });
  }

  async byKind(kind: NarrativeMetaKind): Promise<NarrativeObservation[]> {
    return this.list({ kind });
  }
}

export function isNarrativeInterpretation(claim: Claim): boolean {
  return claim.epistemicType === "interpretation";
}

function toObservation(claim: Claim): NarrativeObservation {
  const kind = META_PREDICATES[claim.predicate] ?? "interpretation";
  return {
    id: `meta:${claim.id}`,
    kind,
    subject: claim.subject,
    statement: claim.object,
    ...(claim.speaker ? { speaker: claim.speaker } : {}),
    evidence: claim.evidence,
    claimId: claim.id,
  };
}

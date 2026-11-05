import { z } from "zod";
import { contentHash } from "../world/canonical.js";
import { canonicalEventSchema, storyTimeSchema } from "../world/model.js";
import { initialWorldRevisionFields } from "./initial-world-repair.js";
import { prerequisiteStop } from "./role-source-prerequisites.js";

export const CONSUMER_REVIEW_CONTRACT = "consumer-review/v2" as const;
export const CONSUMER_REVIEW_CORRECTION = "consumer-review-scope/v1" as const;
export const consumerReviewCorrectionContract = { policy: CONSUMER_REVIEW_CORRECTION,
  correction: "Assess the consumer at its own exact cut; preserve original global questions and every previous negative judgment. No world write or predetermined verdict." };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.object({ ref: z.string().min(1), revisionHash: hash }).strict();
export const consumerReviewCheckSchema = z.enum(["source-support", "identity-dependencies", "temporal-boundary",
  "knowledge-isolation", "presence-and-agency", "entry-state"]);
export const consumerReviewContractSchema = z.object({
  version: z.literal(CONSUMER_REVIEW_CONTRACT), ref: z.string().min(1), currentRevisionHash: hash,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("initial-world"), storyTime: storyTimeSchema.optional() }).strict(),
    z.object({ kind: z.literal("character-entry"), actorId: z.string().min(1), beforeEventId: z.string().min(1),
      storyTime: storyTimeSchema, position: z.literal("before-event") }).strict(),
    z.object({ kind: z.literal("artifact"), artifactKind: z.string().min(1) }).strict(),
  ]),
  ownerRefs: z.array(ref), requiredChecks: z.array(consumerReviewCheckSchema).min(1),
  originalRequirements: z.literal("consumer-dependency-compatibility"),
  globalIdentityQuestions: z.literal("retained"),
}).strict();
export type ConsumerReviewContract = z.infer<typeof consumerReviewContractSchema>;
export const consumerReviewAssessmentSchema = z.object({ contractHash: hash,
  checks: z.array(z.object({ id: consumerReviewCheckSchema, verdict: z.enum(["supported", "blocked"]),
    rationale: z.string().trim().min(1).max(6000) }).strict()).min(1),
  globalIdentityQuestions: z.literal("retained"),
}).strict();

type Artifact = { kind: string; id: string; payload: unknown; revisionHash: string; current: boolean };
function stop(reason: string): never { throw prerequisiteStop(`${reason}. Inspect requirements inspect-identity-repairs with the same --source/--task; copy items[].ref or availableRefs[] into --ref once and inspect its owning event/execution. Missing, stale or conflicting ownership requires host repair, no guessed cut, changed opening or unchanged retry`); }

/** Mechanical ownership and time, not a model verdict or permission to erase a
 * dependency. Initial-world context stays available but is not every entry's cut. */
export function deriveConsumerReviewContract(input: { sourceId: string; ref: string; current: { payload: unknown; revisionHash: string }; catalog: readonly Artifact[] }): ConsumerReviewContract {
  const { sourceId, ref, current, catalog } = input;
  if (contentHash(current.payload) !== current.revisionHash) stop("Consumer revision changed");
  const [kind, actorId, eventId, extra] = ref.split("/");
  const ownerRefs: ConsumerReviewContract["ownerRefs"] = [];
  const requiredChecks: ConsumerReviewContract["requiredChecks"] = ["source-support", "identity-dependencies", "temporal-boundary", "knowledge-isolation"];
  let target: ConsumerReviewContract["target"];
  if (kind === "entry") {
    if (!actorId || !eventId || extra) stop("Entry needs its exact actor/event pair");
    const owner = catalog.find(a => a.kind === "canonical-event" && a.id === eventId && a.current);
    if (!owner || contentHash(owner.payload) !== owner.revisionHash) stop("Entry has no exact active owning event");
    const parsed = canonicalEventSchema.safeParse(owner.payload);
    if (!parsed.success || parsed.data.id !== eventId) stop("Entry owning event is invalid");
    const entry = current.payload as { actorId?: string };
    if (entry.actorId !== actorId) stop("Entry actor differs from its original ref");
    ownerRefs.push({ ref: `canonical-event:${eventId}`, revisionHash: owner.revisionHash });
    for (const binding of catalog.filter(a => a.kind === "event-execution" && a.current)) {
      const value = binding.payload as { actorId?: string; canonicalEventId?: string; entryCheckpoint?: unknown };
      if (value.actorId === actorId && value.canonicalEventId === eventId && value.entryCheckpoint) {
        if (contentHash(binding.payload) !== binding.revisionHash) stop("Entry execution revision changed");
        ownerRefs.push({ ref: `event-execution:${binding.id}`, revisionHash: binding.revisionHash });
      }
    }
    target = { kind: "character-entry", actorId, beforeEventId: eventId, storyTime: parsed.data.storyTime, position: "before-event" };
    requiredChecks.push("presence-and-agency", "entry-state");
  } else if (kind === "initial") {
    if (ref !== `initial/${sourceId}`) stop("Initial-world consumer belongs to another source");
    const initial = current.payload as { checkpoint?: { storyTime?: unknown } };
    target = { kind: "initial-world", ...(initial.checkpoint?.storyTime ? { storyTime: storyTimeSchema.parse(initial.checkpoint.storyTime) } : {}) };
    requiredChecks.push("presence-and-agency", "entry-state");
  } else target = { kind: "artifact", artifactKind: kind! };
  return consumerReviewContractSchema.parse({ version: CONSUMER_REVIEW_CONTRACT, ref, currentRevisionHash: current.revisionHash,
    target, ownerRefs, requiredChecks, originalRequirements: "consumer-dependency-compatibility", globalIdentityQuestions: "retained" });
}

export function consumerReviewCapability(scope: { sourceId: string; ref: string; reviewContract?: ConsumerReviewContract }) {
  // Exact legacy inputs must remain reconstructible for sealed receipts.
  return !scope.reviewContract || scope.ref === `initial/${scope.sourceId}`
    ? { kind: "initial-world", id: "singleton", writableFields: initialWorldRevisionFields, createsEntity: false }
    : { kind: "read-only-consumer", ref: scope.ref, writableFields: [], createsEntity: false };
}

export function validateConsumerReviewAssessment(contract: ConsumerReviewContract | undefined, output: {
  phase: string; disposition?: string; review?: z.infer<typeof consumerReviewAssessmentSchema>; reviewContractHash?: string;
}) {
  if (!contract) {
    if (output.review || output.reviewContractHash) stop("Legacy scope cannot adopt an unbound review contract");
    return;
  }
  if (output.phase === "consumer-revalidation-check") {
    if (output.reviewContractHash !== contentHash(contract)) stop("Independent check lost the exact consumer time/scope contract");
    return;
  }
  const review = output.review;
  if (!review || review.contractHash !== contentHash(contract) || review.globalIdentityQuestions !== "retained"
    || contentHash(review.checks.map(c => c.id).sort()) !== contentHash([...contract.requiredChecks].sort()))
    stop("Consumer assessment omitted or changed its exact time/scope checks");
  if (["unaffected", "revalidated"].includes(output.disposition ?? "") && review.checks.some(c => c.verdict !== "supported"))
    stop("An unresolved consumer check cannot clear this consumer");
}

export const consumerReviewInstructions = `Use reviewContract as the host-bound assessment target. For character-entry, evaluate the exact actor immediately BEFORE beforeEventId at that event's storyTime, never at the novel's initial-world cut. Read the full owning event and execution bindings. A later entry need not prove presence or a plan in the prologue. Do not move the singleton opening or import the owning event's outcome, later knowledge, or future canon into this entry. Unknown chronology remains unknown and blocks any dependent claim. For initial-world, retain the original opening contract. For other artifacts, assess their own validity and actual identity dependencies.
Keep EVERY original requirement and question. requirements[].verdict evaluates this consumer's compatibility with that requirement, not whether the original global identity question is solved. Explain actual relevant dependencies or why a requirement adds no obligation to this consumer; do not invent a new requirement or drop original criteria. Local support must not assert an unresolved identity. The global questions, full denominator, old negative judgments and source-audit obligations remain unchanged.
Complete review.checks for every requiredChecks item against the target cut. Unsupported bodily presence, agency, entry state or knowledge acquisition stays blocked; a correct cut alone never proves these facts. A supported local review is neither an executable-world certificate nor an action or autonomous-driver witness. The independent checker uses the SAME reviewContract and returns its exact reviewContractHash. Repair capability is separate from assessment scope; a read-only consumer cannot request initialWorldRepair or entityRepair.`;

import { z } from "zod";
import { idSchema, validationIssueSchema } from "../world/model.js";

export const ADMISSION_TIERS = ["blocked", "replayable", "enterable", "reviewed", "certified"] as const;
export const admissionTierSchema = z.enum(ADMISSION_TIERS);
export type AdmissionTier = z.infer<typeof admissionTierSchema>;
export const DEFAULT_MINIMUM_ADMISSION_TIER: AdmissionTier = "enterable";

export function tierAtLeast(tier: AdmissionTier, minimum: AdmissionTier): boolean {
  return ADMISSION_TIERS.indexOf(tier) >= ADMISSION_TIERS.indexOf(minimum);
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const entryProbeKindSchema = z.enum(["genesis", "decision", "driver", "intent", "wait", "resume", "fork"]);

export const actorAdmissionSchema = z.object({
  actorId: idSchema,
  tier: admissionTierSchema,
  entryBasis: z.enum(["opening", "checkpoint", "derived"]),
  entryCutHash: hashSchema.optional(),
  probes: z.array(z.object({ kind: entryProbeKindSchema, passed: z.boolean() }).strict()),
  issues: z.array(validationIssueSchema),
}).strict();
export type ActorAdmission = z.infer<typeof actorAdmissionSchema>;

export const cutAdmissionSchema = z.object({
  cutId: hashSchema,
  beforeEventId: idSchema,
  sceneId: idSchema.optional(),
  sceneIds: z.array(idSchema),
  index: z.number().int().nonnegative(),
  discourseByte: z.number().int().nonnegative(),
  tier: admissionTierSchema,
  actors: z.array(actorAdmissionSchema),
  blocking: z.array(validationIssueSchema),
  advisories: z.array(validationIssueSchema),
  /** Event and scene nodes whose revision changes invalidate this cut; the full closure is bound by closureHash. */
  dependsOn: z.array(z.string().min(1)),
  closureHash: hashSchema,
}).strict();
export type CutAdmission = z.infer<typeof cutAdmissionSchema>;

export const admissionManifestSchema = z.object({
  version: z.literal(1),
  sourceId: idSchema,
  subjectHash: hashSchema,
  timelineHash: hashSchema,
  baselineIndex: z.number().int().nonnegative(),
  /** Farthest timeline position replayable contiguously from the opening; -1 when none is. */
  horizonIndex: z.number().int().min(-1),
  replay: z.object({ limitIndex: z.number().int().min(-1), failedEventId: idSchema.optional(), failure: z.string().optional() }).strict(),
  cuts: z.array(cutAdmissionSchema),
  /** Novel-wide issues: they gate only the certified tier. */
  globalIssues: z.array(validationIssueSchema),
}).strict();
export type AdmissionManifest = z.infer<typeof admissionManifestSchema>;


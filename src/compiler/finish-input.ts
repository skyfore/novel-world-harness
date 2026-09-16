import { z } from "zod";
import { idSchema } from "../world/model.js";
import { reconciliationTargetReviewSchema } from "./reconciliation-review.js";

export const compilerFinishInputSchema = z.object({
  target_reviews: z.array(reconciliationTargetReviewSchema).max(128).optional(),
  outcome: z.enum(["complete", "no-artifacts"]),
  reviewed_segments: z.array(z.object({ segment_id: idSchema, disposition: z.enum(["proposed", "no-artifacts"]), summary: z.string().min(1).max(500) }).strict()),
  summary: z.string().min(1).max(2_000),
}).strict();

import { z } from "zod";
import { idSchema } from "../world/model.js";
import { characterDimensionIdSchema } from "../world/character-ontology.js";

/** Source reviewers record expectations before seeing compiled character models. */
export const roleDevelopmentExpectationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stable"), rationale: z.string().trim().min(1).max(2000), basisUnitIds: z.array(idSchema).min(1) }).strict(),
  z.object({ kind: z.literal("unknown"), rationale: z.string().trim().min(1).max(2000), basisUnitIds: z.array(idSchema).min(1) }).strict(),
  z.object({ kind: z.literal("changes"), rationale: z.string().trim().min(1).max(2000), changes: z.array(z.object({
    dimensionId: characterDimensionIdSchema,
    direction: z.enum(["increase", "decrease"]),
    rationale: z.string().trim().min(1).max(2000),
    beforeUnitIds: z.array(idSchema).min(1), afterUnitIds: z.array(idSchema).min(1),
  }).strict()).min(1).max(32) }).strict(),
]);
export type RoleDevelopmentExpectation = z.infer<typeof roleDevelopmentExpectationSchema>;

export const roleRosterEntrySchema = z.object({
  candidateId: idSchema,
  importance: z.enum(["major", "supporting", "incidental"]),
  rationale: z.string().trim().min(1).max(2000),
  basisUnitIds: z.array(idSchema).min(1),
  developmentExpectation: roleDevelopmentExpectationSchema.optional(),
}).strict();

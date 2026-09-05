import { z } from "zod";
const validationIssueSchema = z.object({ code: z.string(), message: z.string(), path: z.string().optional() }).strict();

export const preparedPlayRoleSchema = z.object({
  id: z.string().min(1), rosterEntryId: z.string().min(1), actorId: z.string().min(1).optional(),
  canonicalName: z.string().min(1), aliases: z.array(z.string()), major: z.boolean(),
  status: z.enum(["ready", "blocked", "unresolved-identity"]),
  entryKind: z.enum(["opening", "canonical-scene"]).optional(), entryTitle: z.string().optional(),
  entryCutHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), issues: z.array(validationIssueSchema),
}).strict().superRefine((role, context) => {
  if (role.status === "ready" && (!role.actorId || !role.entryCutHash || !role.entryKind || !role.entryTitle || role.issues.length)) context.addIssue({ code: "custom", message: "Ready roles require identity, a certified entry and no blocking issues" });
  if (role.status === "unresolved-identity" && role.actorId) context.addIssue({ code: "custom", message: "Unresolved roles cannot contain an actor identity" });
});
export type PreparedPlayRole = z.infer<typeof preparedPlayRoleSchema>;

import { z } from "zod";
import {
  entityKindSchema,
  eventFrameInstanceSchema,
  eventParticipationRoleSchema,
  evidenceRefSchema,
  idSchema,
  type CanonicalEvent,
  type Entity,
  type EventFrameInstance,
  type ValidationIssue,
} from "./model.js";

export const EVENT_FRAME_ONTOLOGY_VERSION = "event-frame-v1" as const;

export const eventFrameRoleSpecSchema = z.object({
  id: idSchema,
  label: z.string().trim().min(1).max(240),
  semanticRole: eventParticipationRoleSchema,
  allowedEntityKinds: z.array(entityKindSchema).min(1).max(8),
  minCardinality: z.number().int().nonnegative().max(32),
  maxCardinality: z.number().int().positive().max(32),
  presence: z.enum(["physical", "remote", "any"]).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.maxCardinality < value.minCardinality) {
    ctx.addIssue({ code: "custom", path: ["maxCardinality"], message: "maxCardinality must be >= minCardinality" });
  }
  if (new Set(value.allowedEntityKinds).size !== value.allowedEntityKinds.length) {
    ctx.addIssue({ code: "custom", path: ["allowedEntityKinds"], message: "allowedEntityKinds must be unique" });
  }
});
export type EventFrameRoleSpec = z.infer<typeof eventFrameRoleSpecSchema>;

export const eventFrameSchema = z.object({
  ontologyVersion: z.literal(EVENT_FRAME_ONTOLOGY_VERSION),
  id: idSchema,
  name: z.string().trim().min(1).max(300),
  roles: z.array(eventFrameRoleSpecSchema).min(1).max(64),
  temporalShape: z.enum(["instant", "interval", "process-boundary"]),
  evidence: z.array(evidenceRefSchema),
}).strict().superRefine((value, ctx) => {
  const roleIds = new Set<string>();
  value.roles.forEach((role, index) => {
    if (roleIds.has(role.id)) {
      ctx.addIssue({ code: "custom", path: ["roles", index, "id"], message: `Duplicate event-frame role ${role.id}` });
    }
    roleIds.add(role.id);
  });
});
export type EventFrame = z.infer<typeof eventFrameSchema>;

/** Validate a concrete occurrence against a reusable semantic frame. */
export function validateEventFrameInstance(
  instanceInput: EventFrameInstance,
  frameInput: EventFrame,
  entities: ReadonlyMap<string, Entity>,
  event?: Pick<CanonicalEvent, "participants" | "participantPresence">,
): ValidationIssue[] {
  const instance = eventFrameInstanceSchema.parse(instanceInput);
  const frame = eventFrameSchema.parse(frameInput);
  const issues: ValidationIssue[] = [];
  if (instance.frameId !== frame.id) {
    issues.push(issue("EVENT_FRAME_ID_MISMATCH", `Frame instance ${instance.frameId} does not bind frame ${frame.id}`, "frameId"));
    return issues;
  }
  const roleSpecs = new Map(frame.roles.map((role) => [role.id, role]));
  const bindings = new Map(instance.roleBindings.map((binding) => [binding.roleId, binding]));
  for (const binding of instance.roleBindings) {
    const spec = roleSpecs.get(binding.roleId);
    if (!spec) {
      issues.push(issue("UNKNOWN_EVENT_FRAME_ROLE", `Frame ${frame.id} has no role ${binding.roleId}`, "roleBindings"));
      continue;
    }
    if (binding.entityIds.length < spec.minCardinality || binding.entityIds.length > spec.maxCardinality) {
      issues.push(issue(
        "EVENT_FRAME_ROLE_CARDINALITY",
        `Role ${binding.roleId} requires ${spec.minCardinality}..${spec.maxCardinality} entities, received ${binding.entityIds.length}`,
        "roleBindings",
      ));
    }
    for (const entityId of binding.entityIds) {
      const entity = entities.get(entityId);
      if (!entity) {
        issues.push(issue("UNKNOWN_EVENT_FRAME_ENTITY", `Frame role ${binding.roleId} references unknown entity ${entityId}`, "roleBindings"));
      } else if (!spec.allowedEntityKinds.includes(entity.kind)) {
        issues.push(issue(
          "EVENT_FRAME_ROLE_KIND",
          `Frame role ${binding.roleId} does not allow ${entity.kind} entity ${entityId}`,
          "roleBindings",
        ));
      }
      if (event && !event.participants.includes(entityId)) {
        issues.push(issue("EVENT_FRAME_ENTITY_NOT_PARTICIPANT", `Frame-bound entity ${entityId} is not an event participant`, "roleBindings"));
      }
      if (event && spec.presence && spec.presence !== "any" && entity?.kind === "character") {
        const actualPresence = event.participantPresence?.find((presence) => presence.entityId === entityId)?.mode;
        if (actualPresence !== spec.presence) {
          issues.push(issue(
            "EVENT_FRAME_ROLE_PRESENCE",
            `Frame role ${binding.roleId} requires ${spec.presence} presence for ${entityId}`,
            "roleBindings",
          ));
        }
      }
    }
  }
  for (const spec of frame.roles) {
    const count = bindings.get(spec.id)?.entityIds.length ?? 0;
    if (count < spec.minCardinality) {
      issues.push(issue(
        "MISSING_EVENT_FRAME_ROLE",
        `Frame ${frame.id} role ${spec.id} requires at least ${spec.minCardinality} binding(s)` ,
        "roleBindings",
      ));
    }
  }
  return issues;
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return path ? { code, message, path } : { code, message };
}

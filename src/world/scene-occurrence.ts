import { z } from "zod";
import {
  evidenceRefSchema,
  idSchema,
  predicateSchema,
  storyTimeSchema,
  type CanonicalEvent,
  type Entity,
  type Predicate,
  type ValidationIssue,
} from "./model.js";

export const SCENE_OCCURRENCE_ONTOLOGY_VERSION = "scene-occurrence-v1" as const;

export const sceneOccurrenceSchema = z.object({
  ontologyVersion: z.literal(SCENE_OCCURRENCE_ONTOLOGY_VERSION),
  id: idSchema,
  discourseSegmentIds: z.array(idSchema).min(1).max(128),
  eventIds: z.array(idSchema).max(256),
  locationId: idSchema.optional(),
  storyInterval: z.object({
    start: storyTimeSchema,
    end: storyTimeSchema.optional(),
  }).strict().optional(),
  viewpointActorIds: z.array(idSchema).max(16),
  presentActorIds: z.array(idSchema).max(128),
  entryConditions: z.array(predicateSchema).max(64),
  exitConditions: z.array(predicateSchema).max(64),
  evidence: z.array(evidenceRefSchema).min(1),
}).strict().superRefine((value, ctx) => {
  for (const field of ["discourseSegmentIds", "eventIds", "viewpointActorIds", "presentActorIds"] as const) {
    if (new Set(value[field]).size !== value[field].length) {
      ctx.addIssue({ code: "custom", path: [field], message: `${field} must contain unique IDs` });
    }
  }
});
export type SceneOccurrence = z.infer<typeof sceneOccurrenceSchema>;

export type SceneOccurrenceCatalog = {
  entities: ReadonlyMap<string, Entity>;
  events: ReadonlyMap<string, CanonicalEvent>;
  scenes: Iterable<SceneOccurrence>;
};

/** Bidirectional scene/event closure plus kind and presence checks. */
export function validateSceneOccurrenceCatalog(catalog: SceneOccurrenceCatalog): ValidationIssue[] {
  const scenes = [...catalog.scenes];
  const sceneMap = new Map(scenes.map((scene) => [scene.id, scene]));
  const issues: ValidationIssue[] = [];
  if (sceneMap.size !== scenes.length) {
    issues.push(issue("DUPLICATE_SCENE_OCCURRENCE", "Scene occurrence IDs must be unique", "scenes"));
  }
  for (const [sceneIndex, scene] of scenes.entries()) {
    const prefix = `scenes.${sceneIndex}`;
    if (scene.locationId && catalog.entities.get(scene.locationId)?.kind !== "location") {
      issues.push(issue("INVALID_SCENE_LOCATION", `Scene ${scene.id} location ${scene.locationId} is not a canonical location`, `${prefix}.locationId`));
    }
    for (const [field, actorIds] of [
      ["viewpointActorIds", scene.viewpointActorIds],
      ["presentActorIds", scene.presentActorIds],
    ] as const) {
      actorIds.forEach((actorId, index) => {
        if (catalog.entities.get(actorId)?.kind !== "character") {
          issues.push(issue("INVALID_SCENE_ACTOR", `Scene ${scene.id} ${field} references non-character ${actorId}`, `${prefix}.${field}.${index}`));
        }
      });
    }
    [...scene.entryConditions, ...scene.exitConditions].forEach((predicate, index) => {
      for (const entityId of predicateEntityIds(predicate)) {
        if (!catalog.entities.has(entityId)) {
          issues.push(issue("UNKNOWN_SCENE_PREDICATE_ENTITY", `Scene ${scene.id} predicate references unknown entity ${entityId}`, `${prefix}.conditions.${index}`));
        }
      }
    });
    scene.eventIds.forEach((eventId, index) => {
      const event = catalog.events.get(eventId);
      if (!event) {
        issues.push(issue("UNKNOWN_SCENE_EVENT", `Scene ${scene.id} references unknown event ${eventId}`, `${prefix}.eventIds.${index}`));
        return;
      }
      if (!event.sceneOccurrenceIds?.includes(scene.id)) {
        issues.push(issue("SCENE_EVENT_BACKLINK_REQUIRED", `Event ${eventId} must link back to scene ${scene.id}`, `${prefix}.eventIds.${index}`));
      }
      for (const presence of event.participantPresence ?? []) {
        if (presence.mode === "physical" && !scene.presentActorIds.includes(presence.entityId)) {
          issues.push(issue(
            "SCENE_PHYSICAL_PRESENCE_MISSING",
            `Event ${eventId} physically includes ${presence.entityId}, but scene ${scene.id} does not`,
            `${prefix}.presentActorIds`,
          ));
        }
      }
    });
  }
  for (const event of catalog.events.values()) {
    event.sceneOccurrenceIds?.forEach((sceneId, index) => {
      const scene = sceneMap.get(sceneId);
      if (!scene) {
        issues.push(issue("UNKNOWN_EVENT_SCENE", `Event ${event.id} references unknown scene ${sceneId}`, `events.${event.id}.sceneOccurrenceIds.${index}`));
      } else if (!scene.eventIds.includes(event.id)) {
        issues.push(issue("EVENT_SCENE_BACKLINK_REQUIRED", `Scene ${sceneId} must link back to event ${event.id}`, `events.${event.id}.sceneOccurrenceIds.${index}`));
      }
    });
  }
  return issues;
}

function predicateEntityIds(predicate: Predicate): string[] {
  if (predicate.op === "all" || predicate.op === "any") return predicate.items.flatMap(predicateEntityIds);
  if (predicate.op === "not") return predicateEntityIds(predicate.item);
  if ("entityId" in predicate) return [predicate.entityId, ...(predicate.op === "entity-in" ? [predicate.member] : [])];
  return [];
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  return path ? { code, message, path } : { code, message };
}

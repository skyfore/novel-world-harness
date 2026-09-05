import { predicateStateAddresses } from "./action-ontology.js";
import { actionInvocationSchema, type ActionInvocation, type ActionStateAddress, type EventProposal, type Predicate, type StateDelta, type StateValue } from "./model.js";

/** Host-derived footprint is inspectable bookkeeping, never an effect permission. */
export function deriveAdHocAction(input: {
  kind: string;
  description: string;
  delta: StateDelta;
  preconditions: readonly Predicate[];
  travelMode?: ActionInvocation["travelMode"];
}): ActionInvocation {
  const unique = (addresses: ActionStateAddress[]) => [...new Map(addresses.map((address) =>
    [`${address.entityId}\u0000${address.field}`, address])).values()]
    .sort((a, b) => a.entityId.localeCompare(b.entityId) || a.field.localeCompare(b.field));
  return actionInvocationSchema.parse({
    lane: "ad-hoc", actionKindId: input.kind, description: input.description.slice(0, 1_000),
    footprint: {
      reads: unique(input.preconditions.flatMap(predicateStateAddresses)),
      writes: unique(input.delta.operations.flatMap((operation) => "entityId" in operation && "field" in operation
        ? [{ entityId: operation.entityId, field: operation.field }] : [])),
      resources: [],
    },
    ...(input.travelMode ? { travelMode: input.travelMode } : {}),
  });
}

/** Every actor event participates in action constraints, including host adapters. */
export function normalizeActorProposal(proposal: EventProposal): EventProposal {
  if (!proposal.actorId || proposal.action) return proposal;
  return { ...proposal, action: deriveAdHocAction({
    kind: proposal.spokenUtterances?.length ? "speak" : "act",
    description: proposal.title, delta: proposal.proposedDelta, preconditions: proposal.preconditions,
  }) };
}

export function mapActionInvocationEntities(action: ActionInvocation, map: (id: string) => string, parameters: readonly { id: string; valueType: string }[] = []): ActionInvocation {
  const value = (input: StateValue): StateValue => {
    if (typeof input === "string") return map(input);
    if (Array.isArray(input)) return input.map((item) => typeof item === "string" ? map(item) : item) as StateValue;
    return input;
  };
  if (action.lane === "schema-bound") return {
    ...action,
    roleBindings: action.roleBindings.map((binding) => ({ ...binding, entityIds: binding.entityIds.map(map) })),
    parameters: Object.fromEntries(Object.entries(action.parameters).map(([key, item]) => [key,
      ["entity-ref", "entity-ref-set"].includes(parameters.find((spec) => spec.id === key)?.valueType ?? "") ? value(item) : item])),
  };
  return { ...action, footprint: {
    reads: action.footprint.reads.map((address) => ({ ...address, entityId: map(address.entityId) })),
    writes: action.footprint.writes.map((address) => ({ ...address, entityId: map(address.entityId) })),
    resources: action.footprint.resources.map((address) => ({ ...address, entityId: map(address.entityId) })),
  } };
}

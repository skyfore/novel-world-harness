/** Opening truth, never whole-novel popularity, determines the first repair actor. */
export function selectOpeningDriverActor(
  physicalActorIds: Iterable<string>, focalActorId: string | undefined,
  _participation: ReadonlyMap<string, number>,
): string | undefined {
  const physical = [...physicalActorIds].sort();
  if (focalActorId && physical.includes(focalActorId)) return focalActorId;
  return physical[0];
}

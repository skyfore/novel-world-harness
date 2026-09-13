/** Opening truth, never whole-novel popularity, determines the first repair actor. */
export function selectOpeningDriverActor(
  physicalActorIds: Iterable<string>, focalActorId: string | undefined,
  participation: ReadonlyMap<string, number>,
): string | undefined {
  const physical = [...physicalActorIds].sort();
  if (focalActorId && physical.includes(focalActorId)) return focalActorId;
  return physical[0] ?? [...participation].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

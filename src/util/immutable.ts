/**
 * Recursively freeze JSON-like boundary data before handing it to an
 * application callback. Callers that need isolation from retained references
 * should pass an already structured-cloned value or use immutableClone.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

/** Make a callback-safe snapshot that cannot mutate the host's live value. */
export function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

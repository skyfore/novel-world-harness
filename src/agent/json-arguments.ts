import type { JsonObject, JsonValue } from "@earendil-works/pi-ai";

/** Reject non-JSON inputs before Pi validation; never silently discard/coerce host data. */
export function jsonArguments(value: unknown): JsonObject {
  const ancestors = new Set<object>();
  function check(input: unknown, location: string): asserts input is JsonValue {
    if (input === null || typeof input === "string" || typeof input === "boolean") return;
    if (typeof input === "number" && Number.isFinite(input)) return;
    if (typeof input !== "object" || input === null) throw new Error(`Invalid JSON argument at ${location}.`);
    if (ancestors.has(input)) throw new Error(`Cyclic JSON argument at ${location}.`);
    if (!Array.isArray(input) && Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) {
      throw new Error(`Invalid JSON object at ${location}.`);
    }
    ancestors.add(input);
    if (Array.isArray(input)) {
      for (let index = 0; index < input.length; index++) {
        if (!Object.hasOwn(input, index)) throw new Error(`Sparse JSON array at ${location}[${index}].`);
      }
    }
    for (const key of Reflect.ownKeys(input)) {
      if (Array.isArray(input) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)
        || (Array.isArray(input) && !/^(0|[1-9]\d*)$/u.test(key))) {
        throw new Error(`Invalid JSON property at ${location}.`);
      }
      check(descriptor.value, `${location}.${key}`);
    }
    ancestors.delete(input);
  }
  check(value, "$arguments");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be one JSON object.");
  }
  return value as JsonObject;
}

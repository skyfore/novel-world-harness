const SECRET_KEY = /^(authorization|proxy[-_]?authorization|(?:x[-_]?)?api[-_]?key|(?:x[-_]?)?auth[-_]?token|access[-_]?token|refresh[-_]?token|id[-_]?token|secret|client[-_]?secret|cookie|set[-_]?cookie|password|credentials?|.*signature)$/iu;
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
  /\bsk-[A-Za-z0-9_-]{8,}/gu,
] as const;

/**
 * Redact provider credentials and hidden model reasoning before trace data
 * crosses the persistence boundary. This function intentionally accepts
 * unknown input so every event/blob producer shares the same final guard.
 */
export function redactTraceSecrets(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

export function redactTraceText(value: string): string {
  return SECRET_VALUE_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactTraceText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));
  const record = value as Record<string, unknown>;
  if (record.type === "thinking") {
    const thinking = typeof record.thinking === "string" ? record.thinking : "";
    return {
      type: "thinking",
      redacted: true,
      charCount: thinking.length,
      reasoningContentRecorded: false,
    };
  }
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [
    key,
    SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(entry, seen),
  ]));
}

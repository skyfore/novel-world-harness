/**
 * Serialize data embedded inside a prompt without allowing data strings to
 * manufacture the XML-like delimiters used to separate harness instructions.
 * The result remains valid JSON; consumers decode \u003c/\u003e normally.
 */
export function promptJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Prompt data must be JSON-serializable.");
  return serialized
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}


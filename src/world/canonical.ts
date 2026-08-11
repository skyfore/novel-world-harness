import crypto from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const nested = record[key];
    if (nested !== undefined) sorted[key] = canonicalize(nested);
  }
  return sorted;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function contentHash(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function assertContentHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid SHA-256 object hash: ${hash}`);
}


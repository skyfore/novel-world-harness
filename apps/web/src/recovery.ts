import { apiErrorSchema, type ApiError } from "../../../src/web/contracts";

export function webErrorDetail(error: Error): ApiError | undefined {
  const parsed = apiErrorSchema.safeParse((error as Error & { detail?: unknown }).detail);
  return parsed.success ? parsed.data : undefined;
}

export function canRetrySameRequest(error: Error): boolean {
  const detail = webErrorDetail(error);
  return !detail || detail.retry.kind === "same-request";
}

/** Turn the machine-readable recovery contract into one bounded UI sentence. */
export function recoveryInstruction(error: ApiError): string {
  const retry = error.retry;
  if (retry.kind === "none") return "Do not retry this request unchanged.";
  if (retry.kind === "same-request") return retry.maxAttempts === undefined || retry.maxAttempts === 1
    ? "Retry the same request at most once."
    : `Retry the same request at most ${retry.maxAttempts} times.`;
  if (retry.kind === "after-refresh") {
    const discovery = retry.discoveryEndpoint ? `Refresh ${retry.discoveryEndpoint}` : "Refresh the authoritative snapshot";
    const copy = retry.copyField ? ` and copy ${retry.copyField}` : "";
    return `${discovery}${copy}; then make at most one corrected attempt.`;
  }
  const discovery = retry.discoveryEndpoint ? `Use ${retry.discoveryEndpoint}` : "Complete the requested user action";
  const copy = retry.copyField ? ` and copy ${retry.copyField}` : "";
  return `${discovery}${copy}; then issue one new request.`;
}

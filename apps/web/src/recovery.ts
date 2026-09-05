import { apiErrorSchema, type ApiError } from "../../../src/web/contracts";

type Translator = (message: string, values?: Record<string, string | number>) => string;
const identity: Translator = (message, values) => values
  ? message.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, key: string) => String(values[key] ?? match))
  : message;

export function webErrorDetail(error: Error): ApiError | undefined {
  const parsed = apiErrorSchema.safeParse((error as Error & { detail?: unknown }).detail);
  return parsed.success ? parsed.data : undefined;
}

export function canRetrySameRequest(error: Error): boolean {
  const detail = webErrorDetail(error);
  return !detail || detail.retry.kind === "same-request";
}

/** Turn the machine-readable recovery contract into one bounded UI sentence. */
export function recoveryInstruction(error: ApiError, t: Translator = identity): string {
  const retry = error.retry;
  if (retry.kind === "none") return t("Do not retry this request unchanged.");
  if (retry.kind === "same-request") return retry.maxAttempts === undefined || retry.maxAttempts === 1
    ? t("Retry the same request at most once.")
    : t("Retry the same request at most {count} times.", { count: retry.maxAttempts });
  if (retry.kind === "after-refresh") {
    if (retry.discoveryEndpoint) return retry.copyField
      ? t("Refresh {endpoint} and copy {field}; then make at most one corrected attempt.", { endpoint: retry.discoveryEndpoint, field: retry.copyField })
      : t("Refresh {endpoint}; then make at most one corrected attempt.", { endpoint: retry.discoveryEndpoint });
    return retry.copyField
      ? t("Refresh the authoritative snapshot and copy {field}; then make at most one corrected attempt.", { field: retry.copyField })
      : t("Refresh the authoritative snapshot; then make at most one corrected attempt.");
  }
  if (retry.discoveryEndpoint) return retry.copyField
    ? t("Use {endpoint} and copy {field}; then issue one new request.", { endpoint: retry.discoveryEndpoint, field: retry.copyField })
    : t("Use {endpoint}; then issue one new request.", { endpoint: retry.discoveryEndpoint });
  return retry.copyField
    ? t("Complete the requested user action and copy {field}; then issue one new request.", { field: retry.copyField })
    : t("Complete the requested user action; then issue one new request.");
}

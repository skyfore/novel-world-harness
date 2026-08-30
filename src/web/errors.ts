import { apiErrorSchema, type ApiError } from "./contracts.js";

export class WebApplicationError extends Error {
  readonly detail: ApiError;

  constructor(readonly statusCode: number, detail: ApiError, options?: ErrorOptions) {
    super(detail.message, options);
    this.name = "WebApplicationError";
    this.detail = apiErrorSchema.parse(detail);
  }
}

export function webError(
  statusCode: number,
  code: string,
  message: string,
  retry: ApiError["retry"] = { kind: "none" },
  details?: unknown,
): WebApplicationError {
  return new WebApplicationError(statusCode, apiErrorSchema.parse({
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    retry,
  }));
}

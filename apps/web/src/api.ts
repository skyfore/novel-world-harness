import {
  apiErrorSchema,
  bootstrapResponseSchema,
  type ApiError,
  type BootstrapResponse,
} from "../../../src/web/contracts";

export async function fetchBootstrap(signal?: AbortSignal): Promise<BootstrapResponse> {
  const response = await fetch("/api/v1/bootstrap", {
    headers: { Accept: "application/json" },
    signal,
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new WebApiError(apiErrorSchema.parse(body));
  return bootstrapResponseSchema.parse(body);
}

export class WebApiError extends Error {
  constructor(readonly detail: ApiError) {
    super(detail.message);
    this.name = "WebApiError";
  }
}

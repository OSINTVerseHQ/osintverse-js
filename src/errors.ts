/** Machine-readable error object the API returns alongside `detail`. */
export type ApiErrorInfo = {
  code: string
  message: string
  hint?: string
  docs_url?: string
}

export class OSINTverseError extends Error {
  override name = "OSINTverseError"
}

/** HTTP error from the API. Branch on `code` (for example `insufficient_balance`, `not_found`). */
export class APIError extends OSINTverseError {
  override name = "APIError"
  readonly status: number
  readonly code: string
  readonly hint: string | undefined
  readonly body: unknown

  constructor(status: number, info: ApiErrorInfo, body: unknown) {
    super(info.message)
    this.status = status
    this.code = info.code
    this.hint = info.hint
    this.body = body
  }
}

/** A search finished as `failed` or `refunded` while waiting. */
export class SearchNotCompletedError extends OSINTverseError {
  override name = "SearchNotCompletedError"
  readonly search: { id: string; status: string; error?: string | null }

  constructor(search: { id: string; status: string; error?: string | null }) {
    super(`Search ${search.id} ended as ${search.status}${search.error ? `: ${search.error}` : ""}`)
    this.search = search
  }
}

export class WaitTimeoutError extends OSINTverseError {
  override name = "WaitTimeoutError"
}

const CODE_BY_STATUS: Record<number, string> = {
  400: "bad_request",
  401: "unauthorized",
  402: "insufficient_balance",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "invalid_request",
  429: "rate_limited",
  502: "upstream_error",
  503: "unavailable",
}

/** Read `error` (current API) or fall back to `detail` (older responses). */
export function toApiError(status: number, body: unknown): APIError {
  const record = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const error = record.error as Partial<ApiErrorInfo> | undefined
  const detail = typeof record.detail === "string" ? record.detail : undefined
  return new APIError(
    status,
    {
      code: error?.code ?? CODE_BY_STATUS[status] ?? (status >= 500 ? "server_error" : "client_error"),
      message: error?.message ?? detail ?? `HTTP ${status}`,
      hint: error?.hint,
      docs_url: error?.docs_url,
    },
    body,
  )
}

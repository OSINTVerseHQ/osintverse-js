import { APIError, OSINTverseError, SearchNotCompletedError, toApiError, WaitTimeoutError } from "./errors.js"
import { TERMINAL_STATUSES, type BulkSearch, type InputType, type Provider, type Quote, type Search } from "./types.js"

export const DEFAULT_BASE_URL = "https://apiv1.osintverse.com"
export const VERSION = "0.3.0"
const API_KEY_ENV = "OSINTVERSE_API_KEY"

export type ClientOptions = {
  /** `ov_...` key. Defaults to the OSINTVERSE_API_KEY environment variable. */
  apiKey?: string
  baseUrl?: string
  /** Per-request timeout. Default 60 s. */
  timeoutMs?: number
  /** Retries for network errors and 502/503. Default 2. Paid creates are retried with the same Idempotency-Key. */
  maxRetries?: number
  fetch?: typeof fetch
  userAgent?: string
}

export type WaitOptions = {
  /** Default 2 s, the interval the API asks for. */
  pollIntervalMs?: number
  /** Default 120 s. */
  timeoutMs?: number
  /** Throw SearchNotCompletedError on `failed` / `refunded`. Default true. */
  throwOnFailure?: boolean
}

type RequestOptions = { body?: unknown; headers?: Record<string, string>; auth?: boolean; retry?: boolean }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function newIdempotencyKey() {
  return globalThis.crypto?.randomUUID?.() ?? `ov-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export class OSINTverse {
  readonly providers: ProvidersResource
  readonly search: SearchResource
  private readonly apiKey: string | undefined
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly fetchImpl: typeof fetch
  private readonly userAgent: string

  constructor(options: ClientOptions = {}) {
    this.apiKey = options.apiKey ?? (typeof process !== "undefined" ? process.env?.[API_KEY_ENV] : undefined)
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
    this.timeoutMs = options.timeoutMs ?? 60_000
    this.maxRetries = options.maxRetries ?? 2
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.userAgent = options.userAgent ?? `osintverse-js/${VERSION}`
    this.providers = new ProvidersResource(this)
    this.search = new SearchResource(this)
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request("GET", "/health", { auth: false })
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const auth = options.auth ?? true
    if (auth && !this.apiKey) {
      throw new OSINTverseError(
        `No API key. Set ${API_KEY_ENV} or pass apiKey. Create one at https://osintverse.com/dashboard/api.`,
      )
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": this.userAgent,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(auth && this.apiKey ? { "x-api-key": this.apiKey } : {}),
      ...options.headers,
    }
    const retries = options.retry === false ? 0 : this.maxRetries

    for (let attempt = 0; ; attempt++) {
      let response: Response
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        })
      } catch (error) {
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt)
          continue
        }
        throw new OSINTverseError(`Request to ${path} failed: ${(error as Error).message}`)
      }

      const text = await response.text()
      const body = text ? safeJson(text) : null
      if (response.ok) return body as T
      if ((response.status === 502 || response.status === 503) && attempt < retries) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      throw toApiError(response.status, body)
    }
  }
}

function safeJson(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    return { detail: text }
  }
}

class ProvidersResource {
  constructor(private readonly client: OSINTverse) {}

  /** Live catalog with input types and prices. No API key needed. */
  list(): Promise<Provider[]> {
    return this.client.request("GET", "/v1/providers", { auth: false })
  }
}

export type CreateSearchParams = {
  provider: string
  inputType: InputType | string
  query: string
  premium?: boolean
  /** Sent as Idempotency-Key. Generated when omitted, so SDK retries never charge twice. */
  idempotencyKey?: string
  /** https URL that gets a signed POST when the search settles. Verify with verifyWebhook. */
  callbackUrl?: string
  /** Poll until terminal before returning. */
  wait?: boolean | WaitOptions
}

export type BulkSearchParams = {
  inputType: InputType | string
  queries: string[]
  providers: string[]
  premium?: boolean
  /** One signed POST per job when it settles. */
  callbackUrl?: string
  wait?: boolean | WaitOptions
}

class SearchResource {
  constructor(private readonly client: OSINTverse) {}

  /** Secret for verifying callbackUrl events (one per wallet). Never charges. */
  async webhookSecret(): Promise<string> {
    const payload = await this.client.request<{ secret: string }>("GET", "/v1/webhooks/secret")
    return payload.secret
  }

  /** Price lookups and check the wallet. Never charges. */
  quote(params: { provider: string; inputType: InputType | string; premium?: boolean; count?: number }): Promise<Quote> {
    return this.client.request("POST", "/v1/search/quote", {
      body: {
        provider: params.provider,
        input_type: params.inputType,
        premium: params.premium ?? false,
        count: params.count ?? 1,
      },
    })
  }

  /** Paid. Charges the wallet the key bills when the search is accepted. */
  async create(params: CreateSearchParams): Promise<Search> {
    const search = await this.client.request<Search>("POST", "/v1/search", {
      body: {
        provider: params.provider,
        input_type: params.inputType,
        query: params.query,
        ...(params.premium ? { premium: true } : {}),
        ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
      },
      headers: { "Idempotency-Key": params.idempotencyKey ?? newIdempotencyKey() },
    })
    return params.wait ? this.wait(search, params.wait === true ? {} : params.wait) : search
  }

  /** Paid. Every queries × providers pair is one charged job (max 50 queries, 100 jobs). Not retried. */
  async bulk(params: BulkSearchParams): Promise<BulkSearch> {
    const batch = await this.client.request<BulkSearch>("POST", "/v1/search/bulk", {
      body: {
        input_type: params.inputType,
        queries: params.queries,
        providers: params.providers,
        ...(params.premium ? { premium: true } : {}),
        ...(params.callbackUrl ? { callback_url: params.callbackUrl } : {}),
      },
      retry: false,
    })
    if (!params.wait) return batch
    const options = { ...(params.wait === true ? {} : params.wait), throwOnFailure: false }
    const searches = await Promise.all(batch.searches.map((search) => this.wait(search, options)))
    return { ...batch, searches }
  }

  get(searchId: string): Promise<Search> {
    return this.client.request("GET", `/v1/search/${encodeURIComponent(searchId)}`)
  }

  /** Stop a running OSINT Industries search. Keeps the charge and any modules already returned. */
  cancel(searchId: string): Promise<Search> {
    return this.client.request("POST", `/v1/search/${encodeURIComponent(searchId)}/cancel`, { retry: false })
  }

  /** Paid. LeakRadar only: unlock remaining rows at $0.50 per 1,000. */
  unlock(searchId: string): Promise<Search> {
    return this.client.request("POST", `/v1/search/${encodeURIComponent(searchId)}/unlock`, {
      body: { unlock_remaining: true },
      retry: false,
    })
  }

  /** Paid. OSINT Industries only: run premium modules on a completed search. Charged once. */
  premium(searchId: string): Promise<Search> {
    return this.client.request("POST", `/v1/search/${encodeURIComponent(searchId)}/premium`, {
      body: { premium: true },
    })
  }

  /** Poll until `completed`, `failed`, or `refunded`. */
  async wait(searchOrId: Search | string, options: WaitOptions = {}): Promise<Search> {
    const interval = options.pollIntervalMs ?? 2_000
    const deadline = Date.now() + (options.timeoutMs ?? 120_000)
    let search = typeof searchOrId === "string" ? await this.get(searchOrId) : searchOrId
    while (!TERMINAL_STATUSES.has(search.status)) {
      if (Date.now() >= deadline) {
        throw new WaitTimeoutError(`Search ${search.id} is still ${search.status}. Poll it later with get().`)
      }
      await sleep(interval)
      search = await this.get(search.id)
    }
    if ((options.throwOnFailure ?? true) && search.status !== "completed") throw new SearchNotCompletedError(search)
    return search
  }
}

export { APIError }

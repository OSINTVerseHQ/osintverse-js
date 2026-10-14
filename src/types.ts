/** Wire shapes of the OSINTverse REST API (https://osintverse.com/openapi.json). Fields stay snake_case. */

export type InputType = "email" | "username" | "phone" | "domain" | "name" | "image" | "ip" | "crypto"

export type SearchStatus = "pending" | "running" | "completed" | "failed" | "refunded"

export type Provider = {
  id: string
  name: string
  category: string
  input_types: Array<{ id: string; price_usd?: string; [key: string]: unknown }>
  [key: string]: unknown
}

export type Search = {
  id: string
  status: SearchStatus
  provider: string
  input_type: string
  query: string
  cost_usd: string
  balance_after?: string | null
  error?: string | null
  poll_url?: string | null
  batch_id?: string | null
  result?: { sources?: unknown; matches?: unknown[]; [key: string]: unknown } | null
  [key: string]: unknown
}

export type BulkSearch = {
  batch_id: string
  searches: Search[]
  summary: Record<string, unknown>
  [key: string]: unknown
}

export type Quote = {
  provider: string
  input_type: string
  count: number
  premium: boolean
  available: boolean
  unit_cost_usd: string
  total_cost_usd: string
  balance_usd: string
  sufficient_balance: boolean
  shortfall_usd: string
  top_up_url: string
}

export const TERMINAL_STATUSES: ReadonlySet<SearchStatus> = new Set(["completed", "failed", "refunded"])

import { OSINTverseError } from "./errors.js"

/** The event is unsigned, signed with another secret, tampered with, or too old. */
export class WebhookVerificationError extends OSINTverseError {}

export type WebhookEvent = {
  type: "search.completed" | "search.failed" | "search.refunded"
  timestamp: number
  data: {
    id: string
    batch_id: string | null
    status: "completed" | "failed" | "refunded"
    provider: string
    input_type: string
    cost_usd: string | null
    refunded: boolean
    url: string
  }
}

export type VerifyWebhookOptions = {
  /** Allowed clock skew in seconds (default 300). */
  tolerance?: number
  /** Override "now" in seconds, for tests. */
  now?: number
}

type HeaderSource = Headers | Record<string, string | string[] | undefined>

function header(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? value[0] : value
  }
  return undefined
}

async function subtle(): Promise<SubtleCrypto> {
  if (globalThis.crypto?.subtle) return globalThis.crypto.subtle
  // Node 18 keeps Web Crypto off the global object.
  const nodeCrypto = await import("node:crypto")
  return nodeCrypto.webcrypto.subtle as SubtleCrypto
}

function fromBase64(value: string): ArrayBuffer {
  const raw = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes.buffer
}

function toBase64(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

function equal(a: string, b: string) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * Checks a `callback_url` event (Standard Webhooks) and returns it parsed.
 * `secret` comes from `client.search.webhookSecret()`. Pass the raw body string,
 * not re-serialized JSON. Throws {@link WebhookVerificationError} when the check fails.
 */
export async function verifyWebhook(
  secret: string,
  headers: HeaderSource,
  body: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
  const id = header(headers, "webhook-id")
  const timestamp = header(headers, "webhook-timestamp")
  const signatures = header(headers, "webhook-signature")
  if (!id || !timestamp || !signatures) {
    throw new WebhookVerificationError("Missing webhook-id, -timestamp, or -signature header.")
  }
  const sentAt = Number(timestamp)
  const now = options.now ?? Date.now() / 1000
  if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > (options.tolerance ?? 300)) {
    throw new WebhookVerificationError("Webhook timestamp is outside the allowed window.")
  }

  let keyBytes: ArrayBuffer
  try {
    keyBytes = fromBase64(secret.replace(/^whsec_/, ""))
  } catch {
    throw new WebhookVerificationError("Secret is not a whsec_ value.")
  }
  const crypto = await subtle()
  const key = await crypto.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const digest = await crypto.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
  const expected = toBase64(digest)

  for (const part of signatures.split(" ")) {
    const [version, value] = part.split(",", 2)
    if (version === "v1" && value && equal(value, expected)) return JSON.parse(body) as WebhookEvent
  }
  throw new WebhookVerificationError("No matching signature.")
}

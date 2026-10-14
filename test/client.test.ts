import { describe, expect, mock, test } from "bun:test"

import { EXIT, parseArgs, run } from "../src/cli"
import { APIError, OSINTverse } from "../src/index"

type Call = { url: string; init: RequestInit }

function fakeFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Call[] = []
  const impl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error("unexpected request")
    if (next instanceof Error) throw next
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 })
  }
  return { calls, fetch: impl as unknown as typeof fetch }
}

const quote = (overrides: Record<string, unknown> = {}) => ({
  provider: "leakradar",
  input_type: "email",
  count: 1,
  premium: false,
  available: true,
  unit_cost_usd: "1.00",
  total_cost_usd: "1.00",
  balance_usd: "10.00",
  sufficient_balance: true,
  shortfall_usd: "0.00",
  top_up_url: "https://osintverse.com/dashboard/billing",
  ...overrides,
})

const search = (status = "completed") => ({
  id: "s1",
  status,
  provider: "leakradar",
  input_type: "email",
  query: "user@example.com",
  cost_usd: "1.00",
  result: { matches: [{ a: 1 }] },
})

describe("client", () => {
  test("create sends the key, snake_case body, and an Idempotency-Key", async () => {
    const { calls, fetch } = fakeFetch([{ body: search() }])
    const client = new OSINTverse({ apiKey: "ov_test", fetch })
    await client.search.create({ provider: "leakradar", inputType: "email", query: "user@example.com" })
    const headers = calls[0].init.headers as Record<string, string>
    expect(calls[0].url).toBe("https://apiv1.osintverse.com/v1/search")
    expect(headers["x-api-key"]).toBe("ov_test")
    expect(headers["Idempotency-Key"]).toBeTruthy()
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      provider: "leakradar",
      input_type: "email",
      query: "user@example.com",
    })
  })

  test("a retried create reuses the same Idempotency-Key", async () => {
    const { calls, fetch } = fakeFetch([{ status: 502, body: { detail: "upstream" } }, { body: search() }])
    const client = new OSINTverse({ apiKey: "ov_test", fetch })
    await client.search.create({ provider: "leakradar", inputType: "email", query: "user@example.com" })
    const keys = calls.map((call) => (call.init.headers as Record<string, string>)["Idempotency-Key"])
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  test("bulk is never retried", async () => {
    const { calls, fetch } = fakeFetch([{ status: 502, body: { detail: "upstream" } }])
    const client = new OSINTverse({ apiKey: "ov_test", fetch })
    await expect(
      client.search.bulk({ inputType: "email", queries: ["a@b.co"], providers: ["leakradar"] }),
    ).rejects.toBeInstanceOf(APIError)
    expect(calls).toHaveLength(1)
  })

  test("errors carry the API code, falling back to the status", async () => {
    const { fetch } = fakeFetch([
      { status: 404, body: { detail: "Search not found", error: { code: "not_found", message: "Search not found", hint: "Check the id." } } },
      { status: 401, body: { detail: "Invalid API key" } },
    ])
    const client = new OSINTverse({ apiKey: "ov_test", fetch })
    const notFound = await client.search.get("x").catch((error) => error)
    expect(notFound.code).toBe("not_found")
    expect(notFound.hint).toBe("Check the id.")
    const unauthorized = await client.search.get("y").catch((error) => error)
    expect(unauthorized.code).toBe("unauthorized")
    expect(unauthorized.message).toBe("Invalid API key")
  })

  test("wait polls until terminal", async () => {
    const { fetch } = fakeFetch([{ body: search("running") }, { body: search("completed") }])
    const client = new OSINTverse({ apiKey: "ov_test", fetch })
    const done = await client.search.wait("s1", { pollIntervalMs: 1 })
    expect(done.status).toBe("completed")
  })

  test("providers need no key", async () => {
    const { calls, fetch } = fakeFetch([{ body: [] }])
    await new OSINTverse({ apiKey: undefined, fetch }).providers.list()
    expect((calls[0].init.headers as Record<string, string>)["x-api-key"]).toBeUndefined()
  })
})

describe("cli", () => {
  function capture() {
    const out: string[] = []
    const write = mock((chunk: string) => {
      out.push(chunk)
      return true
    })
    const original = process.stdout.write
    process.stdout.write = write as unknown as typeof process.stdout.write
    return {
      text: () => out.join(""),
      restore: () => {
        process.stdout.write = original
      },
    }
  }

  test("parses flags with and without =", () => {
    expect(parseArgs(["search", "leakradar", "email", "a@b.co", "--max-cost=2", "--yes", "--json"])).toEqual({
      positional: ["search", "leakradar", "email", "a@b.co"],
      flags: { "max-cost": "2", yes: true, json: true },
    })
  })

  test("paid search without --yes quotes and exits 3 without charging", async () => {
    const { calls, fetch } = fakeFetch([{ body: quote() }])
    const io = capture()
    const code = await run(["search", "leakradar", "email", "user@example.com", "--json"], {
      client: new OSINTverse({ apiKey: "ov_test", fetch }),
    })
    io.restore()
    expect(code).toBe(EXIT.needsConfirmation)
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/search/quote"])
    expect(JSON.parse(io.text()).status).toBe("needs_confirmation")
  })

  test("--max-cost below the quote refuses", async () => {
    const { calls, fetch } = fakeFetch([{ body: quote({ total_cost_usd: "3.00" }) }])
    const io = capture()
    const code = await run(["search", "leakradar", "email", "user@example.com", "--max-cost", "2", "--yes", "--json"], {
      client: new OSINTverse({ apiKey: "ov_test", fetch }),
    })
    io.restore()
    expect(code).toBe(EXIT.needsConfirmation)
    expect(calls).toHaveLength(1)
  })

  test("insufficient balance exits 4 with the top-up link", async () => {
    const { fetch } = fakeFetch([{ body: quote({ sufficient_balance: false, balance_usd: "0.00", shortfall_usd: "1.00" }) }])
    const io = capture()
    const code = await run(["search", "leakradar", "email", "user@example.com", "--yes", "--json"], {
      client: new OSINTverse({ apiKey: "ov_test", fetch }),
    })
    io.restore()
    expect(code).toBe(EXIT.insufficientBalance)
    expect(JSON.parse(io.text()).top_up_url).toContain("/dashboard/billing")
  })

  test("--yes runs the search", async () => {
    const { calls, fetch } = fakeFetch([{ body: quote() }, { body: search() }])
    const io = capture()
    const code = await run(["search", "leakradar", "email", "user@example.com", "--yes", "--json"], {
      client: new OSINTverse({ apiKey: "ov_test", fetch }),
    })
    io.restore()
    expect(code).toBe(EXIT.ok)
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/search/quote", "/v1/search"])
    expect(JSON.parse(io.text()).id).toBe("s1")
  })

  test("bulk quotes every provider for the number of queries", async () => {
    const { calls, fetch } = fakeFetch([{ body: quote({ count: 2, total_cost_usd: "2.00" }) }, { body: quote({ provider: "dehashed", count: 2, total_cost_usd: "0.60" }) }])
    const io = capture()
    const code = await run(
      ["bulk", "--input-type", "email", "--providers", "leakradar,dehashed", "--queries", "a@b.co,c@d.co", "--json"],
      { client: new OSINTverse({ apiKey: "ov_test", fetch }) },
    )
    io.restore()
    expect(code).toBe(EXIT.needsConfirmation)
    expect(calls.map((call) => JSON.parse(String(call.init.body)).count)).toEqual([2, 2])
    expect(JSON.parse(io.text()).total_cost_usd).toBe("2.60")
  })
})

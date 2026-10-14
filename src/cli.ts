/**
 * osintverse CLI. Built for people and for agents in a shell:
 * - every command takes --json and prints one JSON document on stdout
 * - paid commands quote first and never spend without --yes (or an interactive yes)
 * - exit codes are stable (see EXIT)
 */
import { createInterface } from "node:readline/promises"

import { OSINTverse, VERSION } from "./client.js"
import { APIError, OSINTverseError, SearchNotCompletedError, WaitTimeoutError } from "./errors.js"
import type { Quote, Search } from "./types.js"

export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  needsConfirmation: 3,
  insufficientBalance: 4,
  searchNotCompleted: 5,
} as const

const HELP = `osintverse ${VERSION} - OSINT lookups from the terminal (https://osintverse.com)

Usage:
  osintverse providers [--input-type <type>]
  osintverse quote <provider> <input_type> [--premium] [--count <n>]
  osintverse search <provider> <input_type> <query> [--premium] [--max-cost <usd>] [--yes] [--no-wait]
  osintverse bulk --input-type <type> --providers <a,b> --queries <x,y> [--premium] [--max-cost <usd>] [--yes] [--no-wait]
  osintverse get <search_id> [--wait]
  osintverse cancel <search_id>
  osintverse unlock <search_id> [--yes]
  osintverse premium <search_id> [--yes]

Options:
  --json             Print JSON only (for scripts and agents)
  --yes              Confirm a paid lookup without a prompt
  --max-cost <usd>   Refuse to run if the quote is above this amount
  --api-key <key>    Overrides OSINTVERSE_API_KEY
  --base-url <url>   Overrides https://apiv1.osintverse.com

Paid commands (search, bulk, unlock, premium) spend your OSINTverse wallet. Without
--yes in a non-interactive shell they print the quote and exit 3 without charging.

Exit codes: 0 ok, 1 error, 2 usage, 3 needs confirmation, 4 insufficient balance,
5 search failed or refunded.

API key: create one at https://osintverse.com/dashboard/api and export OSINTVERSE_API_KEY.`

type Flags = Record<string, string | boolean>

export function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags: Flags = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith("--")) {
      positional.push(arg)
      continue
    }
    const [name, inline] = arg.slice(2).split("=", 2)
    const takesValue = ["input-type", "count", "max-cost", "api-key", "base-url", "providers", "queries"].includes(name)
    if (!takesValue) {
      flags[name] = true
    } else if (inline !== undefined) {
      flags[name] = inline
    } else {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value`)
      flags[name] = value
      index++
    }
  }
  return { positional, flags }
}

class UsageError extends Error {}

class Output {
  constructor(readonly json: boolean) {}

  result(value: unknown, human: () => string) {
    process.stdout.write(this.json ? `${JSON.stringify(value, null, 2)}\n` : `${human()}\n`)
  }

  note(message: string) {
    if (!this.json) process.stderr.write(`${message}\n`)
  }
}

function list(value: string | boolean | undefined, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`--${name} is required`)
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function money(value: string | number) {
  return `$${Number(value).toFixed(2)}`
}

/** Shared gate for paid commands: budget, balance, then confirmation. Returns an exit code to stop with, or null to go ahead. */
async function confirmSpend(total: number, quotes: Quote[], flags: Flags, out: Output): Promise<number | null> {
  const maxCost = flags["max-cost"] !== undefined ? Number(flags["max-cost"]) : undefined
  const summary = { total_cost_usd: total.toFixed(2), quotes }
  if (maxCost !== undefined && (Number.isNaN(maxCost) || total > maxCost)) {
    out.result({ ...summary, status: "over_budget", max_cost_usd: maxCost }, () =>
      `Quote ${money(total)} is above --max-cost ${money(maxCost ?? 0)}. Nothing was charged.`,
    )
    return EXIT.needsConfirmation
  }
  const unavailable = quotes.find((quote) => !quote.available)
  if (unavailable) {
    out.result({ ...summary, status: "provider_unavailable" }, () => `${unavailable.provider} is unavailable right now.`)
    return EXIT.error
  }
  const short = quotes.find((quote) => !quote.sufficient_balance)
  if (short) {
    out.result({ ...summary, status: "insufficient_balance", top_up_url: short.top_up_url }, () =>
      `Balance ${money(short.balance_usd)} is short of ${money(total)}. Top up at ${short.top_up_url}`,
    )
    return EXIT.insufficientBalance
  }
  if (flags.yes) return null
  if (!process.stdin.isTTY || out.json) {
    out.result({ ...summary, status: "needs_confirmation", hint: "Re-run with --yes to spend this amount." }, () =>
      `This costs ${money(total)}. Re-run with --yes to confirm. Nothing was charged.`,
    )
    return EXIT.needsConfirmation
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await rl.question(`Charge ${money(total)} to your OSINTverse wallet? [y/N] `)
  rl.close()
  if (!/^y(es)?$/i.test(answer.trim())) {
    out.note("Cancelled. Nothing was charged.")
    return EXIT.needsConfirmation
  }
  return null
}

function describeSearch(search: Search) {
  const matches = Array.isArray(search.result?.matches) ? search.result.matches.length : 0
  const lines = [
    `${search.provider} ${search.input_type} ${search.status}  id=${search.id}  cost=${money(search.cost_usd)}`,
  ]
  if (search.error) lines.push(`error: ${search.error}`)
  if (search.status === "completed") lines.push(`${matches} match${matches === 1 ? "" : "es"} (use --json for the full result)`)
  if (search.status === "running") lines.push(`still running; check with: osintverse get ${search.id} --wait`)
  return lines.join("\n")
}

export async function run(argv: string[], env: { client?: OSINTverse } = {}): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}\n`)
    return EXIT.usage
  }
  const { positional, flags } = parsed
  const out = new Output(Boolean(flags.json))
  const [command, ...args] = positional

  if (!command || flags.help || command === "help") {
    process.stdout.write(`${HELP}\n`)
    return command ? EXIT.ok : EXIT.usage
  }
  if (command === "version" || flags.version) {
    process.stdout.write(`${VERSION}\n`)
    return EXIT.ok
  }

  const client =
    env.client ??
    new OSINTverse({
      apiKey: typeof flags["api-key"] === "string" ? flags["api-key"] : undefined,
      baseUrl: typeof flags["base-url"] === "string" ? flags["base-url"] : undefined,
    })
  const waitFor = !flags["no-wait"]

  try {
    switch (command) {
      case "providers": {
        const inputType = typeof flags["input-type"] === "string" ? flags["input-type"] : undefined
        const providers = (await client.providers.list()).filter(
          (provider) => !inputType || provider.input_types.some((input) => input.id === inputType),
        )
        out.result(providers, () =>
          providers
            .map((provider) => {
              const prices = provider.input_types
                .filter((input) => !inputType || input.id === inputType)
                .map((input) => `${input.id} ${input.price_usd ? money(input.price_usd) : ""}`.trim())
              return `${provider.id.padEnd(18)} ${prices.join(", ")}`
            })
            .join("\n"),
        )
        return EXIT.ok
      }

      case "quote": {
        const [provider, inputType] = args
        if (!provider || !inputType) throw new UsageError("quote needs <provider> <input_type>")
        const count = flags.count !== undefined ? Number(flags.count) : 1
        const quote = await client.search.quote({ provider, inputType, premium: Boolean(flags.premium), count })
        out.result(quote, () =>
          [
            `${quote.count} x ${provider} ${inputType}: ${money(quote.total_cost_usd)} (balance ${money(quote.balance_usd)})`,
            quote.sufficient_balance ? "Enough balance to run." : `Short by ${money(quote.shortfall_usd)}. Top up at ${quote.top_up_url}`,
          ].join("\n"),
        )
        return EXIT.ok
      }

      case "search": {
        const [provider, inputType, ...rest] = args
        const query = rest.join(" ")
        if (!provider || !inputType || !query) throw new UsageError("search needs <provider> <input_type> <query>")
        const premium = Boolean(flags.premium)
        const quote = await client.search.quote({ provider, inputType, premium })
        const stop = await confirmSpend(Number(quote.total_cost_usd), [quote], flags, out)
        if (stop !== null) return stop
        const search = await client.search.create({
          provider,
          inputType,
          query,
          premium,
          wait: waitFor ? { throwOnFailure: false } : false,
        })
        out.result(search, () => describeSearch(search))
        return search.status === "failed" || search.status === "refunded" ? EXIT.searchNotCompleted : EXIT.ok
      }

      case "bulk": {
        const inputType = typeof flags["input-type"] === "string" ? flags["input-type"] : undefined
        if (!inputType) throw new UsageError("--input-type is required")
        const providers = list(flags.providers, "providers")
        const queries = list(flags.queries, "queries")
        const premium = Boolean(flags.premium)
        const quotes = await Promise.all(
          providers.map((provider) =>
            client.search.quote({
              provider,
              inputType,
              premium: premium && provider === "osint-industries",
              count: queries.length,
            }),
          ),
        )
        const total = quotes.reduce((sum, quote) => sum + Number(quote.total_cost_usd), 0)
        const stop = await confirmSpend(total, quotes, flags, out)
        if (stop !== null) return stop
        const batch = await client.search.bulk({ inputType, queries, providers, premium, wait: waitFor })
        out.result(batch, () => batch.searches.map(describeSearch).join("\n\n"))
        return EXIT.ok
      }

      case "get": {
        const [id] = args
        if (!id) throw new UsageError("get needs <search_id>")
        const search = flags.wait ? await client.search.wait(id, { throwOnFailure: false }) : await client.search.get(id)
        out.result(search, () => describeSearch(search))
        return EXIT.ok
      }

      case "cancel": {
        const [id] = args
        if (!id) throw new UsageError("cancel needs <search_id>")
        const search = await client.search.cancel(id)
        out.result(search, () => describeSearch(search))
        return EXIT.ok
      }

      case "unlock":
      case "premium": {
        const [id] = args
        if (!id) throw new UsageError(`${command} needs <search_id>`)
        if (!flags.yes) {
          const message =
            command === "unlock"
              ? "Unlocking remaining LeakRadar rows costs $0.50 per 1,000 rows. Re-run with --yes to confirm."
              : "OSINT Industries premium modules cost $1.80. Re-run with --yes to confirm."
          out.result({ status: "needs_confirmation", hint: message }, () => `${message} Nothing was charged.`)
          return EXIT.needsConfirmation
        }
        const search = command === "unlock" ? await client.search.unlock(id) : await client.search.premium(id)
        out.result(search, () => describeSearch(search))
        return EXIT.ok
      }

      default:
        throw new UsageError(`Unknown command: ${command}`)
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${HELP}\n`)
      return EXIT.usage
    }
    if (error instanceof APIError) {
      out.result(
        { status: "error", error: { code: error.code, message: error.message, hint: error.hint, http_status: error.status } },
        () => `Error (${error.code}): ${error.message}${error.hint ? `\n${error.hint}` : ""}`,
      )
      return error.code === "insufficient_balance" ? EXIT.insufficientBalance : EXIT.error
    }
    if (error instanceof SearchNotCompletedError) {
      out.result(error.search, () => error.message)
      return EXIT.searchNotCompleted
    }
    if (error instanceof WaitTimeoutError || error instanceof OSINTverseError) {
      out.result({ status: "error", error: { code: "client_error", message: error.message } }, () => error.message)
      return EXIT.error
    }
    throw error
  }
}

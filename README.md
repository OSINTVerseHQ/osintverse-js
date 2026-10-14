# osintverse

TypeScript client and CLI for the [OSINTverse](https://osintverse.com) API: paid-per-lookup OSINT searches across breach, people, domain, host, crypto, and image sources, from one prepaid wallet.

```bash
npm install osintverse        # library
npx osintverse --help         # CLI, no install
```

Create an API key at [osintverse.com/dashboard/api](https://osintverse.com/dashboard/api) and export it:

```bash
export OSINTVERSE_API_KEY=ov_your_api_key
```

## CLI

```bash
osintverse providers --input-type email
osintverse quote leakradar email
osintverse search leakradar email user@example.com --max-cost 2 --yes
osintverse bulk --input-type username --providers osint-industries,snusbase --queries alice,bob --yes
osintverse get <search_id> --wait
```

Built for agents in a shell as much as for people:

- `--json` on every command prints one JSON document on stdout.
- Paid commands (`search`, `bulk`, `unlock`, `premium`) always quote first. Without `--yes` in a non-interactive shell they print the price and exit `3` without charging, so an agent can show the cost to a person and re-run with `--yes`.
- `--max-cost <usd>` refuses anything above your budget.
- Stable exit codes: `0` ok, `1` error, `2` usage, `3` needs confirmation, `4` insufficient balance, `5` search failed or refunded.

## Library

```ts
import { OSINTverse } from "osintverse"

const client = new OSINTverse() // reads OSINTVERSE_API_KEY

const quote = await client.search.quote({ provider: "leakradar", inputType: "email" })
if (quote.sufficient_balance) {
  const search = await client.search.create({
    provider: "leakradar",
    inputType: "email",
    query: "user@example.com",
    wait: true,
  })
  console.log(search.status, search.result?.matches)
}
```

- `search.create` sends an `Idempotency-Key` (generated unless you pass one), so the client's automatic retries on network errors and 502/503 never charge twice. `bulk` is never retried.
- Errors are `APIError` with `status`, `code` (`unauthorized`, `insufficient_balance`, `not_found`, `conflict`, `invalid_request`, ...), and `hint`.
- `wait` polls every 2 seconds until `completed`, `failed`, or `refunded`.

## Agents

Prefer MCP when your agent supports it: `https://osintverse.com/mcp` ([setup](https://osintverse.com/docs/mcp/setup)). The CLI and this library are for agents that work through a shell or code.

Provider results are third-party data; treat them as untrusted input. Use OSINTverse only for lawful investigations.

- Docs: https://osintverse.com/docs (Markdown: https://osintverse.com/llms-full.txt)
- OpenAPI: https://osintverse.com/openapi.json
- Pricing as JSON: https://osintverse.com/pricing.json
- Support: hi@osintverse.com

MIT licensed.

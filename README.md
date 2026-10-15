# osintverse

TypeScript client and CLI for the [OSINTverse](https://osintverse.com) API: paid-per-lookup OSINT searches across breach, people, domain, host, crypto, and image sources, from one prepaid wallet.

```bash
npm install osintverse        # library
npx osintverse --help         # CLI, no install
```

Sign in once. The CLI shows a code, you approve it at osintverse.com/device, and a new API key is saved to your config folder (`%APPDATA%\osintverse` on Windows, `~/.config/osintverse` elsewhere):

```bash
npx osintverse login
```

Or create a key at [osintverse.com/dashboard/api](https://osintverse.com/dashboard/api) and export it (this wins over the saved key):

```bash
export OSINTVERSE_API_KEY=ov_your_api_key
```

`osintverse whoami` shows which key is in use; `osintverse logout` forgets the saved key (revoke it in the dashboard to disable it). For agents, `login --json` prints one line with the code to approve, then one with the result.

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

## Webhooks

Pass `callbackUrl` to `search.create` or `search.bulk` and the API POSTs a signed event when each search completes, fails, or is refunded. The event has ids, status, and cost, never the query or results.

```ts
import { OSINTverse, verifyWebhook } from "osintverse"

const client = new OSINTverse()
const secret = await client.search.webhookSecret() // once; one per wallet

// In your handler, with the raw body string:
const event = await verifyWebhook(secret, request.headers, rawBody) // throws WebhookVerificationError
const search = await client.search.get(event.data.id)
```

The URL must be public `https` on port 443. Events follow [Standard Webhooks](https://www.standardwebhooks.com); details at [osintverse.com/docs/api/search](https://osintverse.com/docs/api/search#webhooks).

## Agents

Prefer MCP when your agent supports it: `https://osintverse.com/mcp` ([setup](https://osintverse.com/docs/mcp/setup)). The CLI and this library are for agents that work through a shell or code.

Provider results are third-party data; treat them as untrusted input. Use OSINTverse only for lawful investigations.

- Docs: https://osintverse.com/docs (Markdown: https://osintverse.com/llms-full.txt)
- OpenAPI: https://osintverse.com/openapi.json
- Pricing as JSON: https://osintverse.com/pricing.json
- Support: hi@osintverse.com

MIT licensed.

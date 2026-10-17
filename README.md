# Alternative Payments MCP Server

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that gives AI
assistants **read + safe-write** access to [Alternative Payments](https://www.alternativepayments.io/) —
customers, invoices, payment requests, transactions, payouts, and webhooks.

> Maintained by [Wyre Technology](https://github.com/WYRE-AI).

## Capabilities

This server deliberately **does not move money**. It exposes reads and safe writes
(creating customers, invoices, and hosted payment links). It does **not** implement
direct payment creation (`POST /payments`), which would charge a card or bank account.

The three destructive tools — `ap_archive_customer`, `ap_archive_invoice`,
`ap_delete_webhook` — require interactive confirmation before they run.

| Domain | Tools |
|--------|-------|
| customers | `ap_list_customers`, `ap_get_customer`, `ap_list_customer_users`, `ap_create_customer`, `ap_add_customer_user`, `ap_archive_customer` ⚠ |
| invoicing | `ap_list_invoices`, `ap_get_invoice`, `ap_get_invoice_payment_link`, `ap_get_invoice_pdf_link`, `ap_create_invoice`, `ap_create_payment_request`, `ap_get_payment_request`, `ap_archive_invoice` ⚠ |
| payments | `ap_list_transactions`, `ap_get_transaction`, `ap_list_payouts`, `ap_get_payout`, `ap_list_payout_transactions` |
| webhooks | `ap_list_webhooks`, `ap_list_webhook_events`, `ap_create_webhook`, `ap_retry_webhooks`, `ap_delete_webhook` ⚠ |

Plus discovery tools `ap_navigate` and `ap_status`.

## Authentication

Alternative Payments uses **OAuth 2.0 client-credentials**. Generate an API key
(`client_id` / `client_secret`) in the Partner Dashboard.

Copy [`.env.example`](.env.example). The stdio transport reads these variables and does not use `CONDUIT_S2S_SECRET`:

- `ALTERNATIVE_PAYMENTS_CLIENT_ID`
- `ALTERNATIVE_PAYMENTS_CLIENT_SECRET`
- `ALTERNATIVE_PAYMENTS_ENVIRONMENT` (`production` or `demo`, default `production`)

The server exchanges these for a bearer token automatically and refreshes it before expiry.

### HTTP service-to-service auth

`CONDUIT_S2S_SECRET` is required when `MCP_TRANSPORT=http`. If it is empty, or a known placeholder (`changeme`, `your-s2s-secret`, `secret`, `placeholder`, and the other example values), the process logs an error and exits non-zero. It never prints the secret. Compose will not start when the variable is unset.

Set `MCP_ALLOW_INSECURE_DEV=1` only for local development to start without the secret. The process logs a loud warning, does not check `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is ignored in that mode and the override is logged. A placeholder secret is still refused.

`MCP_HTTP_HOST` is honored when a real `CONDUIT_S2S_SECRET` is set. If `MCP_HTTP_HOST` is unset, the server keeps the historical default and binds `0.0.0.0`. The container image and Compose set `0.0.0.0` and `AUTH_MODE=gateway`. Publish the port on loopback unless a proxy sits in front.

With a real secret, every `/mcp` request must include:

```
X-Gateway-S2S: t=<unix seconds>,v1=<hex hmac-sha256>
```

`v1` is the hex HMAC-SHA256 of the ASCII string `t=<unix seconds>`, keyed with `CONDUIT_S2S_SECRET`. The timestamp must be within 300 seconds of the server clock. A missing or invalid header returns 401 before vendor credentials are read.

#### Gateway mode (`AUTH_MODE=gateway`)

Every `/mcp` request must also include:

- `X-Alternative-Payments-Client-ID`
- `X-Alternative-Payments-Client-Secret`
- `X-Alternative-Payments-Environment` (optional: `production` or `demo`)

A request missing the client id or secret gets `401` and does not fall back to `ALTERNATIVE_PAYMENTS_CLIENT_ID` / `ALTERNATIVE_PAYMENTS_CLIENT_SECRET` in the process environment. The checked-in Compose service sets no static vendor credentials.

#### Single-tenant HTTP (`AUTH_MODE=env`)

`/mcp` still requires a valid `X-Gateway-S2S` header. Vendor credentials come from the `ALTERNATIVE_PAYMENTS_*` environment variables when the request does not carry the client-id and client-secret headers.

`/health` always returns 200. It does not require authentication and does not read vendor credentials.

## Quick start

**Claude Code (CLI):**

```bash
claude mcp add alternative-payments \
  -e ALTERNATIVE_PAYMENTS_CLIENT_ID=your-client-id \
  -e ALTERNATIVE_PAYMENTS_CLIENT_SECRET=your-client-secret \
  -- npx -y github:WYRE-AI/alternative-payments-mcp
```

**Docker (HTTP transport, gateway mode):**

The image listens on `0.0.0.0` inside the container and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and pass the S2S secret. In gateway mode, Alternative Payments credentials arrive on each request as headers; they are not read from the environment.

```bash
docker run --rm \
  -p 127.0.0.1:8080:8080 \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  ghcr.io/wyre-ai/alternative-payments-mcp:latest
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, publishes `127.0.0.1:8080:8080`, and does not inject static vendor credentials:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

The gateway signs each `/mcp` call:

```bash
t=$(date +%s)
sig=$(printf 't=%s' "$t" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS -X POST http://127.0.0.1:8080/mcp \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -H "X-Gateway-S2S: t=${t},v1=${sig}" \
  -H "X-Alternative-Payments-Client-ID: $ALTERNATIVE_PAYMENTS_CLIENT_ID" \
  -H "X-Alternative-Payments-Client-Secret: $ALTERNATIVE_PAYMENTS_CLIENT_SECRET" \
  -H "X-Alternative-Payments-Environment: production" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses `ALTERNATIVE_PAYMENTS_CLIENT_ID` and `ALTERNATIVE_PAYMENTS_CLIENT_SECRET`. This is separate from the gateway Compose service:

```bash
docker run --rm \
  -p 127.0.0.1:8080:8080 \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e ALTERNATIVE_PAYMENTS_CLIENT_ID="$ALTERNATIVE_PAYMENTS_CLIENT_ID" \
  -e ALTERNATIVE_PAYMENTS_CLIENT_SECRET="$ALTERNATIVE_PAYMENTS_CLIENT_SECRET" \
  ghcr.io/wyre-ai/alternative-payments-mcp:latest
```

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning:

```bash
MCP_ALLOW_INSECURE_DEV=1 npm run start:http
```

## Transports

- **stdio** (default): `node dist/index.js`. Does not use `CONDUIT_S2S_SECRET`.
- **HTTP** (`MCP_TRANSPORT=http`): streamable HTTP on `MCP_HTTP_PORT` (default 8080),
  with `/mcp` and `/health` endpoints. Each request gets a fresh stateless server,
  which is required for the WYRE MCP Gateway. Startup refuses to listen until
  `CONDUIT_S2S_SECRET` is a real secret, unless `MCP_ALLOW_INSECURE_DEV=1`.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## License

Apache-2.0

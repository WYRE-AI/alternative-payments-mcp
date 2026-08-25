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
(`client_id` / `client_secret`) in the Partner Dashboard. Set:

- `ALTERNATIVE_PAYMENTS_CLIENT_ID`
- `ALTERNATIVE_PAYMENTS_CLIENT_SECRET`
- `ALTERNATIVE_PAYMENTS_ENVIRONMENT` (`production` or `demo`, default `production`)

The server exchanges these for a bearer token automatically and refreshes it before expiry.

## Quick start

**Claude Code (CLI):**

```bash
claude mcp add alternative-payments \
  -e ALTERNATIVE_PAYMENTS_CLIENT_ID=your-client-id \
  -e ALTERNATIVE_PAYMENTS_CLIENT_SECRET=your-client-secret \
  -- npx -y github:WYRE-AI/alternative-payments-mcp
```

**Docker (HTTP transport, gateway mode):**

```bash
docker run --rm -p 8080:8080 \
  -e AUTH_MODE=env \
  -e MCP_TRANSPORT=http \
  -e ALTERNATIVE_PAYMENTS_CLIENT_ID=... \
  -e ALTERNATIVE_PAYMENTS_CLIENT_SECRET=... \
  ghcr.io/wyre-ai/alternative-payments-mcp:latest
```

## Transports

- **stdio** (default): `node dist/index.js`
- **HTTP** (`MCP_TRANSPORT=http`): streamable HTTP on `MCP_HTTP_PORT` (default 8080),
  with `/mcp` and `/health` endpoints. Each request gets a fresh stateless server,
  which is required for the WYRE MCP Gateway.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

## License

Apache-2.0

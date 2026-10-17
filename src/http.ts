import { createServer as createHttpServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { runWithCredentials } from './utils/client.js';
import { runWithServerRef } from './utils/server-ref.js';
import { logger } from './utils/logger.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';
import type { Environment } from '@wyre-technology/node-alternative-payments';

/**
 * HTTP transport fails closed (CWE-306).
 *
 * An empty CONDUIT_S2S_SECRET refuses to boot unless MCP_ALLOW_INSECURE_DEV=1,
 * and that bypass binds 127.0.0.1 only. A known placeholder secret always
 * refuses to start — it is not treated as a real signing key. When a real
 * secret is set, every /mcp request must carry a valid X-Gateway-S2S header,
 * and MCP_HTTP_HOST is honored (default 0.0.0.0 when unset). The secret value
 * is never logged.
 *
 * Gateway mode requires X-Alternative-Payments-Client-ID and
 * X-Alternative-Payments-Client-Secret on every /mcp request and does not
 * fall back to ALTERNATIVE_PAYMENTS_* in the process environment.
 * /health stays unauthenticated and does not read credentials.
 */

const LOOPBACK_HOST = '127.0.0.1';

// Public example values. A copied placeholder must not verify as a real secret.
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
]);

const MISSING_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. ' +
  'An empty secret would accept unauthenticated /mcp requests (CWE-306). ' +
  'Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), ' +
  'or set MCP_ALLOW_INSECURE_DEV=1 for local development only.';

const PLACEHOLDER_S2S_SECRET_ERROR =
  'Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. ' +
  'Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value. ' +
  'MCP_ALLOW_INSECURE_DEV=1 does not accept a placeholder.';

const INSECURE_DEV_WARNING =
  'SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. ' +
  'HTTP /mcp is starting WITHOUT service-to-service authentication and listens on 127.0.0.1 only. ' +
  'X-Gateway-S2S is not enforced. Do not use MCP_ALLOW_INSECURE_DEV outside local development.';

const S2S_UNAUTHORIZED = {
  error:
    'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.',
};

const GATEWAY_CREDENTIALS_UNAUTHORIZED = {
  error:
    'Missing credentials: X-Alternative-Payments-Client-ID and X-Alternative-Payments-Client-Secret are required in gateway mode.',
};

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/**
 * Secret for X-Gateway-S2S on /mcp. Read at HTTP startup, not module load.
 * Empty is fail-closed unless MCP_ALLOW_INSECURE_DEV is exactly "1".
 * Known placeholders are refused even when that flag is set.
 * The secret value is never written to logs.
 */
function resolveHttpS2sSecret(): string {
  const secret = (process.env.CONDUIT_S2S_SECRET ?? '').trim();
  if (KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    logger.error(PLACEHOLDER_S2S_SECRET_ERROR);
    process.exit(1);
  }
  if (secret) return secret;

  if (process.env.MCP_ALLOW_INSECURE_DEV === '1') {
    // error level so LOG_LEVEL=warn|error cannot hide the bypass.
    logger.error(INSECURE_DEV_WARNING);
    return '';
  }

  logger.error(MISSING_S2S_SECRET_ERROR);
  process.exit(1);
}

/**
 * No secret (the insecure-dev bypass) always binds 127.0.0.1. A wider
 * MCP_HTTP_HOST is ignored and the override is logged. A configured secret
 * keeps honoring MCP_HTTP_HOST, including the historical 0.0.0.0 default
 * when that variable is unset.
 */
function resolveBindHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? '').trim();
  if (s2sSecret) return configured || '0.0.0.0';

  if (configured && !isLoopbackBindHost(configured)) {
    logger.error(
      `MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        'MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. ' +
        `Binding ${LOOPBACK_HOST} only.`,
    );
  }
  return LOOPBACK_HOST;
}

export function startHttpServer(): Promise<Server> {
  const s2sSecret = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || '8080', 10);
  const host = resolveBindHost(s2sSecret);
  const isGatewayMode = process.env.AUTH_MODE === 'gateway';

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    // Liveness only — credentials arrive per-request in gateway mode, so we
    // never 503 on missing creds (that would false-red the vendor monitor).
    // This route is unauthenticated and must not read vendor credentials.
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          transport: 'http',
          mode: isGatewayMode ? 'gateway' : 'standalone',
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/mcp', '/health'] }));
      return;
    }

    // Conduit service-to-service auth (gateway#377 parity): rejected
    // BEFORE any credential extraction, mirroring every other ported
    // wrapper. Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1.
    if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(S2S_UNAUTHORIZED));
      return;
    }

    const handle = async () => {
      const server = createServer();
      // SECURITY-CRITICAL invariant: this transport MUST stay stateless
      // (sessionIdGenerator: undefined + enableJsonResponse: true). Per-request
      // tenant credentials are carried in an AsyncLocalStorage context opened by
      // runWithCredentials() below. A stateless request->single-response flow
      // keeps the tool call inside that context. Switching to a stateful/SSE
      // transport (sessionIdGenerator set, persistent stream) would let a
      // long-lived connection serve later messages under a stale/foreign
      // credential context — re-review tenant isolation before changing this.
      //
      // The whole chain below (transport creation through the catch block)
      // runs inside runWithServerRef so the server-ref binding — used by
      // elicitation for destructive-action confirmation — survives every
      // await gap in this request's lifecycle without leaking into a
      // concurrent request's server-ref.
      return runWithServerRef(server, async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });

        res.on('close', () => {
          transport.close();
          server.close();
        });

        try {
          await server.connect(transport);
          await transport.handleRequest(req, res);
        } catch (err) {
          logger.error('MCP transport error', { error: (err as Error).message });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal error' },
                id: null,
              }),
            );
          }
        }
      });
    };

    if (isGatewayMode) {
      const clientId = headerValue(req.headers['x-alternative-payments-client-id']);
      const clientSecret = headerValue(req.headers['x-alternative-payments-client-secret']);
      const rawEnv = headerValue(req.headers['x-alternative-payments-environment']);
      const environment: Environment = rawEnv?.toLowerCase() === 'demo' ? 'demo' : 'production';

      // Gateway mode: credentials must arrive on every request. Reject
      // explicitly if missing rather than falling through — falling through
      // would resolve credentials from the process environment, which is not
      // request-scoped (CWE-306).
      if (!clientId || !clientSecret) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(GATEWAY_CREDENTIALS_UNAUTHORIZED));
        return;
      }

      await runWithCredentials({ clientId, clientSecret, environment }, handle);
      return;
    }

    await handle();
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      logger.info(`HTTP streaming server listening on ${host}:${port}`);
      resolve(httpServer);
    });
  });
}

// Vitest imports this module to call startHttpServer. Skip the CLI
// entrypoint there. `node dist/http.js` still starts stdio or HTTP.
if (process.env.VITEST !== 'true') {
  const transport = process.env.MCP_TRANSPORT;
  if (transport === 'http') {
    startHttpServer().catch((error) => {
      logger.error('Fatal startup error', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
  } else {
    import('./index.js');
  }
}

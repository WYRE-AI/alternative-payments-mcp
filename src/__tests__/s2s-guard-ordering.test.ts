/**
 * S2S guard ordering vs. lazy Alternative Payments OAuth exchange
 *
 * This vendor's own credential EXTRACTION (http.ts's `x-alternative-payments-*`
 * header read) is a pure, synchronous, no-side-effect operation — but the
 * vendored SDK (`@wyre-technology/node-alternative-payments`) that those
 * credentials are handed to performs a REAL lazy OAuth 2.0 client-credentials
 * exchange: `TokenManager.getToken()` -> `fetchToken()` does
 * `fetch(`${baseUrl}/oauth/token`, ...)` the first time any API-backed tool
 * call needs a token (`HttpClient`'s request path calls `tokenManager.getToken()`
 * before making the actual API request). This lives entirely inside
 * node_modules, invisible to an in-repo-only classification sweep — that's
 * exactly why this test exists: a generic 4-case status-code check can't
 * distinguish "guard correctly blocked the request before any token exchange"
 * from "guard was accidentally moved after the exchange, but still ultimately
 * rejected" — both look like a 401 from the outside. Only an instrumented
 * call-counter on the token endpoint tells them apart.
 *
 * Approach (a): drives a REAL `tools/call` (`ap_list_customers`) round-trip
 * through the actual HTTP server (src/http.ts, unmocked), stubbing only the
 * network boundary — Alternative Payments' own host is intercepted, every
 * other fetch (notably this test's own loopback call into the server under
 * test) passes through to the real fetch.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

const TEST_HOST = '127.0.0.1';
const TEST_PORT = 47521;
const TEST_S2S_SECRET = 'test-s2s-guard-ordering-secret-do-not-use-in-prod';
const WRONG_S2S_SECRET = 'wrong-secret-must-not-verify';
const AP_DEMO_HOST = 'https://public-api.demo.alternativepayments.io';

function mintS2sHeader(secret: string, unixSeconds: number): string {
  // Mirrors src/s2s-verify.ts's HMAC construction exactly.
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

const GATEWAY_HEADERS = {
  'x-alternative-payments-client-id': 'test-client-id',
  'x-alternative-payments-client-secret': 'test-client-secret',
  'x-alternative-payments-environment': 'demo',
};

let realFetch: typeof fetch;
let tokenCalls = 0;
let dataCalls = 0;

function installFetchStub(): void {
  tokenCalls = 0;
  dataCalls = 0;
  const stub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.startsWith(`http://${TEST_HOST}:${TEST_PORT}`)) {
      return realFetch(input as never, init);
    }
    if (url.startsWith(`${AP_DEMO_HOST}/oauth/token`)) {
      tokenCalls++;
      return new Response(
        JSON.stringify({ access_token: 'fake-access-token-for-test', expires_in: 3600, token_type: 'bearer' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.startsWith(AP_DEMO_HOST)) {
      dataCalls++;
      return new Response(JSON.stringify({ data: [], has_more: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(input as never, init);
  });
  global.fetch = stub as unknown as typeof fetch;
}

async function postToMcp(headers: Record<string, string>, body: unknown): Promise<Response> {
  return realFetch(`http://${TEST_HOST}:${TEST_PORT}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function waitForServerReady(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await realFetch(`http://${TEST_HOST}:${TEST_PORT}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('alternative-payments-mcp test HTTP server did not become ready in time');
}

beforeAll(async () => {
  realFetch = globalThis.fetch.bind(globalThis);

  process.env.MCP_TRANSPORT = 'http';
  process.env.AUTH_MODE = 'gateway';
  process.env.MCP_HTTP_PORT = String(TEST_PORT);
  process.env.MCP_HTTP_HOST = TEST_HOST;
  process.env.CONDUIT_S2S_SECRET = TEST_S2S_SECRET;

  await import('../http.js');
  await waitForServerReady();
});

afterAll(() => {
  global.fetch = realFetch;
});

beforeEach(() => {
  installFetchStub();
});

const TOOLS_LIST_BODY = { jsonrpc: '2.0', method: 'tools/list', id: 1 };
const LIST_CUSTOMERS_BODY = {
  jsonrpc: '2.0',
  method: 'tools/call',
  params: { name: 'ap_list_customers', arguments: {} },
  id: 2,
};

describe('S2S guard ordering vs. lazy Alternative Payments OAuth exchange', () => {
  it('does NOT reach the Alternative Payments OAuth token endpoint when the S2S header is missing', async () => {
    const res = await postToMcp({ ...GATEWAY_HEADERS }, LIST_CUSTOMERS_BODY);

    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(dataCalls).toBe(0);
  });

  it('does NOT reach the Alternative Payments OAuth token endpoint when the S2S header is present but invalid', async () => {
    const res = await postToMcp(
      {
        ...GATEWAY_HEADERS,
        'x-gateway-s2s': mintS2sHeader(WRONG_S2S_SECRET, Math.floor(Date.now() / 1000)),
      },
      LIST_CUSTOMERS_BODY,
    );

    expect(res.status).toBe(401);
    expect(tokenCalls).toBe(0);
    expect(dataCalls).toBe(0);
  });

  // Negative control: proves the fetch-stub apparatus above genuinely detects
  // the token exchange firing, so the zero-calls assertions in the two cases
  // above are not vacuously true.
  it('DOES reach the OAuth token endpoint exactly once when the S2S header is valid and a real tool executes', async () => {
    const res = await postToMcp(
      {
        ...GATEWAY_HEADERS,
        'x-gateway-s2s': mintS2sHeader(TEST_S2S_SECRET, Math.floor(Date.now() / 1000)),
      },
      LIST_CUSTOMERS_BODY,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { isError?: boolean } };
    expect(body.result?.isError).not.toBe(true);

    expect(tokenCalls).toBe(1);
    expect(dataCalls).toBe(1);
  });

  it('sanity: a valid S2S header with tools/list (no API-backed tool) never reaches the token endpoint', async () => {
    const res = await postToMcp(
      {
        ...GATEWAY_HEADERS,
        'x-gateway-s2s': mintS2sHeader(TEST_S2S_SECRET, Math.floor(Date.now() / 1000)),
      },
      TOOLS_LIST_BODY,
    );

    expect(res.status).toBe(200);
    expect(tokenCalls).toBe(0);
  });
});

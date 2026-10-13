/**
 * HTTP transport fail-closed auth.
 *
 * Startup requires a real CONDUIT_S2S_SECRET unless MCP_ALLOW_INSECURE_DEV=1.
 * Known placeholders are refused even with that flag. The dev bypass binds
 * 127.0.0.1 only. A configured secret honors MCP_HTTP_HOST.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit vendor credential headers
 * and must not fall back to ALTERNATIVE_PAYMENTS_* in process.env.
 */

import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const getCredentialsMock = vi.hoisted(() => vi.fn());

vi.mock('../utils/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/client.js')>();
  return {
    ...actual,
    getCredentials: () => {
      getCredentialsMock();
      return actual.getCredentials();
    },
  };
});

import { startHttpServer } from '../http.js';

const S2S_SECRET = 's2s-do-not-log-7f3a';
const ENV_CLIENT_ID = 'env-client-id-must-not-be-used';
const ENV_CLIENT_SECRET = 'env-secret-must-not-be-used';

const ENV_KEYS = [
  'CONDUIT_S2S_SECRET',
  'MCP_ALLOW_INSECURE_DEV',
  'MCP_HTTP_PORT',
  'MCP_HTTP_HOST',
  'AUTH_MODE',
  'ALTERNATIVE_PAYMENTS_CLIENT_ID',
  'ALTERNATIVE_PAYMENTS_CLIENT_SECRET',
  'ALTERNATIVE_PAYMENTS_ENVIRONMENT',
  'LOG_LEVEL',
  'MCP_TRANSPORT',
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac('sha256', secret).update(message).digest('hex');
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  });
  return {
    text: () => lines.join('\n'),
    restore: () => spy.mockRestore(),
  };
}

function assertNoSecrets(logged: string): void {
  expect(logged).not.toContain(S2S_SECRET);
  expect(logged).not.toContain(ENV_CLIENT_ID);
  expect(logged).not.toContain(ENV_CLIENT_SECRET);
}

interface HttpResult {
  status: number;
  body: string;
}

async function sendHttp(options: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: options.body,
  });
  return { status: response.status, body: await response.text() };
}

async function listen(): Promise<{ port: number; address: string; server: Server }> {
  const server = await startHttpServer();
  servers.push(server);
  const bound = server.address() as AddressInfo | null;
  if (!bound || typeof bound === 'string') {
    throw new Error('HTTP server did not bind a TCP port');
  }
  return { port: bound.port, address: bound.address, server };
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extra,
  };
}

const statusCall = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'ap_status', arguments: {} },
});

function mockExit(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

/** process.exit throws synchronously, before startHttpServer returns a promise. */
function startOrThrow(): Promise<Server> {
  return Promise.resolve().then(() => startHttpServer());
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

beforeEach(async () => {
  process.env.MCP_HTTP_PORT = '0';
  process.env.MCP_HTTP_HOST = '127.0.0.1';
  process.env.LOG_LEVEL = 'info';
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.ALTERNATIVE_PAYMENTS_CLIENT_ID;
  delete process.env.ALTERNATIVE_PAYMENTS_CLIENT_SECRET;
  delete process.env.ALTERNATIVE_PAYMENTS_ENVIRONMENT;
  delete process.env.MCP_TRANSPORT;
  getCredentialsMock.mockReset();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe('HTTP startup', () => {
  it('refuses to start when CONDUIT_S2S_SECRET is empty', async () => {
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startOrThrow()).rejects.toThrow('process.exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
      const text = logs.text();
      expect(text).toContain('Refusing to start HTTP transport');
      expect(text).toContain('CONDUIT_S2S_SECRET is empty');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV=1');
      assertNoSecrets(text);
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it('still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = 'true';
    process.env.CONDUIT_S2S_SECRET = '   ';
    const logs = captureStderr();
    const exitSpy = mockExit();

    try {
      await expect(startOrThrow()).rejects.toThrow('process.exit:1');
      expect(logs.text()).toContain('Refusing to start HTTP transport');
      expect(logs.text()).toContain('CONDUIT_S2S_SECRET is empty');
    } finally {
      exitSpy.mockRestore();
      logs.restore();
    }
  });

  it.each(['changeme', 'ChangeMe', ' your-s2s-secret ', 'placeholder', 'secret'])(
    'refuses known placeholder CONDUIT_S2S_SECRET %j even with the dev bypass',
    async (placeholder) => {
      process.env.CONDUIT_S2S_SECRET = placeholder;
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      const logs = captureStderr();
      const exitSpy = mockExit();

      try {
        await expect(startOrThrow()).rejects.toThrow('process.exit:1');
        expect(exitSpy).toHaveBeenCalledWith(1);
        const text = logs.text();
        expect(text).toContain('Refusing to start HTTP transport');
        expect(text).toContain('known placeholder');
        expect(text).toContain('CONDUIT_S2S_SECRET');
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        exitSpy.mockRestore();
        logs.restore();
      }
    },
  );

  it('allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1 and binds 127.0.0.1', async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = '1';
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe('127.0.0.1');
      const text = logs.text();
      expect(text).toContain('SECURITY WARNING');
      expect(text).toContain('CONDUIT_S2S_SECRET is empty');
      expect(text).toContain('MCP_ALLOW_INSECURE_DEV=1');
      expect(text).toContain('127.0.0.1');
      expect(text).toContain('WITHOUT service-to-service authentication');
      assertNoSecrets(text);
      expect(text).not.toContain('not a loopback address');
    } finally {
      logs.restore();
    }
  });

  it.each(['0.0.0.0', '10.1.2.3'])(
    'forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s',
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = '1';
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      try {
        const server = await listen();
        expect(server.address).toBe('127.0.0.1');
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain('Binding 127.0.0.1 only');
        expect(text).toContain('SECURITY WARNING');
        assertNoSecrets(text);
      } finally {
        logs.restore();
      }
    },
  );

  it('honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '0.0.0.0';
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe('0.0.0.0');
      expect(logs.text()).not.toContain('not a loopback address');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('keeps the 0.0.0.0 default when a secret is set and MCP_HTTP_HOST is unset', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe('0.0.0.0');
      assertNoSecrets(logs.text());
    } finally {
      logs.restore();
    }
  });

  it('honors an explicit loopback MCP_HTTP_HOST when a secret is set', async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    const server = await listen();
    expect(server.address).toBe('127.0.0.1');
  });
});

describe('HTTP /mcp authentication', () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = 'gateway';
    process.env.MCP_HTTP_HOST = '127.0.0.1';
    process.env.ALTERNATIVE_PAYMENTS_CLIENT_ID = ENV_CLIENT_ID;
    process.env.ALTERNATIVE_PAYMENTS_CLIENT_SECRET = ENV_CLIENT_SECRET;
    process.env.ALTERNATIVE_PAYMENTS_ENVIRONMENT = 'production';
  });

  it('returns 401 when the S2S header is missing or invalid and does not log the secret', async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const missing = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-alternative-payments-client-id': 'header-client-id',
          'x-alternative-payments-client-secret': 'header-client-secret',
        }),
        body: statusCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader('wrong-secret'),
          'x-alternative-payments-client-id': 'header-client-id',
          'x-alternative-payments-client-secret': 'header-client-secret',
        }),
        body: statusCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain('X-Gateway-S2S');
      expect(invalid.body).toContain('X-Gateway-S2S');
      expect(missing.body).not.toContain(S2S_SECRET);
      expect(invalid.body).not.toContain(S2S_SECRET);
      expect(missing.body).not.toContain(ENV_CLIENT_ID);
      assertNoSecrets(logs.text());
      expect(getCredentialsMock).not.toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });

  it('returns 401 in gateway mode without credential headers and does not use env credentials', async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });

    expect(response.status).toBe(401);
    expect(response.body).toContain('Missing credentials');
    expect(response.body).toContain('X-Alternative-Payments-Client-ID');
    expect(response.body).toContain('X-Alternative-Payments-Client-Secret');
    expect(response.body).not.toContain(ENV_CLIENT_ID);
    expect(response.body).not.toContain(ENV_CLIENT_SECRET);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(getCredentialsMock).not.toHaveBeenCalled();

    const partial = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({
        'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
        'x-alternative-payments-client-id': 'header-client-id',
      }),
      body: statusCall,
    });
    expect(partial.status).toBe(401);
    expect(getCredentialsMock).not.toHaveBeenCalled();
  });

  it('accepts a valid S2S header plus credential headers and uses those credentials', async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const response = await sendHttp({
        port: server.port,
        method: 'POST',
        path: '/mcp',
        headers: mcpHeaders({
          'x-gateway-s2s': mintS2sHeader(S2S_SECRET),
          'x-alternative-payments-client-id': 'header-client-id',
          'x-alternative-payments-client-secret': 'header-client-secret',
          'x-alternative-payments-environment': 'demo',
        }),
        body: statusCall,
      });

      expect(response.status).toBe(200);
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_CLIENT_ID);
      expect(response.body).not.toContain(ENV_CLIENT_SECRET);
      const payload = JSON.parse(response.body) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = payload.result?.content?.[0]?.text ?? '';
      const status = JSON.parse(text) as { connected?: boolean; environment?: string };
      expect(status.connected).toBe(true);
      expect(status.environment).toBe('demo');
      assertNoSecrets(logs.text());
      expect(getCredentialsMock).toHaveBeenCalled();
    } finally {
      logs.restore();
    }
  });

  it('serves /health without authentication and without reading credentials', async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'GET',
      path: '/health',
    });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.body) as { status?: string; mode?: string };
    expect(body.status).toBe('ok');
    expect(body.mode).toBe('gateway');
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain(ENV_CLIENT_ID);
    expect(response.body).not.toContain(ENV_CLIENT_SECRET);
    expect(response.body).not.toContain('credentials');
    expect(getCredentialsMock).not.toHaveBeenCalled();
  });

  it('uses env credentials in AUTH_MODE=env after a valid S2S header', async () => {
    process.env.AUTH_MODE = 'env';
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: 'POST',
      path: '/mcp',
      headers: mcpHeaders({ 'x-gateway-s2s': mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });

    expect(response.status).toBe(200);
    const payload = JSON.parse(response.body) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const text = payload.result?.content?.[0]?.text ?? '';
    const status = JSON.parse(text) as { connected?: boolean; environment?: string };
    expect(status.connected).toBe(true);
    expect(status.environment).toBe('production');
    expect(response.body).not.toContain(ENV_CLIENT_SECRET);
    expect(response.body).not.toContain(S2S_SECRET);
  });
});

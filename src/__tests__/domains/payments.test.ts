/**
 * Handler-invocation tests for the (read-only) payments domain.
 *
 * Notable: ap_list_transactions forwards the raw `args` object straight to
 * client.transactions.list() instead of picking individual fields like every
 * other list handler in this codebase does. That is real, deliberate-looking
 * behavior in src/domains/payments.ts today (not something these tests
 * invented) — tests below pin it down explicitly so a future refactor to the
 * "pick fields" style elsewhere doesn't silently change it here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    transactions: {
      list: vi.fn(),
      get: vi.fn(),
    },
    payouts: {
      list: vi.fn(),
      get: vi.fn(),
      listTransactions: vi.fn(),
    },
  };
  return { mockClient };
});
vi.mock('../../utils/client.js', () => ({ getClient: () => mockClient }));

import { paymentsHandler } from '../../domains/payments.js';

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('paymentsHandler.getTools', () => {
  it('exposes exactly the five read-only payments tools', () => {
    const names = paymentsHandler.getTools().map((t) => t.name);
    expect(names).toEqual([
      'ap_list_transactions',
      'ap_get_transaction',
      'ap_list_payouts',
      'ap_get_payout',
      'ap_list_payout_transactions',
    ]);
  });

  it('never exposes a direct payment-creation tool (no money movement)', () => {
    const names = paymentsHandler.getTools().map((t) => t.name);
    expect(names.some((n) => /create_payment/.test(n))).toBe(false);
  });

  it('every tool is marked read-only', () => {
    for (const t of paymentsHandler.getTools()) {
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe('paymentsHandler.handleCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ap_list_transactions forwards the full filter set through unchanged', async () => {
    const filters = {
      limit: 20,
      after: 'cursor-a',
      before: 'cursor-b',
      type: 'charge',
      status: 'succeeded',
      customer_id: 'cus_1',
      invoice_id: 'inv_1',
      payment_method: 'card',
      created_at_start: '2026-01-01T00:00:00Z',
      created_at_end: '2026-02-01T00:00:00Z',
    };
    mockClient.transactions.list.mockResolvedValue({ data: [{ id: 'txn_1' }] });

    const result = await paymentsHandler.handleCall('ap_list_transactions', filters);

    expect(mockClient.transactions.list).toHaveBeenCalledWith(filters);
    expect(parse(result)).toEqual({ data: [{ id: 'txn_1' }] });
  });

  it('ap_list_transactions with no args calls list with an empty object', async () => {
    mockClient.transactions.list.mockResolvedValue({ data: [] });

    await paymentsHandler.handleCall('ap_list_transactions', {});

    expect(mockClient.transactions.list).toHaveBeenCalledWith({});
  });

  it('ap_get_transaction fetches by id', async () => {
    mockClient.transactions.get.mockResolvedValue({ id: 'txn_9', amount: 250 });

    const result = await paymentsHandler.handleCall('ap_get_transaction', {
      id: 'txn_9',
    });

    expect(mockClient.transactions.get).toHaveBeenCalledWith('txn_9');
    expect(parse(result)).toEqual({ id: 'txn_9', amount: 250 });
  });

  it('ap_list_payouts forwards limit/after only (not the whole args object)', async () => {
    mockClient.payouts.list.mockResolvedValue({ data: [{ id: 'po_1' }] });

    await paymentsHandler.handleCall('ap_list_payouts', {
      limit: 3,
      after: 'cursor-c',
      // extraneous field must NOT leak into the payouts.list() call, unlike
      // ap_list_transactions above.
      bogus: 'nope',
    });

    expect(mockClient.payouts.list).toHaveBeenCalledWith({
      limit: 3,
      after: 'cursor-c',
    });
  });

  it('ap_get_payout fetches by id', async () => {
    mockClient.payouts.get.mockResolvedValue({ id: 'po_2', status: 'paid' });

    const result = await paymentsHandler.handleCall('ap_get_payout', { id: 'po_2' });

    expect(mockClient.payouts.get).toHaveBeenCalledWith('po_2');
    expect(parse(result)).toEqual({ id: 'po_2', status: 'paid' });
  });

  it('ap_list_payout_transactions lists transactions for the given payout id', async () => {
    mockClient.payouts.listTransactions.mockResolvedValue({ data: [{ id: 'txn_1' }] });

    await paymentsHandler.handleCall('ap_list_payout_transactions', { id: 'po_2' });

    expect(mockClient.payouts.listTransactions).toHaveBeenCalledWith('po_2');
  });

  it('returns an isError result for an unknown tool name', async () => {
    const result = await paymentsHandler.handleCall('ap_nope', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ap_nope');
  });
});

/**
 * Handler-invocation tests for the webhooks domain.
 *
 * Covers subscription list/create, delivery-history listing, retry, and the
 * confirm-guarded (irreversible) delete tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    webhooks: {
      list: vi.fn(),
      listEvents: vi.fn(),
      create: vi.fn(),
      retry: vi.fn(),
      delete: vi.fn(),
    },
  };
  return { mockClient };
});
vi.mock('../../utils/client.js', () => ({ getClient: () => mockClient }));

const { mockConfirmOrAbort } = vi.hoisted(() => ({
  mockConfirmOrAbort: vi.fn(),
}));
vi.mock('../../elicitation/confirm.js', () => ({
  confirmOrAbort: mockConfirmOrAbort,
}));

import { webhooksHandler } from '../../domains/webhooks.js';

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('webhooksHandler.getTools', () => {
  it('exposes exactly the five webhook tools', () => {
    const names = webhooksHandler.getTools().map((t) => t.name);
    expect(names).toEqual([
      'ap_list_webhooks',
      'ap_list_webhook_events',
      'ap_create_webhook',
      'ap_retry_webhooks',
      'ap_delete_webhook',
    ]);
  });

  it('marks ap_delete_webhook destructive and irreversible in its description', () => {
    const tool = webhooksHandler
      .getTools()
      .find((t) => t.name === 'ap_delete_webhook');
    expect(tool?.annotations?.destructiveHint).toBe(true);
    expect(tool?.description).toMatch(/irreversible/i);
  });
});

describe('webhooksHandler.handleCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ap_list_webhooks forwards limit/topic to the client', async () => {
    mockClient.webhooks.list.mockResolvedValue({ data: [{ id: 'wh_1' }] });

    await webhooksHandler.handleCall('ap_list_webhooks', {
      limit: 25,
      topic: 'invoice.paid',
    });

    expect(mockClient.webhooks.list).toHaveBeenCalledWith({
      limit: 25,
      topic: 'invoice.paid',
    });
  });

  it('ap_list_webhook_events forwards limit/status to the client', async () => {
    mockClient.webhooks.listEvents.mockResolvedValue({ data: [{ id: 'evt_1' }] });

    await webhooksHandler.handleCall('ap_list_webhook_events', {
      limit: 10,
      status: 'failed',
    });

    expect(mockClient.webhooks.listEvents).toHaveBeenCalledWith({
      limit: 10,
      status: 'failed',
    });
  });

  it('ap_create_webhook forwards endpoint_url and topic', async () => {
    mockClient.webhooks.create.mockResolvedValue({
      id: 'wh_new',
      endpoint_url: 'https://example.com/hook',
      topic: 'invoice.paid',
    });

    const result = await webhooksHandler.handleCall('ap_create_webhook', {
      endpoint_url: 'https://example.com/hook',
      topic: 'invoice.paid',
    });

    expect(mockClient.webhooks.create).toHaveBeenCalledWith({
      endpoint_url: 'https://example.com/hook',
      topic: 'invoice.paid',
    });
    expect(parse(result)).toEqual({
      id: 'wh_new',
      endpoint_url: 'https://example.com/hook',
      topic: 'invoice.paid',
    });
  });

  it('ap_retry_webhooks calls retry() with no arguments and returns a synthetic ack', async () => {
    mockClient.webhooks.retry.mockResolvedValue(undefined);

    const result = await webhooksHandler.handleCall('ap_retry_webhooks', {});

    expect(mockClient.webhooks.retry).toHaveBeenCalledWith();
    expect(parse(result)).toEqual({ retried: true });
  });

  describe('ap_delete_webhook (destructive, confirm-guarded)', () => {
    it('deletes and returns a synthetic confirmation when the user confirms', async () => {
      mockConfirmOrAbort.mockResolvedValue(null);
      mockClient.webhooks.delete.mockResolvedValue(undefined);

      const result = await webhooksHandler.handleCall('ap_delete_webhook', {
        subscription_id: 'sub_5',
      });

      expect(mockConfirmOrAbort).toHaveBeenCalledWith(
        'Permanently delete webhook subscription sub_5?',
      );
      expect(mockClient.webhooks.delete).toHaveBeenCalledWith('sub_5');
      expect(parse(result)).toEqual({ deleted: true, subscription_id: 'sub_5' });
    });

    it('does NOT call delete and returns the abort result when unconfirmed', async () => {
      const abortResult = {
        content: [{ type: 'text' as const, text: 'Aborted: not confirmed by the user.' }],
        isError: true,
      };
      mockConfirmOrAbort.mockResolvedValue(abortResult);

      const result = await webhooksHandler.handleCall('ap_delete_webhook', {
        subscription_id: 'sub_5',
      });

      expect(mockClient.webhooks.delete).not.toHaveBeenCalled();
      expect(result).toBe(abortResult);
    });

    it('refuses to delete when confirmation is unavailable (null-elicitation default-deny)', async () => {
      // confirmOrAbort itself resolves a "refuse by default" CallToolResult
      // when elicitation is unavailable — verify handleCall honors it exactly
      // like an explicit decline, never falling through to delete().
      const unavailableResult = {
        content: [
          {
            type: 'text' as const,
            text:
              'Aborted: this is a destructive action and interactive confirmation ' +
              'is unavailable in this client. No changes were made.',
          },
        ],
        isError: true,
      };
      mockConfirmOrAbort.mockResolvedValue(unavailableResult);

      const result = await webhooksHandler.handleCall('ap_delete_webhook', {
        subscription_id: 'sub_6',
      });

      expect(mockClient.webhooks.delete).not.toHaveBeenCalled();
      expect(result).toBe(unavailableResult);
    });
  });

  it('returns an isError result for an unknown tool name', async () => {
    const result = await webhooksHandler.handleCall('ap_made_up', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ap_made_up');
  });
});

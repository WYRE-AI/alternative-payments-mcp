/**
 * Handler-invocation tests for the customers domain.
 *
 * Mocks utils/client.js and elicitation/confirm.js, then invokes
 * customersHandler.handleCall directly and asserts:
 *   - the exact call shape sent to the underlying SDK client
 *   - the response transformation back into a CallToolResult
 *   - the confirm-or-abort guard around the destructive archive tool
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    customers: {
      list: vi.fn(),
      get: vi.fn(),
      listUsers: vi.fn(),
      create: vi.fn(),
      addUser: vi.fn(),
      archive: vi.fn(),
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

import { customersHandler } from '../../domains/customers.js';

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('customersHandler.getTools', () => {
  it('exposes exactly the six customer tools', () => {
    const names = customersHandler.getTools().map((t) => t.name);
    expect(names).toEqual([
      'ap_list_customers',
      'ap_get_customer',
      'ap_list_customer_users',
      'ap_create_customer',
      'ap_add_customer_user',
      'ap_archive_customer',
    ]);
  });
});

describe('customersHandler.handleCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ap_list_customers forwards limit/after to the client', async () => {
    mockClient.customers.list.mockResolvedValue({ data: [{ id: 'cus_1' }] });

    const result = await customersHandler.handleCall('ap_list_customers', {
      limit: 5,
      after: 'cursor-1',
    });

    expect(mockClient.customers.list).toHaveBeenCalledWith({
      limit: 5,
      after: 'cursor-1',
    });
    expect(parse(result)).toEqual({ data: [{ id: 'cus_1' }] });
    expect(result.isError).toBeUndefined();
  });

  it('ap_list_customers with no args passes undefined limit/after (not omitted)', async () => {
    mockClient.customers.list.mockResolvedValue({ data: [] });

    await customersHandler.handleCall('ap_list_customers', {});

    expect(mockClient.customers.list).toHaveBeenCalledWith({
      limit: undefined,
      after: undefined,
    });
  });

  it('ap_get_customer fetches by id and returns the raw customer', async () => {
    mockClient.customers.get.mockResolvedValue({ id: 'cus_9', name: 'Acme' });

    const result = await customersHandler.handleCall('ap_get_customer', {
      id: 'cus_9',
    });

    expect(mockClient.customers.get).toHaveBeenCalledWith('cus_9');
    expect(parse(result)).toEqual({ id: 'cus_9', name: 'Acme' });
  });

  it('ap_list_customer_users fetches users for the given customer id', async () => {
    mockClient.customers.listUsers.mockResolvedValue({ data: [{ id: 'usr_1' }] });

    await customersHandler.handleCall('ap_list_customer_users', { id: 'cus_9' });

    expect(mockClient.customers.listUsers).toHaveBeenCalledWith('cus_9');
  });

  it('ap_create_customer sends only name/email, dropping unrelated args', async () => {
    mockClient.customers.create.mockResolvedValue({ id: 'cus_new', name: 'Beta' });

    const result = await customersHandler.handleCall('ap_create_customer', {
      name: 'Beta',
      email: 'beta@example.com',
      // extraneous field a real MCP client might send; should not leak through
      unexpected: 'ignored',
    });

    expect(mockClient.customers.create).toHaveBeenCalledWith({
      name: 'Beta',
      email: 'beta@example.com',
    });
    expect(parse(result)).toEqual({ id: 'cus_new', name: 'Beta' });
  });

  it('ap_add_customer_user forwards id plus the user payload separately', async () => {
    mockClient.customers.addUser.mockResolvedValue({ id: 'usr_2' });

    await customersHandler.handleCall('ap_add_customer_user', {
      id: 'cus_9',
      email: 'u@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
    });

    expect(mockClient.customers.addUser).toHaveBeenCalledWith('cus_9', {
      email: 'u@example.com',
      first_name: 'Jane',
      last_name: 'Doe',
    });
  });

  describe('ap_archive_customer (destructive, confirm-guarded)', () => {
    it('archives and returns a synthetic confirmation when the user confirms', async () => {
      mockConfirmOrAbort.mockResolvedValue(null); // null => proceed
      mockClient.customers.archive.mockResolvedValue(undefined);

      const result = await customersHandler.handleCall('ap_archive_customer', {
        id: 'cus_3',
      });

      expect(mockConfirmOrAbort).toHaveBeenCalledWith('Archive customer cus_3?');
      expect(mockClient.customers.archive).toHaveBeenCalledWith('cus_3');
      expect(parse(result)).toEqual({ archived: true, id: 'cus_3' });
      expect(result.isError).toBeUndefined();
    });

    it('does NOT call archive and returns the abort result when the user declines', async () => {
      const abortResult = {
        content: [{ type: 'text' as const, text: 'Aborted: not confirmed by the user.' }],
        isError: true,
      };
      mockConfirmOrAbort.mockResolvedValue(abortResult);

      const result = await customersHandler.handleCall('ap_archive_customer', {
        id: 'cus_3',
      });

      expect(mockClient.customers.archive).not.toHaveBeenCalled();
      expect(result).toBe(abortResult);
    });
  });

  it('returns an isError result for an unknown tool name', async () => {
    const result = await customersHandler.handleCall('ap_not_a_real_tool', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ap_not_a_real_tool');
  });
});

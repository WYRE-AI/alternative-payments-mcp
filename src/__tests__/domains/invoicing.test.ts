/**
 * Handler-invocation tests for the invoicing domain.
 *
 * Covers invoices, hosted payment links/PDFs, one-time payment requests, and
 * the confirm-guarded archive tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockClient } = vi.hoisted(() => {
  const mockClient = {
    invoices: {
      list: vi.fn(),
      get: vi.fn(),
      getPaymentLink: vi.fn(),
      getPdfLink: vi.fn(),
      create: vi.fn(),
      archive: vi.fn(),
    },
    paymentRequests: {
      create: vi.fn(),
      get: vi.fn(),
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

import { invoicingHandler } from '../../domains/invoicing.js';

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('invoicingHandler.getTools', () => {
  it('exposes exactly the eight invoicing tools', () => {
    const names = invoicingHandler.getTools().map((t) => t.name);
    expect(names).toEqual([
      'ap_list_invoices',
      'ap_get_invoice',
      'ap_get_invoice_payment_link',
      'ap_get_invoice_pdf_link',
      'ap_create_invoice',
      'ap_create_payment_request',
      'ap_get_payment_request',
      'ap_archive_invoice',
    ]);
  });
});

describe('invoicingHandler.handleCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ap_list_invoices forwards all four filters to the client', async () => {
    mockClient.invoices.list.mockResolvedValue({ data: [{ id: 'inv_1' }] });

    await invoicingHandler.handleCall('ap_list_invoices', {
      status: 'paid',
      customer_id: 'cus_1',
      limit: 10,
      after: 'cursor-a',
    });

    expect(mockClient.invoices.list).toHaveBeenCalledWith({
      status: 'paid',
      customer_id: 'cus_1',
      limit: 10,
      after: 'cursor-a',
    });
  });

  it('ap_list_invoices with a partial filter set leaves the rest undefined', async () => {
    mockClient.invoices.list.mockResolvedValue({ data: [] });

    await invoicingHandler.handleCall('ap_list_invoices', { status: 'draft' });

    expect(mockClient.invoices.list).toHaveBeenCalledWith({
      status: 'draft',
      customer_id: undefined,
      limit: undefined,
      after: undefined,
    });
  });

  it('ap_get_invoice fetches by id', async () => {
    mockClient.invoices.get.mockResolvedValue({ id: 'inv_5' });

    await invoicingHandler.handleCall('ap_get_invoice', { id: 'inv_5' });

    expect(mockClient.invoices.get).toHaveBeenCalledWith('inv_5');
  });

  it('ap_get_invoice_payment_link returns the hosted link', async () => {
    mockClient.invoices.getPaymentLink.mockResolvedValue({ url: 'https://pay/inv_5' });

    const result = await invoicingHandler.handleCall('ap_get_invoice_payment_link', {
      id: 'inv_5',
    });

    expect(mockClient.invoices.getPaymentLink).toHaveBeenCalledWith('inv_5');
    expect(parse(result)).toEqual({ url: 'https://pay/inv_5' });
  });

  it('ap_get_invoice_pdf_link returns the signed PDF link', async () => {
    mockClient.invoices.getPdfLink.mockResolvedValue({ url: 'https://pdf/inv_5' });

    const result = await invoicingHandler.handleCall('ap_get_invoice_pdf_link', {
      id: 'inv_5',
    });

    expect(mockClient.invoices.getPdfLink).toHaveBeenCalledWith('inv_5');
    expect(parse(result)).toEqual({ url: 'https://pdf/inv_5' });
  });

  it('ap_create_invoice forwards customer/currency/due_date/line_items verbatim', async () => {
    const lineItems = [{ description: 'Widget', amount: 100, quantity: 2 }];
    mockClient.invoices.create.mockResolvedValue({ id: 'inv_new' });

    await invoicingHandler.handleCall('ap_create_invoice', {
      customer_id: 'cus_1',
      currency: 'USD',
      due_date: '2026-09-01',
      line_items: lineItems,
    });

    expect(mockClient.invoices.create).toHaveBeenCalledWith({
      customer_id: 'cus_1',
      currency: 'USD',
      due_date: '2026-09-01',
      line_items: lineItems,
    });
  });

  it('ap_create_payment_request forwards amount/currency/redirect_url/reference_id', async () => {
    mockClient.paymentRequests.create.mockResolvedValue({ id: 'pr_1', url: 'https://checkout' });

    await invoicingHandler.handleCall('ap_create_payment_request', {
      amount: 500,
      currency: 'USD',
      redirect_url: 'https://example.com/thanks',
      reference_id: 'order-42',
    });

    expect(mockClient.paymentRequests.create).toHaveBeenCalledWith({
      amount: 500,
      currency: 'USD',
      redirect_url: 'https://example.com/thanks',
      reference_id: 'order-42',
    });
  });

  it('ap_create_payment_request leaves reference_id undefined when omitted', async () => {
    mockClient.paymentRequests.create.mockResolvedValue({ id: 'pr_2' });

    await invoicingHandler.handleCall('ap_create_payment_request', {
      amount: 500,
      currency: 'USD',
      redirect_url: 'https://example.com/thanks',
    });

    expect(mockClient.paymentRequests.create).toHaveBeenCalledWith({
      amount: 500,
      currency: 'USD',
      redirect_url: 'https://example.com/thanks',
      reference_id: undefined,
    });
  });

  it('ap_get_payment_request fetches by id', async () => {
    mockClient.paymentRequests.get.mockResolvedValue({ id: 'pr_1', status: 'pending' });

    const result = await invoicingHandler.handleCall('ap_get_payment_request', {
      id: 'pr_1',
    });

    expect(mockClient.paymentRequests.get).toHaveBeenCalledWith('pr_1');
    expect(parse(result)).toEqual({ id: 'pr_1', status: 'pending' });
  });

  describe('ap_archive_invoice (destructive, confirm-guarded)', () => {
    it('archives and returns a synthetic confirmation when the user confirms', async () => {
      mockConfirmOrAbort.mockResolvedValue(null);
      mockClient.invoices.archive.mockResolvedValue(undefined);

      const result = await invoicingHandler.handleCall('ap_archive_invoice', {
        id: 'inv_7',
      });

      expect(mockConfirmOrAbort).toHaveBeenCalledWith('Archive invoice inv_7?');
      expect(mockClient.invoices.archive).toHaveBeenCalledWith('inv_7');
      expect(parse(result)).toEqual({ archived: true, id: 'inv_7' });
    });

    it('does NOT call archive and returns the abort result when unconfirmed', async () => {
      const abortResult = {
        content: [{ type: 'text' as const, text: 'Aborted: not confirmed by the user.' }],
        isError: true,
      };
      mockConfirmOrAbort.mockResolvedValue(abortResult);

      const result = await invoicingHandler.handleCall('ap_archive_invoice', {
        id: 'inv_7',
      });

      expect(mockClient.invoices.archive).not.toHaveBeenCalled();
      expect(result).toBe(abortResult);
    });
  });

  it('returns an isError result for an unknown tool name', async () => {
    const result = await invoicingHandler.handleCall('ap_bogus_tool', {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ap_bogus_tool');
  });
});

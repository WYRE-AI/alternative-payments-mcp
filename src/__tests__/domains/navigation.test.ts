/**
 * Tests for the navigation "domain".
 *
 * Unlike the other four domain files, navigation.ts does NOT export a
 * DomainHandler with handleCall — it exports the DOMAINS registry and
 * getNavigationTools(). The actual dispatch logic for ap_navigate/ap_status
 * lives in server.ts's CallToolRequestSchema handler (out of scope for this
 * file's tests, which focus on domains/*). What's tested here is real content
 * this file is responsible for: the DOMAINS list and the tool metadata built
 * from it, including that the ap_navigate schema stays in sync with DOMAINS.
 */
import { describe, it, expect } from 'vitest';
import { DOMAINS, getNavigationTools } from '../../domains/navigation.js';

describe('DOMAINS', () => {
  it('lists exactly the four domain handlers, in a stable order', () => {
    expect(DOMAINS).toEqual(['customers', 'invoicing', 'payments', 'webhooks']);
  });
});

describe('getNavigationTools', () => {
  it('exposes exactly ap_navigate and ap_status', () => {
    const names = getNavigationTools().map((t) => t.name);
    expect(names).toEqual(['ap_navigate', 'ap_status']);
  });

  it('ap_navigate requires a domain and its enum matches DOMAINS exactly', () => {
    const tool = getNavigationTools().find((t) => t.name === 'ap_navigate');
    expect(tool?.inputSchema.required).toEqual(['domain']);
    const domainProp = (
      tool?.inputSchema.properties as Record<string, { enum?: string[] }>
    ).domain;
    expect(domainProp.enum).toEqual(DOMAINS);
  });

  it('ap_navigate description documents every domain in DOMAINS', () => {
    const tool = getNavigationTools().find((t) => t.name === 'ap_navigate');
    const domainProp = (
      tool?.inputSchema.properties as Record<string, { description?: string }>
    ).domain;
    for (const domain of DOMAINS) {
      expect(domainProp.description ?? '').toMatch(new RegExp(`^- ${domain}:`, 'm'));
    }
  });

  it('ap_status takes no arguments', () => {
    const tool = getNavigationTools().find((t) => t.name === 'ap_status');
    expect(tool?.inputSchema.properties).toEqual({});
    expect(tool?.inputSchema.required).toBeUndefined();
  });

  it('both navigation tools are read-only', () => {
    for (const t of getNavigationTools()) {
      expect(t.annotations?.readOnlyHint).toBe(true);
    }
  });
});

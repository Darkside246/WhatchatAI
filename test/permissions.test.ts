import { describe, expect, it } from 'vitest';
import { hasPermission, permissionsForRole, isBusinessRole, BUSINESS_ROLES } from '../src/domain/auth/permissions.js';

describe('domain/auth/permissions (the real backend-enforced role -> permission map)', () => {
  it('OWNER and ADMIN hold every defined permission', () => {
    const allPermissions = permissionsForRole('OWNER');
    expect(allPermissions.length).toBeGreaterThan(20);
    for (const permission of allPermissions) {
      expect(hasPermission('ADMIN', permission)).toBe(true);
    }
  });

  it('VIEWER cannot send messages, manage users, or manage billing', () => {
    expect(hasPermission('VIEWER', 'whatsapp.send')).toBe(false);
    expect(hasPermission('VIEWER', 'users.manage')).toBe(false);
    expect(hasPermission('VIEWER', 'billing.manage')).toBe(false);
    expect(hasPermission('VIEWER', 'whatsapp.view')).toBe(true);
  });

  it('AGENT can send messages and edit CRM records but cannot manage users or billing', () => {
    expect(hasPermission('AGENT', 'whatsapp.send')).toBe(true);
    expect(hasPermission('AGENT', 'crm.edit')).toBe(true);
    expect(hasPermission('AGENT', 'users.manage')).toBe(false);
    expect(hasPermission('AGENT', 'billing.manage')).toBe(false);
  });

  it('MARKETING can create and send campaigns but cannot send 1:1 WhatsApp messages or touch automation', () => {
    expect(hasPermission('MARKETING', 'marketing.send')).toBe(true);
    expect(hasPermission('MARKETING', 'whatsapp.send')).toBe(false);
    expect(hasPermission('MARKETING', 'automation.execute')).toBe(false);
  });

  it('every role in BUSINESS_ROLES has a non-empty permission set except none are silently dropped from the map', () => {
    for (const role of BUSINESS_ROLES) {
      expect(permissionsForRole(role).length).toBeGreaterThan(0);
    }
  });

  it('isBusinessRole rejects an arbitrary string', () => {
    expect(isBusinessRole('OWNER')).toBe(true);
    expect(isBusinessRole('SUPERUSER')).toBe(false);
  });
});

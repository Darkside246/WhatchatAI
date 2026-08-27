import { describe, expect, it } from 'vitest';
import { WhatsChatPlatformService } from './whatschatPlatformService.js';

describe('WhatsChatPlatformService', () => {
  it('starts a one-product 48 hour trial and routes to the selected shell', () => {
    const service = new WhatsChatPlatformService();
    const start = new Date('2026-08-27T12:00:00.000Z');
    const account = service.startTrial({ fullName: 'Test Owner', email: ' TEST@EMAIL.COM ', phoneNumber: '246-555-0100', product: 'PROPERTY' }, start);
    const shell = service.getClientShell(account.id, start);
    expect(shell.route).toBe('/property');
    expect(shell.navigation).not.toContain('Orders');
    expect(shell.account.status).toBe('TRIAL_ACTIVE');
  });

  it('enforces one trial across the platform but allows a separate paid account', () => {
    const service = new WhatsChatPlatformService();
    service.startTrial({ fullName: 'Test Owner', email: 'test@email.com', phoneNumber: '1', product: 'FOOD' });
    expect(() => service.startTrial({ fullName: 'Test Owner', email: 'TEST@email.com', phoneNumber: '1', product: 'PROPERTY' })).toThrow(/trial already used/);
  });

  it('restricts client navigation after trial expiry', () => {
    const service = new WhatsChatPlatformService();
    const start = new Date('2026-08-27T12:00:00.000Z');
    const account = service.startTrial({ fullName: 'Test Owner', email: 'expired@email.com', phoneNumber: '1', product: 'FOOD' }, start);
    const shell = service.getClientShell(account.id, new Date('2026-08-29T13:00:00.000Z'));
    expect(shell.access).toBe(false);
    expect(shell.route).toBe('/billing');
    expect(shell.navigation).toEqual(['Billing', 'Settings']);
  });

  it('keeps developer control-plane areas out of client navigation', () => {
    const service = new WhatsChatPlatformService();
    const account = service.startTrial({ fullName: 'Test Owner', email: 'devcheck@email.com', phoneNumber: '1', product: 'PROPERTY' });
    const client = service.getClientShell(account.id);
    expect(client.navigation).not.toContain('AI Providers');
    expect(service.developerControlPlane().areas).toContain('AI Providers');
    expect(service.developerControlPlane().areas).toContain('OpenClaw');
  });
});

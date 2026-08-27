import { describe, expect, it } from 'vitest';
import { ProductAccountService } from './productAccountService.js';

describe('ProductAccountService', () => {
  it('normalizes email and allows only one platform trial per email', () => {
    const service = new ProductAccountService();
    const first = service.registerTrial({
      fullName: 'John Smith',
      email: ' Test@Email.com ',
      phoneNumber: '+12465550000',
      product: 'PROPERTY',
    }, new Date('2026-08-26T12:00:00.000Z'));

    expect(first.identity.email).toBe('test@email.com');
    expect(first.account.status).toBe('TRIAL_ACTIVE');
    expect(first.account.trialEndsAt).toBe('2026-08-28T12:00:00.000Z');

    expect(() => service.registerTrial({
      fullName: 'John Smith',
      email: 'TEST@email.com',
      phoneNumber: '+12465550000',
      product: 'FOOD',
    })).toThrow(/trial already used/i);
  });

  it('keeps separately purchased product accounts isolated under one identity', () => {
    const service = new ProductAccountService();
    const property = service.createPaidProductAccount({ fullName: 'John Smith', email: 'john@example.com', phoneNumber: '1', product: 'PROPERTY' });
    const food = service.createPaidProductAccount({ fullName: 'John Smith', email: 'JOHN@example.com', phoneNumber: '1', product: 'FOOD' });

    expect(property.identity.id).toBe(food.identity.id);
    expect(property.account.id).not.toBe(food.account.id);
    expect(property.account.tenantId).not.toBe(food.account.tenantId);
    expect(property.account.product).toBe('PROPERTY');
    expect(food.account.product).toBe('FOOD');
    expect(service.listAccountsForEmail('john@example.com')).toHaveLength(2);
  });

  it('moves a trial through expiring, expired, restricted and active after payment', () => {
    const service = new ProductAccountService();
    const registered = service.registerTrial({ fullName: 'A', email: 'a@example.com', phoneNumber: '1', product: 'FOOD' }, new Date('2026-01-01T00:00:00.000Z'));

    service.refreshLifecycle(new Date('2026-01-02T01:00:00.000Z'));
    expect(service.getAccount(registered.account.id)?.status).toBe('TRIAL_EXPIRING');

    service.refreshLifecycle(new Date('2026-01-03T00:00:00.000Z'));
    expect(service.getAccount(registered.account.id)?.status).toBe('TRIAL_EXPIRED');

    service.restrictExpiredAccount(registered.account.id, new Date('2026-01-03T00:01:00.000Z'));
    expect(service.getAccount(registered.account.id)?.status).toBe('RESTRICTED');

    expect(service.activateAfterPayment(registered.account.id).status).toBe('ACTIVE');
  });

  it('records WhatsApp connection per product account', () => {
    const service = new ProductAccountService();
    const registered = service.registerTrial({ fullName: 'A', email: 'a@example.com', phoneNumber: '1', product: 'PROPERTY' });
    const connected = service.markWhatsAppConnected(registered.account.id, new Date('2026-01-01T00:00:00.000Z'));
    expect(connected.whatsappConnectedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

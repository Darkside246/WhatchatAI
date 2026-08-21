import { describe, expect, it } from 'vitest';
import { getWhatsAppDisplayName, getWhatsAppDisplayLabel } from './whatsappDisplayName.js';

describe('getWhatsAppDisplayName (presentation-only - never touches the real jid/account id)', () => {
  it('prefers the business-set account name over everything else', () => {
    const result = getWhatsAppDisplayName({ accountName: "John's WhatsApp", pushName: 'John Smith', phoneNumber: '+13055551234' });
    expect(result).toEqual({ primary: "John's WhatsApp", secondary: '+13055551234' });
  });

  it('falls back to the WhatsApp profile name when no account name is set', () => {
    const result = getWhatsAppDisplayName({ accountName: null, pushName: 'John Smith', phoneNumber: '+13055551234' });
    expect(result).toEqual({ primary: 'John Smith', secondary: '+13055551234' });
  });

  it('shows the phone number as a secondary line alongside a resolved name, never dropping it', () => {
    const result = getWhatsAppDisplayName({ pushName: 'Reception', phoneNumber: '+442071234567' });
    expect(result.primary).toBe('Reception');
    expect(result.secondary).toBe('+442071234567');
  });

  it('falls back to the phone number alone when no name is available', () => {
    const result = getWhatsAppDisplayName({ pushName: null, phoneNumber: '+13055551234' });
    expect(result).toEqual({ primary: '+13055551234', secondary: null });
  });

  it('falls back to a stable "Line 1" label when nothing at all is available', () => {
    const result = getWhatsAppDisplayName({ pushName: null, phoneNumber: null });
    expect(result).toEqual({ primary: 'Line 1', secondary: null });
  });

  it('accepts a caller-supplied fallback label instead of the default', () => {
    const result = getWhatsAppDisplayName({}, 'your account');
    expect(result).toEqual({ primary: 'your account', secondary: null });
  });

  it('treats whitespace-only values the same as absent - never displays a blank label', () => {
    const result = getWhatsAppDisplayName({ pushName: '   ', phoneNumber: '  ' });
    expect(result).toEqual({ primary: 'Line 1', secondary: null });
  });

  it('is deterministic - the same input always produces the same output', () => {
    const input = { pushName: 'Reception', phoneNumber: '+442071234567' };
    expect(getWhatsAppDisplayName(input)).toEqual(getWhatsAppDisplayName({ ...input }));
  });
});

describe('getWhatsAppDisplayLabel (single-line convenience for headers that cannot render two lines)', () => {
  it('folds the secondary line into parentheses when both are known', () => {
    expect(getWhatsAppDisplayLabel({ pushName: 'John Smith', phoneNumber: '+13055551234' })).toBe(
      'John Smith (+13055551234)',
    );
  });

  it('returns just the phone number when no name resolved', () => {
    expect(getWhatsAppDisplayLabel({ phoneNumber: '+13055551234' })).toBe('+13055551234');
  });

  it('returns the fallback label when nothing resolved', () => {
    expect(getWhatsAppDisplayLabel({}, 'your account')).toBe('your account');
  });
});

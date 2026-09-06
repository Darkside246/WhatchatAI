import { describe, expect, it } from 'vitest';
import { extractGmailBody, type GmailMessage } from '../src/services/emailSyncService.js';

/**
 * Real bug found via a user report: a single-part HTML email (no
 * multipart/alternative wrapper - common for automated notification
 * emails) had its raw HTML source put into `bodyText` instead of
 * `bodyHtml`, so every client rendered the literal <html><body>...
 * tags as plain text instead of formatted content. Fixed by checking
 * the top-level payload's own mimeType for the no-`parts`-at-all case,
 * and by making the multipart search recursive (a message with an
 * attachment nests text/plain+text/html one or more levels deep under
 * multipart/mixed > multipart/alternative, not at the top level).
 */

function b64(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

describe('extractGmailBody - real Gmail MIME structures, no LLM', () => {
  it('a single-part text/html message (no parts array) extracts to html, not text - the exact reported bug', () => {
    const msg: GmailMessage = {
      id: '1',
      payload: { mimeType: 'text/html', body: { data: b64('<html><body>Hi</body></html>') } },
    };
    const result = extractGmailBody(msg);
    expect(result.html).toBe('<html><body>Hi</body></html>');
    expect(result.text).toBeNull();
  });

  it('a single-part text/plain message (no parts array) still extracts to text - unchanged existing behavior', () => {
    const msg: GmailMessage = {
      id: '2',
      payload: { mimeType: 'text/plain', body: { data: b64('Hello there') } },
    };
    const result = extractGmailBody(msg);
    expect(result.text).toBe('Hello there');
    expect(result.html).toBeNull();
  });

  it('a top-level multipart/alternative with plain+html siblings extracts both correctly', () => {
    const msg: GmailMessage = {
      id: '3',
      payload: {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Plain version') } },
          { mimeType: 'text/html', body: { data: b64('<p>HTML version</p>') } },
        ],
      },
    };
    const result = extractGmailBody(msg);
    expect(result.text).toBe('Plain version');
    expect(result.html).toBe('<p>HTML version</p>');
  });

  it('a real nested structure (multipart/mixed with an attachment wrapping multipart/alternative) is still found - the recursive-search fix', () => {
    const msg: GmailMessage = {
      id: '4',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              { mimeType: 'text/plain', body: { data: b64('Nested plain') } },
              { mimeType: 'text/html', body: { data: b64('<p>Nested HTML</p>') } },
            ],
          },
          { mimeType: 'application/pdf', body: {} },
        ],
      },
    };
    const result = extractGmailBody(msg);
    expect(result.text).toBe('Nested plain');
    expect(result.html).toBe('<p>Nested HTML</p>');
  });

  it('a message with genuinely no body content returns null for both, never a fabricated empty string', () => {
    const msg: GmailMessage = { id: '5', payload: { mimeType: 'text/plain' } };
    const result = extractGmailBody(msg);
    expect(result.html).toBeNull();
    expect(result.text).toBeNull();
  });
});

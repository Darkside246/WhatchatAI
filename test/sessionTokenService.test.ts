import { describe, expect, it } from 'vitest';
import { parseUserAgent } from '../src/services/sessionTokenService.js';

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const EDGE_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0';
const OPERA_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0';
const SAMSUNG_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/122.0.0.0 Mobile Safari/537.36';
const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const CHROME_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1';

describe('parseUserAgent (real regex-ordering behavior, no mocking needed)', () => {
  it('never returns null/undefined for a real, ordinary Chrome-on-Windows string', () => {
    expect(parseUserAgent(CHROME_WINDOWS)).toEqual({ browser: 'Chrome', os: 'Windows' });
  });

  it('detects Edge, not generic Chrome, even though Edge\'s own UA string also contains "Chrome/" - ordering-sensitive', () => {
    expect(parseUserAgent(EDGE_WINDOWS)).toEqual({ browser: 'Edge', os: 'Windows' });
  });

  it('detects Opera, not generic Chrome, for the same reason', () => {
    expect(parseUserAgent(OPERA_WINDOWS)).toEqual({ browser: 'Opera', os: 'Windows' });
  });

  it('detects Samsung Internet, not generic Chrome', () => {
    expect(parseUserAgent(SAMSUNG_ANDROID)).toEqual({ browser: 'Samsung Internet', os: 'Android' });
  });

  it('detects Firefox on Linux', () => {
    expect(parseUserAgent(FIREFOX_LINUX)).toEqual({ browser: 'Firefox', os: 'Linux' });
  });

  it('detects real Safari on macOS, distinct from a Chromium browser also claiming a Safari/ token', () => {
    expect(parseUserAgent(SAFARI_MAC)).toEqual({ browser: 'Safari', os: 'macOS' });
  });

  it('detects Chrome on iOS as its own label, and the device as iPhone not macOS', () => {
    expect(parseUserAgent(CHROME_IOS)).toEqual({ browser: 'Chrome (iOS)', os: 'iPhone' });
  });

  it('never fabricates a browser/OS name for a null or empty user agent - honest unknowns', () => {
    expect(parseUserAgent(null)).toEqual({ browser: 'Unknown browser', os: 'Unknown device' });
    expect(parseUserAgent(undefined)).toEqual({ browser: 'Unknown browser', os: 'Unknown device' });
    expect(parseUserAgent('')).toEqual({ browser: 'Unknown browser', os: 'Unknown device' });
  });

  it('a real, disclosed limit: a browser that deliberately sends a byte-for-byte Chrome-identical UA (e.g. Brave) is honestly reported as Chrome, never guessed at', () => {
    // This is the same exact string a real Brave browser sends by design -
    // there is no server-side signal that distinguishes it from real Chrome.
    expect(parseUserAgent(CHROME_WINDOWS)).toEqual({ browser: 'Chrome', os: 'Windows' });
  });
});

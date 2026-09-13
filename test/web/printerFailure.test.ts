import { describe, expect, it } from 'vitest';
import { describePrinterFailure, inFrame, PrinterError } from '../../src/web/src/lib/printerTransport.js';

/**
 * The browser throws DOMExceptions written for developers. "Permission
 * denied" on its own, shown to somebody standing at a counter, says nothing
 * about what to do - and it covers several genuinely different situations.
 * These pin that each one is named and each says a real next step.
 */

describe('describing why a print failed', () => {
  it('passes our own refusals straight through - they already explain themselves', () => {
    const error = new PrinterError('That attachment has not finished downloading here yet.');
    expect(describePrinterFailure(error, 'bluetooth')).toBe('That attachment has not finished downloading here yet.');
  });

  it('treats a closed chooser as a choice, not a failure', () => {
    expect(describePrinterFailure(new DOMException('x', 'NotFoundError'), 'usb')).toBe('No printer was chosen.');
    expect(describePrinterFailure(new DOMException('x', 'AbortError'), 'usb')).toBe('No printer was chosen.');
  });

  describe('permission denied', () => {
    it('blames the frame when the page is embedded, because no site setting can fix that', () => {
      const message = describePrinterFailure(new DOMException('Permission denied', 'NotAllowedError'), 'bluetooth', true);
      expect(message).toContain('embedded inside another one');
      expect(message).toContain('own tab');
    });

    it('sends somebody to the site permission when the page is not embedded', () => {
      const message = describePrinterFailure(new DOMException('Permission denied', 'NotAllowedError'), 'bluetooth', false);
      expect(message).toContain('padlock');
      expect(message).toContain('Bluetooth');
      expect(message).not.toContain('embedded');
    });

    it('names the right hardware for USB', () => {
      const message = describePrinterFailure(new DOMException('Permission denied', 'SecurityError'), 'usb', false);
      expect(message).toContain('USB');
      expect(message).not.toContain('Bluetooth');
    });

    it('talks about pop-ups for the print dialog, which has no hardware to permit', () => {
      const message = describePrinterFailure(new DOMException('Permission denied', 'NotAllowedError'), 'browser', false);
      expect(message).toContain('pop-ups');
      expect(message).not.toContain('padlock');
    });
  });

  it('distinguishes a printer that would not connect from one that was refused', () => {
    const message = describePrinterFailure(new DOMException('x', 'NetworkError'), 'bluetooth');
    expect(message).toContain('in range');
  });

  it('says a busy printer is busy, rather than broken', () => {
    expect(describePrinterFailure(new DOMException('x', 'InvalidStateError'), 'usb')).toContain('busy');
  });

  it('keeps the real message for anything it does not recognise, rather than hiding it', () => {
    const message = describePrinterFailure(new Error('GATT operation failed for unknown reason'), 'bluetooth');
    expect(message).toContain('GATT operation failed for unknown reason');
  });

  it('still says something useful when thrown a value that is not an error at all', () => {
    expect(describePrinterFailure('nope', 'usb')).toContain('no detail given');
  });
});

describe('detecting a frame', () => {
  it('reports no frame where there is no window at all, rather than guessing one', () => {
    // A test runner or a server render has no window. Reporting "framed"
    // there would send somebody off to open a new tab over nothing.
    expect(inFrame()).toBe(false);
  });
});

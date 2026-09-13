import type { PaperWidth } from './escpos.js';
import type { PrinterTransportKind } from './printerTransport.js';

/**
 * Which printer THIS device prints to.
 *
 * Deliberately per-device rather than per-business, and so deliberately in
 * localStorage rather than on the server. The printer is a physical object
 * plugged into one particular tablet: the screen at the pass has the
 * kitchen printer, the counter has the receipt printer, and the owner's
 * laptop at home has neither. A business-wide setting would be wrong on at
 * least two of those three, every time.
 *
 * It also cannot be anything else. The browser grants access to a chosen
 * Bluetooth or USB device to one origin on one machine; that grant does not
 * travel, so a preference that travelled would point at a device this
 * browser is not allowed to open.
 */

const KEY = 'aura_food_printer';

export interface PrinterSettings {
  /** Off by default. A kitchen with no printer must never see an error because the app assumed one. */
  enabled: boolean;
  transport: PrinterTransportKind;
  paper: PaperWidth;
  /** What the chooser called the device, so the settings screen can name it. */
  label: string | null;
  /**
   * Print a kitchen ticket by itself the moment an order reaches the
   * kitchen. Off by default: a printer that starts producing paper without
   * being asked is the fastest way to empty a roll.
   */
  autoPrintKitchen: boolean;
  /** Which station's copy this device prints. Null prints the whole order. */
  station: string | null;
}

export const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
  enabled: false,
  transport: 'browser',
  paper: 58,
  label: null,
  autoPrintKitchen: false,
  station: null,
};

export function loadPrinterSettings(): PrinterSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PRINTER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<PrinterSettings>;
    // Merged over the defaults rather than trusted whole: this is a value a
    // person can edit in devtools, and a setting added in a later version
    // has to have somewhere to come from for a device saved before it.
    return {
      ...DEFAULT_PRINTER_SETTINGS,
      ...parsed,
      paper: parsed.paper === 80 ? 80 : 58,
      transport:
        parsed.transport === 'bluetooth' || parsed.transport === 'usb' ? parsed.transport : 'browser',
    };
  } catch {
    // Private browsing, cleared site data, a half-written value. Printing
    // simply stays off rather than the kitchen screen failing to load.
    return DEFAULT_PRINTER_SETTINGS;
  }
}

export function savePrinterSettings(settings: PrinterSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
    // Other mounts of the board in this tab - the settings panel and the
    // board itself - pick the change up without a reload.
    window.dispatchEvent(new CustomEvent('aura:printer-settings-changed'));
  } catch {
    // Nothing to do: the setting is a convenience, and failing to persist
    // it must not stop the person printing right now.
  }
}

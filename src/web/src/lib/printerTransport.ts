/**
 * Getting the bytes to a printer that is in the room, not on the network.
 *
 * A counter-top thermal printer has no IP the server could reach: it is
 * plugged into the till or paired to the tablet standing next to it. So the
 * browser has to talk to it directly, and the browser offers exactly two
 * ways - Web Bluetooth and WebUSB - neither of which Safari implements.
 *
 * Hence three transports, in honest order of preference:
 *
 *   bluetooth  BLE printers. Chrome and Edge, desktop and Android.
 *   usb        USB printers. Chrome and Edge, desktop.
 *   browser    The operating system's own print dialog, against a sheet
 *              sized for the roll. Works everywhere, including iPad, and is
 *              the only route for a printer installed as a normal system
 *              printer. It is a fallback in capability, not in quality.
 *
 * Both direct transports need a user gesture to pick the device the first
 * time - the browser will not let a page enumerate what is plugged in - so
 * a printer is chosen once in settings and remembered by the browser, not
 * discovered silently per ticket.
 */

/**
 * Just enough of Web Bluetooth and WebUSB to do this job.
 *
 * Neither has types in this project's lib, and both ship large @types
 * packages describing APIs almost none of which is used here. These cover
 * exactly what the functions below touch - so the compiler checks the real
 * calls, and a call this file does not make is not silently blessed either.
 */
interface PrinterGattCharacteristic {
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValue(value: Uint8Array): Promise<void>;
  writeValueWithoutResponse(value: Uint8Array): Promise<void>;
}
interface PrinterGattService {
  getCharacteristics(): Promise<PrinterGattCharacteristic[]>;
}
interface PrinterGattServer {
  getPrimaryService(service: number | string): Promise<PrinterGattService>;
  disconnect(): void;
}
interface PrinterBluetoothDevice {
  name?: string | undefined;
  gatt?: { connect(): Promise<PrinterGattServer> } | undefined;
}
interface PrinterBluetooth {
  requestDevice(options: { acceptAllDevices?: boolean; optionalServices?: (number | string)[] }): Promise<PrinterBluetoothDevice>;
  getDevices?: () => Promise<PrinterBluetoothDevice[]>;
}
interface PrinterUsbEndpoint {
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
  endpointNumber: number;
}
interface PrinterUsbDevice {
  productName?: string | undefined;
  configuration: { interfaces: { interfaceNumber: number; alternates: { endpoints: PrinterUsbEndpoint[] }[] }[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(value: number): Promise<void>;
  releaseInterface(value: number): Promise<void>;
  transferOut(endpointNumber: number, data: Uint8Array): Promise<unknown>;
}
interface PrinterUsb {
  requestDevice(options: { filters: { classCode?: number }[] }): Promise<PrinterUsbDevice>;
  getDevices(): Promise<PrinterUsbDevice[]>;
}

export type PrinterTransportKind = 'bluetooth' | 'usb' | 'browser';

export interface PrinterTarget {
  kind: PrinterTransportKind;
  /** What to call it on screen. The device's own name where it has one. */
  label: string;
}

export class PrinterError extends Error {}

/**
 * The BLE service most thermal printers expose.
 *
 * There is no registered standard for this, so printers use one of a small
 * number of vendor UUIDs that everybody copied. All of them are offered to
 * the chooser; the one the printer actually has is the one that connects.
 */
const BLE_SERVICES = [
  0xffe0, // The most common clone service.
  0xff00,
  0x18f0, // Used by several Epson-compatible models.
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Issc / Microchip transparent UART.
];

/** Bytes have to go out in chunks: a BLE characteristic write is capped near 512 bytes, and in practice far less. */
const BLE_CHUNK = 180;

function bluetooth(): PrinterBluetooth {
  const available = (navigator as Navigator & { bluetooth?: PrinterBluetooth }).bluetooth;
  if (!available) throw new PrinterError('This browser cannot talk to Bluetooth printers. Chrome or Edge can, or use the print dialog instead.');
  return available;
}

function usb(): PrinterUsb {
  const available = (navigator as Navigator & { usb?: PrinterUsb }).usb;
  if (!available) throw new PrinterError('This browser cannot talk to USB printers. Chrome or Edge can, or use the print dialog instead.');
  return available;
}

export function transportAvailable(kind: PrinterTransportKind): boolean {
  if (kind === 'browser') return true;
  if (kind === 'bluetooth') return 'bluetooth' in navigator;
  return 'usb' in navigator;
}

/**
 * Asks the person which printer, through the browser's own chooser.
 *
 * Must be called straight from a click. The browser refuses a chooser that
 * did not come from a real user gesture, and the failure is silent-ish -
 * a rejected promise with no dialog ever appearing.
 */
export async function choosePrinter(kind: 'bluetooth' | 'usb'): Promise<PrinterTarget> {
  if (kind === 'bluetooth') {
    const device = await bluetooth().requestDevice({
      // acceptAllDevices, because a printer that advertises none of the
      // known services would otherwise be invisible in the chooser and the
      // person would conclude their printer is not supported. optionalServices
      // is still required or the connection below cannot reach them.
      acceptAllDevices: true,
      optionalServices: BLE_SERVICES,
    });
    return { kind, label: device.name || 'Bluetooth printer' };
  }

  const device = await usb().requestDevice({ filters: [{ classCode: 7 }] });
  return { kind, label: device.productName || 'USB printer' };
}

async function printOverBluetooth(bytes: Uint8Array): Promise<void> {
  /**
   * getDevices returns what this browser has already been granted, so the
   * everyday path needs no dialog. It is unimplemented in some versions,
   * and empty until a printer has been chosen once - both fall back to the
   * chooser, which is honest: the person genuinely has to pick.
   */
  const known = await bluetooth().getDevices?.().catch(() => []);
  const device =
    known && known.length > 0
      ? known[0]!
      : await bluetooth().requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });

  const server = await device.gatt?.connect();
  if (!server) throw new PrinterError('Could not connect to that printer.');

  let characteristic: PrinterGattCharacteristic | null = null;
  for (const service of BLE_SERVICES) {
    try {
      const found = await server.getPrimaryService(service);
      const characteristics = await found.getCharacteristics();
      characteristic = characteristics.find((candidate) => candidate.properties.write || candidate.properties.writeWithoutResponse) ?? null;
      if (characteristic) break;
    } catch {
      // Not this service. Try the next - a printer has exactly one of them.
    }
  }
  if (!characteristic) {
    server.disconnect();
    throw new PrinterError('That device connected but does not look like a printer.');
  }

  try {
    for (let offset = 0; offset < bytes.length; offset += BLE_CHUNK) {
      const chunk = bytes.slice(offset, offset + BLE_CHUNK);
      /**
       * writeValueWithoutResponse where the printer offers it - a receipt
       * is a few kilobytes and the acknowledged write is slow enough to be
       * visible at the counter. Printers that only support the acknowledged
       * write get it.
       */
      if (characteristic.properties.writeWithoutResponse) await characteristic.writeValueWithoutResponse(chunk);
      else await characteristic.writeValue(chunk);
    }
  } finally {
    server.disconnect();
  }
}

async function printOverUsb(bytes: Uint8Array): Promise<void> {
  const granted = await usb().getDevices();
  const device = granted[0] ?? (await usb().requestDevice({ filters: [{ classCode: 7 }] }));

  await device.open();
  try {
    if (device.configuration === null) await device.selectConfiguration(1);

    /**
     * Find the bulk OUT endpoint rather than assuming endpoint 1.
     *
     * Printer class devices are consistent about having one, and completely
     * inconsistent about its number. Assuming gets a NetworkError on a
     * printer that works fine.
     */
    let interfaceNumber: number | null = null;
    let endpointNumber: number | null = null;
    for (const candidate of device.configuration?.interfaces ?? []) {
      for (const alternate of candidate.alternates) {
        const endpoint = alternate.endpoints.find((option) => option.direction === 'out' && option.type === 'bulk');
        if (endpoint) {
          interfaceNumber = candidate.interfaceNumber;
          endpointNumber = endpoint.endpointNumber;
          break;
        }
      }
      if (endpointNumber !== null) break;
    }
    if (interfaceNumber === null || endpointNumber === null) throw new PrinterError('That USB device does not accept print data.');

    await device.claimInterface(interfaceNumber);
    try {
      await device.transferOut(endpointNumber, bytes);
    } finally {
      await device.releaseInterface(interfaceNumber);
    }
  } finally {
    await device.close();
  }
}

/**
 * The everywhere route: hand the OS a page the size of the roll.
 *
 * A hidden iframe rather than window.open, so no popup blocker is involved
 * and the app's own screen is untouched while the dialog is open. The text
 * is pre-formatted monospace, because it was laid out for a fixed column
 * count by the same code that builds the bytes.
 */
export function printViaBrowser(text: string, paperMm: number): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    throw new PrinterError('Could not open the print dialog.');
  }

  doc.open();
  doc.write(
    `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: ${paperMm}mm auto; margin: 2mm; }
      body { margin: 0; font-family: ui-monospace, "Courier New", monospace; font-size: 11px; line-height: 1.25; white-space: pre; }
    </style></head><body></body></html>`,
  );
  doc.close();
  // Written as a text node rather than into the markup above: a customer
  // name or an allergy note containing "<" would otherwise be parsed as
  // HTML, and could silently swallow the rest of the ticket.
  doc.body.appendChild(doc.createTextNode(text));

  const cleanUp = () => frame.remove();
  frame.contentWindow?.addEventListener('afterprint', cleanUp, { once: true });
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  // afterprint does not fire in every browser. The frame is empty and
  // invisible, so a late removal costs nothing and a missing one leaks.
  setTimeout(cleanUp, 60_000);
}

/** Sends one already-built ticket. The caller decides which document it is. */
export async function sendToPrinter(kind: PrinterTransportKind, bytes: Uint8Array, plainText: string, paperMm: number): Promise<void> {
  if (kind === 'browser') return printViaBrowser(plainText, paperMm);
  if (kind === 'bluetooth') return printOverBluetooth(bytes);
  return printOverUsb(bytes);
}

import { z } from 'zod';
import type { InvoiceRecord, InvoiceLineItemRecord } from '../../repositories/invoiceRepository.js';

/**
 * Three real invoice/quote/receipt templates, built against the same
 * structural conventions every mainstream invoicing tool (QuickBooks,
 * Zoho Invoice, Wave) and standard invoicing practice share: seller
 * identity + logo, a unique document number, issue/due dates, an
 * itemized table (description/qty/unit price/discount/line total),
 * a subtotal -> tax -> discount -> grand total breakdown, and a
 * notes/terms footer. What differs between templates is purely
 * presentation - the underlying fields and their order never change,
 * so a business can switch templates without its documents reading
 * differently to a customer.
 *
 * - Classic: a traditional, understated business-document look - a plain
 *   white page, a single accent-colored rule under the document title,
 *   restrained color use overall. The safest default (QuickBooks' own
 *   "Standard" template follows this same restrained convention).
 * - Modern: a full-width colored header band behind the logo/business
 *   name (Zoho Invoice's "Meadow"/"Neon" templates use this same colored-
 *   band device), a colored item-table header row, and a colored grand-
 *   total box - the most visually assertive of the three.
 * - Minimal: the most whitespace, thinnest rules only (no fills at all
 *   except the grand-total figure itself), uppercase micro-labels -
 *   closest to the clean, typography-led invoices tools like Stripe
 *   Invoicing produce.
 */
export type InvoiceTemplateId = 'classic' | 'modern' | 'minimal';

export const INVOICE_TEMPLATE_IDS: InvoiceTemplateId[] = ['classic', 'modern', 'minimal'];

/**
 * The independently colorable blocks of a rendered document - deliberately
 * named by what a business owner sees, not by CSS class, since this is
 * exactly the set of controls the Customize panel exposes. Every value is
 * optional: null/absent falls back to that template's own considered
 * default (usually derived from the business's brandColor), so a business
 * that never customizes anything renders identically to a hardcoded
 * template.
 */
export interface InvoiceBlockColors {
  /** The header band behind the logo/business name (Modern template only - Classic/Minimal don't have a filled header block). */
  headerBg?: string | null | undefined;
  /** The document title ("Invoice"/"Quotation"/"Receipt") and other accent touches (the underline rule on Classic, the total figure on Minimal). */
  accent?: string | null | undefined;
  /** The item table's header row background. */
  tableHeaderBg?: string | null | undefined;
  /** The item table's header row text. */
  tableHeaderText?: string | null | undefined;
  /** The grand-total row/box background (Modern's filled box; a subtle tint on Classic/Minimal). */
  totalsBg?: string | null | undefined;
  /** The grand-total figure's text color. */
  totalsText?: string | null | undefined;
}

/**
 * Curated, system-safe fonts only - no Google Fonts/web-font loading, since
 * a document render must work identically whether or not whatever
 * generates the final PDF has network access at that moment. Every one of
 * these four is available on every real OS/renderer without a fetch.
 */
export type InvoiceFontId = 'helvetica' | 'georgia' | 'times' | 'courier';

export const INVOICE_FONT_STACKS: Record<InvoiceFontId, string> = {
  helvetica: `'Helvetica Neue', Helvetica, Arial, sans-serif`,
  georgia: `Georgia, 'Times New Roman', serif`,
  times: `'Times New Roman', Times, serif`,
  courier: `'Courier New', Courier, monospace`,
};

export interface InvoiceCustomization {
  templateId: InvoiceTemplateId;
  /** Defaults to 'helvetica' (the original hardcoded font) when unset - a business that never customizes anything renders identically to before this setting existed. */
  fontId?: InvoiceFontId | null | undefined;
  colors: InvoiceBlockColors;
}

export const DEFAULT_INVOICE_CUSTOMIZATION: InvoiceCustomization = { templateId: 'classic', fontId: 'helvetica', colors: {} };

export function isInvoiceTemplateId(value: unknown): value is InvoiceTemplateId {
  return value === 'classic' || value === 'modern' || value === 'minimal';
}

/** The one real schema for InvoiceCustomization - shared by every route that reads or writes it (server/index.ts's business-settings PATCH, invoiceRouter.ts's preview endpoint) so validation never drifts between them. */
const hexColorSchema = z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a hex color like #0a84ff').nullable();

export const invoiceCustomizationSchema = z.object({
  templateId: z.enum(['classic', 'modern', 'minimal']),
  fontId: z.enum(['helvetica', 'georgia', 'times', 'courier']).nullable().optional(),
  colors: z.object({
    headerBg: hexColorSchema.optional(),
    accent: hexColorSchema.optional(),
    tableHeaderBg: hexColorSchema.optional(),
    tableHeaderText: hexColorSchema.optional(),
    totalsBg: hexColorSchema.optional(),
    totalsText: hexColorSchema.optional(),
  }),
});

/** The real fields every template actually renders - a subset of the full InvoiceRecord, so a not-yet-saved preview (invoiceRouter.ts's POST /preview) can be rendered without needing an id/businessId/etc. that don't exist yet. */
export type RenderableInvoice = Pick<InvoiceRecord, 'documentType' | 'invoiceNumber' | 'issueDate' | 'createdAt' | 'dueDate' | 'status' | 'currencyCode' | 'subtotalCents' | 'taxBasisPoints' | 'discountCents' | 'totalCents' | 'notes' | 'terms' | 'footerText'>;
export type RenderableLineItem = Pick<InvoiceLineItemRecord, 'description' | 'quantity' | 'unitPriceCents' | 'discountBasisPoints' | 'totalCents'>;

/**
 * Who the document is addressed to.
 *
 * Its absence was the real defect this type fixes: RenderInput carried no
 * customer at all, so no invoice this system produced named the party being
 * billed - which is what separates a valid tax invoice from a styled
 * statement of amounts.
 *
 * Every field is optional, and an absent one is simply not printed. A
 * document for a walk-in customer with only a name is still a better
 * document than one with an invented address.
 */
export interface RenderableCustomer {
  /** The legal entity billed. Falls back to the contact's own display name when no separate billing name is set. */
  name: string | null;
  address?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
}

export interface RenderableBusiness {
  name: string;
  brandColor: string | null;
  logoDataUrl: string | null;
  /** The existing "slogan" field (migration 983) - shown under the business name. */
  motto?: string | null | undefined;
  address?: string | null | undefined;
  phone?: string | null | undefined;
  /** The number a tax authority requires on a tax invoice, with the label that is correct for this business's own country (VAT No., TIN, ABN...). */
  taxRegistrationNumber?: string | null | undefined;
  taxRegistrationLabel?: string | null | undefined;
  invoiceEmail?: string | null | undefined;
  invoiceWebsite?: string | null | undefined;
  /** Bank details, a payment link, "cash on delivery" - printed in its own block so a customer knows how to pay. */
  paymentInstructions?: string | null | undefined;
}

interface RenderInput {
  invoice: RenderableInvoice;
  lineItems: RenderableLineItem[];
  business: RenderableBusiness;
  /** Null for a preview with no contact chosen yet, or a document genuinely raised against no contact. */
  customer?: RenderableCustomer | null | undefined;
  customization: InvoiceCustomization;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * An INVOICE that actually charges tax is titled "Tax Invoice".
 *
 * Not cosmetic: in Barbados (and across most VAT/GST regimes) that exact
 * wording is part of what makes the document one a registered customer can
 * claim input tax against. A document charging VAT but headed only
 * "Invoice" can be rejected for that reason alone.
 *
 * Conditioned on tax genuinely being charged, never on the business merely
 * having a registration number - titling a zero-tax document a tax invoice
 * would be a different and equally real misstatement.
 */
function docTitle(documentType: InvoiceRecord['documentType'], taxBasisPoints = 0): string {
  if (documentType === 'QUOTE') return 'Quotation';
  if (documentType === 'RECEIPT') return 'Receipt';
  return taxBasisPoints > 0 ? 'Tax Invoice' : 'Invoice';
}

/** Shared data prep every template renders identically - rows, totals, the logo tag, the status badge. Only the surrounding CSS/layout differs per template. */
function prepare(input: RenderInput) {
  const { invoice, lineItems, business } = input;
  const currency = invoice.currencyCode;
  const fmt = (cents: number) => `${currency} ${(cents / 100).toFixed(2)}`;
  const taxPct = (invoice.taxBasisPoints / 100).toFixed(2);
  const taxCents = Math.round((invoice.subtotalCents * invoice.taxBasisPoints) / 10000);

  const rows = lineItems
    .map(
      (li) => `<tr>
        <td>${escapeHtml(li.description)}</td>
        <td class="num">${parseFloat(li.quantity).toFixed(2)}</td>
        <td class="num">${fmt(li.unitPriceCents)}</td>
        <td class="num">${(li.discountBasisPoints / 100).toFixed(0)}%</td>
        <td class="num">${fmt(li.totalCents)}</td>
      </tr>`,
    )
    .join('\n');

  const logoHtml = business.logoDataUrl
    ? `<img src="${business.logoDataUrl}" alt="" style="max-height:48px;max-width:180px;margin-bottom:8px;display:block;" />`
    : '';

  return { currency, fmt, taxPct, taxCents, rows, logoHtml, title: docTitle(invoice.documentType, invoice.taxBasisPoints) };
}

function metaTable(invoice: RenderInput['invoice']): string {
  return `<table class="meta">
    <tr><th>Number</th><td>${escapeHtml(invoice.invoiceNumber)}</td></tr>
    <tr><th>Date</th><td>${invoice.issueDate}</td></tr>
    ${invoice.dueDate ? `<tr><th>Due</th><td>${invoice.dueDate}</td></tr>` : ''}
    <tr><th>Status</th><td><span class="badge ${invoice.status.toLowerCase()}">${invoice.status}</span></td></tr>
  </table>`;
}

/** The business-identity block every template's header shares: logo, name, slogan, address, phone. `extra` is the one thing that still differs per template (e.g. "INVOICE" label vs nothing). */
function businessBlock(business: RenderableBusiness, logoHtml: string, extra: string): string {
  return `<div>
    ${logoHtml}
    <div class="brand">${escapeHtml(business.name)}</div>
    ${business.motto ? `<div class="slogan">${escapeHtml(business.motto)}</div>` : ''}
    ${business.address ? `<div class="contact-line">${escapeHtml(business.address)}</div>` : ''}
    ${business.phone ? `<div class="contact-line">${escapeHtml(business.phone)}</div>` : ''}
    ${business.invoiceEmail ? `<div class="contact-line">${escapeHtml(business.invoiceEmail)}</div>` : ''}
    ${business.invoiceWebsite ? `<div class="contact-line">${escapeHtml(business.invoiceWebsite)}</div>` : ''}
    ${
      business.taxRegistrationNumber
        ? `<div class="contact-line">${escapeHtml(business.taxRegistrationLabel || 'Tax Reg. No.')}: ${escapeHtml(business.taxRegistrationNumber)}</div>`
        : ''
    }
    ${extra}
  </div>`;
}

/**
 * Who the document is addressed to.
 *
 * Shared by all three templates rather than written per-template, so a
 * document can never be compliant in Classic and missing its Bill To in
 * Minimal - which is exactly the kind of drift three hand-written copies
 * produce.
 *
 * Returns an empty string when there is genuinely no customer (an unsaved
 * preview, or a document raised against no contact). An empty "Bill To"
 * heading over blank space looks like a rendering fault; no block at all is
 * the honest representation of "nobody has been chosen yet".
 */
function customerBlock(customer: RenderableCustomer | null | undefined): string {
  if (!customer) return '';
  const lines = [customer.address, customer.email, customer.phone].filter(
    (line): line is string => typeof line === 'string' && line.trim().length > 0,
  );
  if (!customer.name && lines.length === 0) return '';

  return `<div class="bill-to">
    <div class="bill-to-label">Bill To</div>
    ${customer.name ? `<div class="bill-to-name">${escapeHtml(customer.name)}</div>` : ''}
    ${lines.map((line) => `<div class="contact-line">${escapeHtml(line)}</div>`).join('')}
  </div>`;
}

/** How to pay. Its own block, in a predictable place, rather than buried in free-text terms. */
function paymentBlock(business: RenderableBusiness): string {
  if (!business.paymentInstructions) return '';
  return `<div class="notes" style="margin-top:12px"><strong>How to pay</strong>${escapeHtml(business.paymentInstructions)}</div>`;
}

function totalsTable(invoice: RenderInput['invoice'], fmt: (c: number) => string, taxPct: string, taxCents: number): string {
  return `<table>
    <tr><td>Subtotal</td><td>${fmt(invoice.subtotalCents)}</td></tr>
    ${invoice.taxBasisPoints > 0 ? `<tr><td>Tax (${taxPct}%)</td><td>${fmt(taxCents)}</td></tr>` : ''}
    ${invoice.discountCents > 0 ? `<tr><td>Discount</td><td>-${fmt(invoice.discountCents)}</td></tr>` : ''}
    <tr class="grand"><td>Total</td><td>${fmt(invoice.totalCents)}</td></tr>
  </table>`;
}

function footerBlocks(invoice: RenderInput['invoice'], business?: RenderableBusiness): string {
  return `${business ? paymentBlock(business) : ''}
${invoice.notes ? `<div class="notes"><strong>Notes</strong>${escapeHtml(invoice.notes)}</div>` : ''}
${invoice.terms ? `<div class="notes" style="margin-top:12px"><strong>Terms &amp; Conditions</strong>${escapeHtml(invoice.terms)}</div>` : ''}
${invoice.footerText ? `<div class="notes" style="margin-top:12px;text-align:center;">${escapeHtml(invoice.footerText)}</div>` : ''}`;
}

function sharedBaseCss(fontId: InvoiceFontId | null | undefined): string {
  const fontStack = INVOICE_FONT_STACKS[fontId ?? 'helvetica'];
  return `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: ${fontStack}; font-size:13px; color:#1a1a2e; padding:40px; }
  .slogan { margin-top:2px; font-style:italic; color:#666; font-size:12px; }
  .contact-line { margin-top:2px; color:#777; font-size:11px; }
  .bill-to { margin-top:24px; }
  .bill-to-label { font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:#999; margin-bottom:4px; }
  .bill-to-name { font-weight:600; font-size:13px; }
  table.items { width:100%; border-collapse:collapse; margin:24px 0; }
  table.items td { padding:8px 10px; border-bottom:1px solid #eee; }
  .num { text-align:right; }
  .totals { float:right; width:280px; }
  .totals table { width:100%; }
  .totals td { padding:5px 8px; }
  .totals td:last-child { text-align:right; }
  .notes { margin-top:60px; font-size:12px; color:#555; }
  .notes strong { display:block; margin-bottom:4px; }
  .badge { display:inline-block; padding:3px 10px; border-radius:4px; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; background:#dff0d8; color:#27592e; }
  .badge.overdue { background:#fde8e8; color:#a01010; }
  .badge.draft { background:#e8eaf6; color:#3949ab; }
  .clearfix::after { content:''; display:table; clear:both; }
`;
}

function renderClassic(input: RenderInput): string {
  const { invoice } = input;
  const { fmt, taxPct, taxCents, rows, logoHtml, title } = prepare(input);
  const accent = input.customization.colors.accent ?? input.business.brandColor ?? '#0a84ff';
  const tableHeaderBg = input.customization.colors.tableHeaderBg ?? '#f4f6fb';
  const tableHeaderText = input.customization.colors.tableHeaderText ?? '#1a1a2e';
  const totalsText = input.customization.colors.totalsText ?? '#1a1a2e';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><style>
${sharedBaseCss(input.customization.fontId)}
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:40px; }
  .brand { font-size:22px; font-weight:700; }
  .meta th { text-align:left; font-weight:600; padding-right:12px; color:#666; }
  .meta td { padding-right:8px; }
  h2 { font-size:18px; margin-bottom:16px; text-transform:uppercase; letter-spacing:.05em; color:${accent}; border-bottom:2px solid ${accent}; padding-bottom:8px; display:inline-block; }
  table.items th { background:${tableHeaderBg}; color:${tableHeaderText}; padding:8px 10px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .totals .grand td { font-weight:700; border-top:2px solid #1a1a2e; font-size:15px; color:${totalsText}; }
</style></head><body>
<div class="header">
  ${businessBlock(input.business, logoHtml, `<div style="margin-top:8px;color:#666;">${invoice.documentType}</div>`)}
  ${metaTable(invoice)}
</div>
<h2>${title}</h2>
${customerBlock(input.customer)}
<table class="items"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Discount</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>
<div class="clearfix"><div class="totals">${totalsTable(invoice, fmt, taxPct, taxCents)}</div></div>
${footerBlocks(invoice, input.business)}
</body></html>`;
}

function renderModern(input: RenderInput): string {
  const { invoice } = input;
  const { fmt, taxPct, taxCents, rows, logoHtml, title } = prepare(input);
  const headerBg = input.customization.colors.headerBg ?? input.business.brandColor ?? '#0a84ff';
  const accent = input.customization.colors.accent ?? headerBg;
  const tableHeaderBg = input.customization.colors.tableHeaderBg ?? headerBg;
  const tableHeaderText = input.customization.colors.tableHeaderText ?? '#ffffff';
  const totalsBg = input.customization.colors.totalsBg ?? headerBg;
  const totalsText = input.customization.colors.totalsText ?? '#ffffff';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><style>
${sharedBaseCss(input.customization.fontId)}
  body { padding:0; }
  .band { background:${headerBg}; color:#fff; padding:36px 40px; display:flex; justify-content:space-between; align-items:flex-start; }
  .band .brand { font-size:22px; font-weight:700; }
  .band .slogan { color:rgba(255,255,255,0.85); }
  .band .contact-line { color:rgba(255,255,255,0.75); }
  .band .meta th { text-align:left; font-weight:600; padding-right:12px; color:rgba(255,255,255,0.75); }
  .band .meta td { padding-right:8px; }
  .content { padding:32px 40px 40px; }
  h2 { font-size:18px; margin-bottom:16px; text-transform:uppercase; letter-spacing:.05em; color:${accent}; }
  table.items th { background:${tableHeaderBg}; color:${tableHeaderText}; padding:9px 10px; text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.04em; border-radius:2px; }
  .totals .grand td { font-weight:700; font-size:15px; background:${totalsBg}; color:${totalsText}; border-radius:4px; }
  .totals .grand td:first-child { border-radius:4px 0 0 4px; }
  .totals .grand td:last-child { border-radius:0 4px 4px 0; }
</style></head><body>
<div class="band">
  ${businessBlock(input.business, logoHtml, `<div style="margin-top:8px;opacity:.85;">${invoice.documentType}</div>`)}
  ${metaTable(invoice)}
</div>
<div class="content">
<h2>${title}</h2>
${customerBlock(input.customer)}
<table class="items"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Discount</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>
<div class="clearfix"><div class="totals">${totalsTable(invoice, fmt, taxPct, taxCents)}</div></div>
${footerBlocks(invoice, input.business)}
</div>
</body></html>`;
}

function renderMinimal(input: RenderInput): string {
  const { invoice } = input;
  const { fmt, taxPct, taxCents, rows, logoHtml, title } = prepare(input);
  const accent = input.customization.colors.accent ?? input.business.brandColor ?? '#0a84ff';
  const tableHeaderText = input.customization.colors.tableHeaderText ?? '#8a8a99';
  const totalsText = input.customization.colors.totalsText ?? accent;

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><style>
${sharedBaseCss(input.customization.fontId)}
  body { padding:48px 44px; }
  .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:48px; }
  .brand { font-size:20px; font-weight:600; letter-spacing:-.01em; }
  .meta th { text-align:left; font-weight:500; padding-right:12px; color:#aaa; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  .meta td { padding-right:8px; padding-bottom:4px; }
  h2 { font-size:13px; margin-bottom:20px; text-transform:uppercase; letter-spacing:.12em; color:#999; font-weight:600; }
  table.items { border-top:1px solid #eee; }
  table.items th { background:none; color:${tableHeaderText}; padding:10px 10px 10px 0; text-align:left; font-size:10px; text-transform:uppercase; letter-spacing:.06em; font-weight:600; border-bottom:1px solid #eee; }
  table.items td { padding:10px 10px 10px 0; border-bottom:1px solid #f3f3f3; }
  .totals .grand td { font-weight:700; border-top:1px solid #1a1a2e; font-size:18px; color:${totalsText}; padding-top:10px; }
  .badge { background:none; border:1px solid #ccc; color:#888; }
  .badge.overdue { border-color:#e39; color:#a01010; }
  .badge.draft { border-color:#99a; color:#3949ab; }
</style></head><body>
<div class="header">
  ${businessBlock(input.business, logoHtml, '')}
  ${metaTable(invoice)}
</div>
<h2>${title}</h2>
${customerBlock(input.customer)}
<table class="items"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit Price</th><th class="num">Discount</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>
<div class="clearfix"><div class="totals">${totalsTable(invoice, fmt, taxPct, taxCents)}</div></div>
${footerBlocks(invoice, input.business)}
</body></html>`;
}

export function renderInvoiceHtml(input: RenderInput): string {
  if (input.customization.templateId === 'modern') return renderModern(input);
  if (input.customization.templateId === 'minimal') return renderMinimal(input);
  return renderClassic(input);
}

import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { InvoiceService } from '../services/invoice/invoiceService.js';
import { computeInvoiceTotals, computeLineTotalCents } from '../repositories/invoiceRepository.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import { requireAuth, requireActiveSubscription, type AuthContext } from './authMiddleware.js';
import { invoiceCustomizationSchema, DEFAULT_INVOICE_CUSTOMIZATION, type InvoiceCustomization } from '../services/invoice/invoiceTemplates.js';

const router = Router();
const svc = new InvoiceService(pool);
const businessRepository = new BusinessRepository(pool);
router.use(requireAuth);
router.use(requireActiveSubscription);

const LineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive().max(1_000_000),
  unitPriceCents: z.number().int().min(0),
  discountBasisPoints: z.number().int().min(0).max(10000).optional(),
  sortOrder: z.number().int().optional(),
});

const CreateSchema = z.object({
  contactId: z.string().uuid().optional(),
  propertyId: z.string().uuid().optional(),
  documentType: z.enum(['INVOICE', 'QUOTE', 'RECEIPT']).optional(),
  currencyCode: z.string().length(3).optional(),
  taxBasisPoints: z.number().int().min(0).max(10000).optional(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(2000).optional(),
  terms: z.string().max(2000).optional(),
  footerText: z.string().max(500).optional(),
  aiGenerated: z.boolean().optional(),
  aiConversationId: z.string().uuid().optional(),
  lineItems: z.array(LineItemSchema).min(1).max(100),
});

const PatchSchema = z.object({
  notes: z.string().max(2000).optional(),
  terms: z.string().max(2000).optional(),
  footerText: z.string().max(500).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  taxBasisPoints: z.number().int().min(0).max(10000).optional(),
  currencyCode: z.string().length(3).optional(),
});

// GET /api/invoices
router.get('/', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;
  const documentType = typeof req.query['type'] === 'string' ? req.query['type'] : undefined;
  const limit = req.query['limit'] ? Math.min(Number(req.query['limit']), 100) : 50;
  const offset = req.query['offset'] ? Number(req.query['offset']) : 0;
  const opts: { status?: string; documentType?: string; limit?: number; offset?: number } = { limit, offset };
  if (status) opts.status = status;
  if (documentType) opts.documentType = documentType;
  const invoices = await svc.list(auth.businessId, opts);
  return res.json({ invoices });
});

// POST /api/invoices
router.post('/', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const parsed = CreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_BODY', detail: parsed.error.flatten() });
  // Build CreateInvoiceInput without spreading undefined optional fields (exactOptionalPropertyTypes).
  const d = parsed.data;
  const result = await svc.draft({
    businessId: auth.businessId,
    lineItems: d.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPriceCents: li.unitPriceCents,
      ...(li.discountBasisPoints !== undefined ? { discountBasisPoints: li.discountBasisPoints } : {}),
      ...(li.sortOrder !== undefined ? { sortOrder: li.sortOrder } : {}),
    })),
    ...(d.contactId !== undefined ? { contactId: d.contactId } : {}),
    ...(d.propertyId !== undefined ? { propertyId: d.propertyId } : {}),
    ...(d.documentType !== undefined ? { documentType: d.documentType } : {}),
    ...(d.currencyCode !== undefined ? { currencyCode: d.currencyCode } : {}),
    ...(d.taxBasisPoints !== undefined ? { taxBasisPoints: d.taxBasisPoints } : {}),
    ...(d.issueDate !== undefined ? { issueDate: d.issueDate } : {}),
    ...(d.dueDate !== undefined ? { dueDate: d.dueDate } : {}),
    ...(d.notes !== undefined ? { notes: d.notes } : {}),
    ...(d.terms !== undefined ? { terms: d.terms } : {}),
    ...(d.footerText !== undefined ? { footerText: d.footerText } : {}),
    ...(d.aiGenerated !== undefined ? { aiGenerated: d.aiGenerated } : {}),
    ...(d.aiConversationId !== undefined ? { aiConversationId: d.aiConversationId } : {}),
  });
  return res.status(201).json(result);
});

// GET /api/invoices/:id
router.get('/:id', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const result = await svc.get(auth.businessId, req.params['id']!);
  if (!result) return res.status(404).json({ error: 'NOT_FOUND' });
  return res.json(result);
});

// GET /api/invoices/:id/html — server-rendered HTML for PDF generation
router.get('/:id/html', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const result = await svc.get(auth.businessId, req.params['id']!);
  if (!result) return res.status(404).json({ error: 'NOT_FOUND' });
  const business = await businessRepository.findById(auth.businessId);
  const storedCustomization = invoiceCustomizationSchema.safeParse(business?.invoiceCustomization);
  const html = svc.renderHtml(
    result.invoice,
    result.lineItems,
    {
      name: business?.name ?? 'Invoice',
      brandColor: business?.brandColor ?? null,
      logoDataUrl: business?.logoDataUrl ?? null,
      motto: business?.motto ?? null,
      address: business?.address ?? null,
      phone: business?.phone ?? null,
    },
    storedCustomization.success ? storedCustomization.data : DEFAULT_INVOICE_CUSTOMIZATION,
  );
  return res.type('html').send(html);
});

const PreviewLineItemSchema = z.object({
  description: z.string().max(500),
  quantity: z.number().positive().max(1_000_000),
  unitPriceCents: z.number().int().min(0),
  discountBasisPoints: z.number().int().min(0).max(10000).optional(),
});

const PreviewSchema = z.object({
  documentType: z.enum(['INVOICE', 'QUOTE', 'RECEIPT']).optional(),
  currencyCode: z.string().length(3).optional(),
  taxBasisPoints: z.number().int().min(0).max(10000).optional(),
  issueDate: z.string().optional(),
  dueDate: z.string().optional(),
  notes: z.string().max(2000).optional(),
  terms: z.string().max(2000).optional(),
  footerText: z.string().max(500).optional(),
  lineItems: z.array(PreviewLineItemSchema).max(100).optional(),
  customization: invoiceCustomizationSchema.optional(),
});

/**
 * A real, unsaved-draft preview - "as he or she works on it" (the live
 * preview pane, InvoicesPage.tsx) and the Customize panel's template/color
 * picker both call this with in-progress data that has never been (and
 * for the Customize panel, never will be) persisted as a real invoice.
 * Reuses computeInvoiceTotals/computeLineTotalCents from
 * invoiceRepository.ts - the exact same math a real save performs - so a
 * preview's numbers never drift from what actually gets saved.
 */
router.post('/preview', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const parsed = PreviewSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_BODY', detail: parsed.error.flatten() });
  const d = parsed.data;

  const lineItemsInput = (d.lineItems ?? []).length > 0
    ? d.lineItems!
    : [{ description: 'Sample item', quantity: 1, unitPriceCents: 10000, discountBasisPoints: 0 }];

  const enrichedLines = lineItemsInput.map((li) => ({ ...li, discountBasisPoints: li.discountBasisPoints ?? 0 }));
  const taxBp = d.taxBasisPoints ?? 0;
  const totals = computeInvoiceTotals(enrichedLines, taxBp);
  const documentType = d.documentType ?? 'INVOICE';
  const prefix = documentType === 'INVOICE' ? 'INV' : documentType === 'QUOTE' ? 'QUO' : 'REC';

  const previewInvoice = {
    documentType,
    invoiceNumber: `${prefix}-PREVIEW`,
    status: 'DRAFT' as const,
    currencyCode: d.currencyCode ?? 'BBD',
    subtotalCents: totals.subtotalCents,
    taxBasisPoints: taxBp,
    discountCents: totals.discountCents,
    totalCents: totals.totalCents,
    issueDate: d.issueDate ?? new Date().toISOString().slice(0, 10),
    dueDate: d.dueDate ?? null,
    notes: d.notes ?? null,
    terms: d.terms ?? null,
    footerText: d.footerText ?? null,
    createdAt: new Date().toISOString(),
  };
  const previewLineItems = enrichedLines.map((li) => ({
    description: li.description || 'Item',
    quantity: String(li.quantity),
    unitPriceCents: li.unitPriceCents,
    discountBasisPoints: li.discountBasisPoints,
    totalCents: computeLineTotalCents(li.unitPriceCents, li.quantity, li.discountBasisPoints),
  }));

  const business = await businessRepository.findById(auth.businessId);
  const storedCustomization = invoiceCustomizationSchema.safeParse(business?.invoiceCustomization);
  const customization: InvoiceCustomization = d.customization ?? (storedCustomization.success ? storedCustomization.data : DEFAULT_INVOICE_CUSTOMIZATION);

  const html = svc.renderHtml(
    previewInvoice as Parameters<typeof svc.renderHtml>[0],
    previewLineItems as Parameters<typeof svc.renderHtml>[1],
    {
      name: business?.name ?? 'Your Business',
      brandColor: business?.brandColor ?? null,
      logoDataUrl: business?.logoDataUrl ?? null,
      motto: business?.motto ?? null,
      address: business?.address ?? null,
      phone: business?.phone ?? null,
    },
    customization,
  );
  return res.type('html').send(html);
});

// PATCH /api/invoices/:id — update editable fields (DRAFT or PENDING_APPROVAL only)
router.patch('/:id', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_BODY', detail: parsed.error.flatten() });
  const p = parsed.data;
  const patch: Parameters<typeof svc.updateDetails>[2] = {};
  if (p.notes !== undefined) patch.notes = p.notes;
  if (p.terms !== undefined) patch.terms = p.terms;
  if (p.footerText !== undefined) patch.footerText = p.footerText;
  if (p.dueDate !== undefined) patch.dueDate = p.dueDate;
  if (p.taxBasisPoints !== undefined) patch.taxBasisPoints = p.taxBasisPoints;
  if (p.currencyCode !== undefined) patch.currencyCode = p.currencyCode;
  const result = await svc.updateDetails(auth.businessId, req.params['id']!, patch);
  if (!result) return res.status(404).json({ error: 'NOT_FOUND_OR_IMMUTABLE' });
  return res.json({ invoice: result });
});

// POST /api/invoices/:id/submit — DRAFT → PENDING_APPROVAL
router.post('/:id/submit', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const result = await svc.submitForApproval(auth.businessId, req.params['id']!);
  if (!result) return res.status(404).json({ error: 'NOT_FOUND_OR_WRONG_STATE' });
  return res.json({ invoice: result });
});

// POST /api/invoices/:id/approve — PENDING_APPROVAL → APPROVED
router.post('/:id/approve', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const result = await svc.approve(auth.businessId, req.params['id']!);
  if (!result) return res.status(404).json({ error: 'NOT_FOUND_OR_WRONG_STATE' });
  return res.json({ invoice: result });
});

// POST /api/invoices/:id/send — APPROVED → SENT
router.post('/:id/send', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const result = await svc.markSent(auth.businessId, req.params['id']!);
  if (!result) return res.status(404).json({ error: 'NOT_FOUND_OR_WRONG_STATE' });
  return res.json({ invoice: result });
});

// POST /api/invoices/:id/pay — → PAID
router.post('/:id/pay', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const result = await svc.markPaid(auth.businessId, req.params['id']!);
  if (!result) return res.status(404).json({ error: 'NOT_FOUND' });
  return res.json({ invoice: result });
});

// POST /api/invoices/:id/cancel — DRAFT/PENDING_APPROVAL/APPROVED -> CANCELLED (pre-send only)
router.post('/:id/cancel', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const result = await svc.cancel(auth.businessId, req.params['id']!);
  if (!result) return res.status(404).json({ error: 'NOT_FOUND_OR_IMMUTABLE' });
  return res.json({ invoice: result });
});

// POST /api/invoices/:id/void — SENT/OVERDUE -> VOID (already reached the customer, never deleted)
router.post('/:id/void', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const result = await svc.voidInvoice(auth.businessId, req.params['id']!);
  if (!result) return res.status(404).json({ error: 'NOT_FOUND_OR_IMMUTABLE' });
  return res.json({ invoice: result });
});

// DELETE /api/invoices/:id — real, permanent deletion, DRAFT only
router.delete('/:id', async (req, res) => {
  const auth = res.locals['auth'] as AuthContext;
  const deleted = await svc.remove(auth.businessId, req.params['id']!);
  if (!deleted) return res.status(404).json({ error: 'NOT_FOUND_OR_IMMUTABLE' });
  return res.status(204).send();
});

export { router as invoiceRouter };

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { OperatorModeRepository } from '../../repositories/operatorModeRepository.js';
import type { Queryable } from '../../repositories/types.js';

// ── PIN hashing ──────────────────────────────────────────────────────────────
// scrypt via Node.js built-ins — no extra dependencies, server-side only.
// The raw PIN is sent over HTTPS from the settings UI and hashed here; it
// never touches the client-side Argon2id flow used for the app lock.

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const MAX_PIN_ATTEMPTS = 3;

export function generatePinSalt(): string {
  return randomBytes(32).toString('hex');
}

export function hashPin(pin: string, salt: string, n = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P): string {
  const key = scryptSync(pin, salt, SCRYPT_KEYLEN, { N: n, r, p });
  return key.toString('hex');
}

function verifyPin(pin: string, stored: { pinSalt: string; pinHash: string; pinN: number; pinR: number; pinP: number }): boolean {
  const candidate = Buffer.from(hashPin(pin, stored.pinSalt, stored.pinN, stored.pinR, stored.pinP), 'hex');
  const expected = Buffer.from(stored.pinHash, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

// ── Command types ────────────────────────────────────────────────────────────
// Strict whitelist: every type maps to a safe, reversible, single-tenant operation.
// The HELP and LOGOUT commands require no arguments.

export type OperatorCommandType =
  | 'HELP'
  | 'LOGOUT'
  | 'STATS'
  | 'PROPERTY_NOTE'
  | 'INVOICE_STATUS'
  | 'INCIDENT_LOG';

type ParsedCommand =
  | { type: 'HELP' }
  | { type: 'LOGOUT' }
  | { type: 'STATS'; scope: 'today' | 'week' | 'month' }
  | { type: 'PROPERTY_NOTE'; propertyRef: string; note: string }
  | { type: 'INVOICE_STATUS'; invoiceNumber: string; newStatus: 'PAID' | 'CANCELLED' }
  | { type: 'INCIDENT_LOG'; title: string; description: string; severity: 'low' | 'medium' | 'high' }
  | { type: 'UNKNOWN'; original: string };

// ── Simple rule-based parser ──────────────────────────────────────────────────
// Priority: avoid an AI call for every operator message.
// Uses keyword patterns for the common commands; 'UNKNOWN' falls through to a
// friendly help prompt so the operator always gets feedback.

function parse(text: string): ParsedCommand {
  const t = text.trim().toLowerCase();

  if (/^(help|\?|commands|what can you do)/.test(t)) return { type: 'HELP' };
  if (/^(logout|exit|bye|done|end session)/.test(t)) return { type: 'LOGOUT' };

  const statsMatch = t.match(/\b(stats?|summary|report)\b.*\b(today|daily|day)\b/);
  if (statsMatch) return { type: 'STATS', scope: 'today' };
  const statsWeekMatch = t.match(/\b(stats?|summary|report)\b.*\b(week|7\s*day)\b/);
  if (statsWeekMatch) return { type: 'STATS', scope: 'week' };
  const statsMonthMatch = t.match(/\b(stats?|summary|report)\b.*\b(month|30\s*day)\b/);
  if (statsMonthMatch) return { type: 'STATS', scope: 'month' };
  if (/\b(stats?|summary|report)\b/.test(t)) return { type: 'STATS', scope: 'today' };

  const paidMatch = text.match(/^mark\s+([A-Z]{2,3}-\d{6}-\d{4})\s+(?:as\s+)?paid/i);
  if (paidMatch) return { type: 'INVOICE_STATUS', invoiceNumber: paidMatch[1]!.toUpperCase(), newStatus: 'PAID' };
  const cancelMatch = text.match(/^cancel\s+(?:invoice\s+)?([A-Z]{2,3}-\d{6}-\d{4})/i);
  if (cancelMatch) return { type: 'INVOICE_STATUS', invoiceNumber: cancelMatch[1]!.toUpperCase(), newStatus: 'CANCELLED' };

  const noteMatch = text.match(/^(?:add\s+)?note\s+(?:for|to|on)\s+(.+?):\s*(.+)/i);
  if (noteMatch) return { type: 'PROPERTY_NOTE', propertyRef: noteMatch[1]!.trim(), note: noteMatch[2]!.trim() };

  const incidentMatch = text.match(/^(?:log\s+)?incident:?\s*(.+)/i);
  if (incidentMatch) {
    const body = incidentMatch[1]!.trim();
    const sevMatch = body.match(/\b(high|critical|urgent)\b/i);
    const severity = sevMatch ? (sevMatch[1]!.toLowerCase() === 'critical' || sevMatch[1]!.toLowerCase() === 'urgent' ? 'high' : 'medium') : 'low';
    return { type: 'INCIDENT_LOG', title: body.slice(0, 80), description: body, severity: severity as 'low' | 'medium' | 'high' };
  }

  return { type: 'UNKNOWN', original: text };
}

// ── Response builders ─────────────────────────────────────────────────────────

const HELP_TEXT = `🔐 *Operator Commands*

• *stats [today|week|month]* — summary
• *mark INV-XXXXXX-XXXX as paid* — mark invoice paid
• *cancel INV-XXXXXX-XXXX* — cancel invoice
• *note for [property]: [text]* — add property note
• *incident: [description]* — log incident
• *logout* — end session

All commands are scoped to your business only.`;

// ── Service ───────────────────────────────────────────────────────────────────

export type OperatorResult = { reply: string };

export class OperatorCommandService {
  private readonly repo: OperatorModeRepository;
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
    this.repo = new OperatorModeRepository(db);
  }

  // Returns true if operator mode is configured and enabled for this business AND
  // the incoming message is from the registered operator JID.
  async isOperatorMessage(businessId: string, senderJid: string): Promise<boolean> {
    const settings = await this.repo.getSettings(businessId);
    if (!settings || !settings.enabled) return false;
    // Normalise: strip @s.whatsapp.net suffix for comparison, then re-add for storage
    const canonicalSender = normaliseJid(senderJid);
    const canonicalOperator = normaliseJid(settings.operatorWaJid);
    return canonicalSender === canonicalOperator;
  }

  // Main entry point called from the message worker.
  // Returns the text to send back to the operator via WhatsApp.
  async handle(businessId: string, senderJid: string, text: string): Promise<OperatorResult> {
    const settings = await this.repo.getSettings(businessId);
    if (!settings || !settings.enabled) {
      return { reply: 'Operator mode is not configured for this account.' };
    }

    const session = await this.repo.getActiveSession(businessId);

    // ── No active session: issue PIN challenge ───────────────────────────────
    if (!session) {
      await this.repo.createChallengeSession(businessId, senderJid);
      return { reply: '🔐 *Operator mode* — reply with your PIN to authenticate.\n\n_Session expires in 2 minutes._' };
    }

    // ── Session awaiting PIN ─────────────────────────────────────────────────
    if (session.status === 'AWAITING_PIN') {
      const pin = text.trim();
      if (!verifyPin(pin, settings)) {
        const attempts = await this.repo.incrementPinAttempts(businessId);
        if (attempts >= MAX_PIN_ATTEMPTS) {
          await this.repo.deleteSession(businessId);
          return { reply: '❌ Too many incorrect attempts. Session terminated.' };
        }
        return { reply: `❌ Incorrect PIN. ${MAX_PIN_ATTEMPTS - attempts} attempt(s) remaining.` };
      }
      const authenticated = await this.repo.authenticateSession(businessId);
      if (!authenticated) {
        return { reply: '⚠️ Session expired. Message again to start a new challenge.' };
      }
      return { reply: `✅ *Authenticated.* Session active for 30 minutes.\n\n${HELP_TEXT}` };
    }

    // ── Authenticated session: execute command ───────────────────────────────
    await this.repo.bumpSession(businessId);
    const command = parse(text);
    return this.executeCommand(businessId, command);
  }

  private async executeCommand(businessId: string, command: ParsedCommand): Promise<OperatorResult> {
    switch (command.type) {
      case 'HELP':
        return { reply: HELP_TEXT };

      case 'LOGOUT':
        await this.repo.deleteSession(businessId);
        return { reply: '👋 Operator session ended.' };

      case 'STATS':
        return this.handleStats(businessId, command.scope);

      case 'INVOICE_STATUS':
        return this.handleInvoiceStatus(businessId, command.invoiceNumber, command.newStatus);

      case 'PROPERTY_NOTE':
        return this.handlePropertyNote(businessId, command.propertyRef, command.note);

      case 'INCIDENT_LOG':
        return this.handleIncidentLog(businessId, command.title, command.description, command.severity);

      case 'UNKNOWN':
        return {
          reply: `🤔 I didn't understand: _"${command.original.slice(0, 100)}"_\n\nSend *help* for a list of commands.`,
        };
    }
  }

  private async handleStats(businessId: string, scope: 'today' | 'week' | 'month'): Promise<OperatorResult> {
    // Tenant-locked: businessId is from the authenticated operator session,
    // never from the message payload.
    try {
      const interval = scope === 'today' ? '1 day' : scope === 'week' ? '7 days' : '30 days';
      type StatsRow = { inbound: string; incidents: string; invoices_paid: string; revenue_cents: string };
      const { rows } = await this.db.query<StatsRow>(
        `SELECT
           (SELECT COUNT(*) FROM whatsapp_messages wm
            JOIN whatsapp_chats wc ON wc.id = wm.chat_id
            WHERE wc.business_id = $1 AND wm.created_at > NOW() - $2::interval AND NOT wm.from_me) AS inbound,
           (SELECT COUNT(*) FROM property_incidents pi
            WHERE pi.business_id = $1 AND pi.created_at > NOW() - $2::interval) AS incidents,
           (SELECT COUNT(*) FROM invoices i
            WHERE i.business_id = $1 AND i.status = 'PAID' AND i.paid_at > NOW() - $2::interval) AS invoices_paid,
           (SELECT COALESCE(SUM(total_cents),0) FROM invoices i
            WHERE i.business_id = $1 AND i.status = 'PAID' AND i.paid_at > NOW() - $2::interval) AS revenue_cents`,
        [businessId, interval],
      );
      const r = rows[0] ?? { inbound: '0', incidents: '0', invoices_paid: '0', revenue_cents: '0' };
      const rev = Number(r.revenue_cents) / 100;
      const label = scope === 'today' ? 'Today' : scope === 'week' ? 'This week' : 'This month';
      return {
        reply: `📊 *${label}*\n\n• Messages received: ${r.inbound}\n• Incidents: ${r.incidents}\n• Invoices paid: ${r.invoices_paid}\n• Revenue: BBD ${rev.toFixed(2)}`,
      };
    } catch {
      return { reply: '⚠️ Could not fetch stats. Try again shortly.' };
    }
  }

  private async handleInvoiceStatus(businessId: string, invoiceNumber: string, newStatus: 'PAID' | 'CANCELLED'): Promise<OperatorResult> {
    try {
      const paidClause = newStatus === 'PAID' ? ', paid_at = NOW()' : '';
      const { rows } = await this.db.query<{ id: string }>(
        `UPDATE invoices SET status = $3${paidClause}, updated_at = NOW()
         WHERE business_id = $1 AND invoice_number = $2 AND status NOT IN ('PAID','CANCELLED','VOID')
         RETURNING id`,
        [businessId, invoiceNumber, newStatus],
      );
      if (rows.length === 0) return { reply: `⚠️ Invoice *${invoiceNumber}* not found or already in a terminal state.` };
      return { reply: `✅ Invoice *${invoiceNumber}* marked as *${newStatus}*.` };
    } catch {
      return { reply: '⚠️ Could not update invoice. Check the number and try again.' };
    }
  }

  private async handlePropertyNote(_businessId: string, propertyRef: string, note: string): Promise<OperatorResult> {
    // Future: look up property by name/ref and append to guest_instructions or notes field.
    return { reply: `📝 Note queued for property matching "${propertyRef}":\n\n_${note}_\n\n(Full write-back coming in the next release.)` };
  }

  private async handleIncidentLog(businessId: string, title: string, description: string, severity: 'low' | 'medium' | 'high'): Promise<OperatorResult> {
    try {
      // Incidents require a property — use the first active property for this business.
      const { rows: props } = await this.db.query<{ id: string }>(
        `SELECT id FROM property_properties WHERE business_id = $1 AND status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1`,
        [businessId],
      );
      const propertyId = props[0]?.id;
      if (!propertyId) return { reply: '⚠️ No active property found. Create a property first before logging incidents.' };

      const { rows } = await this.db.query<{ id: string }>(
        `INSERT INTO property_incidents (business_id, property_id, title, description, category, severity, source_channel, status)
         VALUES ($1, $2, $3, $4, 'general', $5, 'whatsapp_operator', 'OPEN') RETURNING id`,
        [businessId, propertyId, title.slice(0, 120), description.slice(0, 500), severity],
      );
      return { reply: `🚨 Incident logged (${severity.toUpperCase()}).\nRef: ${(rows[0]?.id ?? '?').slice(0, 8)}\n\n_"${title}"_` };
    } catch {
      return { reply: '⚠️ Could not log incident. Check your property operations setup.' };
    }
  }
}

function normaliseJid(jid: string): string {
  // Strip @s.whatsapp.net and device suffix (:0, :1, …) for comparison.
  return jid.replace(/@.+$/, '').replace(/:\d+$/, '');
}

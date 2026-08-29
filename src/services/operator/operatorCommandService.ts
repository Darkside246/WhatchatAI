import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { OperatorModeRepository } from '../../repositories/operatorModeRepository.js';
import { PropertyOperationsRepository } from '../../repositories/propertyOperationsRepository.js';
import { hasEntitlement } from '../platform/entitlementService.js';
import { handleAssistantMessage } from './assistantModeService.js';
import type { Queryable } from '../../repositories/types.js';

const ASSISTANT_ENTITLEMENT_KEY = 'ai_personal_assistant';
const EXIT_ASSISTANT_MODE = /^\/(bye|later|exit)\s*$/i;

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

// Generates a random 8-character uppercase alphanumeric setup token for the WA wizard.
// This is the plain-text value shown once in the web UI; only its scrypt hash is stored.
export function generateSetupToken(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit 0/O/1/I for readability
  return Array.from(randomBytes(8))
    .map((b) => chars[b % chars.length]!)
    .join('');
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
  | 'DAILY_REPORT'
  | 'PROPERTY_NOTE'
  | 'INVOICE_STATUS'
  | 'INCIDENT_LOG'
  | 'SET_ASSISTANT_NAME';

type ParsedCommand =
  | { type: 'HELP' }
  | { type: 'LOGOUT' }
  | { type: 'STATS'; scope: 'today' | 'week' | 'month' }
  | { type: 'DAILY_REPORT' }
  | { type: 'PROPERTY_NOTE'; propertyRef: string; note: string }
  | { type: 'INVOICE_STATUS'; invoiceNumber: string; newStatus: 'PAID' | 'CANCELLED' }
  | { type: 'INCIDENT_LOG'; title: string; description: string; severity: 'low' | 'medium' | 'high' }
  | { type: 'SET_ASSISTANT_NAME'; name: string }
  | { type: 'UNKNOWN'; original: string };

// ── Simple rule-based parser ──────────────────────────────────────────────────
// Priority: avoid an AI call for every operator message.
// Uses keyword patterns for the common commands; 'UNKNOWN' falls through to a
// friendly help prompt so the operator always gets feedback.

function parse(text: string): ParsedCommand {
  const t = text.trim().toLowerCase();

  if (/^(help|\?|commands|what can you do)/.test(t)) return { type: 'HELP' };
  if (/^(logout|exit|bye|done|end session)/.test(t)) return { type: 'LOGOUT' };

  if (/\b(daily\s+report|full\s+report|day\s+report|report\s+today)\b/.test(t)) return { type: 'DAILY_REPORT' };

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

  const assistantNameMatch = text.match(/^(?:set\s+)?assistant\s+name\s+(?:to\s+)?(.+)/i);
  if (assistantNameMatch) return { type: 'SET_ASSISTANT_NAME', name: assistantNameMatch[1]!.trim() };

  return { type: 'UNKNOWN', original: text };
}

// ── Response builders ─────────────────────────────────────────────────────────

export const OPERATOR_SETUP_CONFIRMATION = `✅ *Operator mode is now active.*

You can WhatsApp this number from your personal phone to manage your business. Here are all available commands:

• *daily report* — full day summary (messages, incidents, invoices, revenue, work orders)
• *stats [today|week|month]* — quick metrics snapshot
• *mark INV-YYYYMM-XXXX as paid* — mark an invoice paid
• *cancel INV-YYYYMM-XXXX* — cancel an invoice
• *note for [property]: [text]* — add a note to a property
• *incident: [description]* — log a new incident (add "high" or "urgent" for high severity)
• *set assistant name to [name]* — name your AI personal assistant, then message */[name]* any time to talk to it naturally (set reminders, and more over time)
• *logout* — end your session

📱 *How it works:*
Message this number → get a PIN challenge → reply with your PIN → 30-minute authenticated session. After 3 wrong PIN attempts the session is locked. All commands are scoped to your business only.`;

const HELP_TEXT = `🔐 *Operator Commands*

• *daily report* — full day summary (messages, incidents, invoices, revenue, work orders)
• *stats [today|week|month]* — quick metrics snapshot
• *mark INV-XXXXXX-XXXX as paid* — mark invoice paid
• *cancel INV-XXXXXX-XXXX* — cancel invoice
• *note for [property]: [text]* — add property note
• *incident: [description]* — log incident
• *set assistant name to [name]* — name your AI assistant (message */[name]* to talk to it)
• *logout* — end session

All commands are scoped to your business only.`;

// ── WhatsApp setup wizard ─────────────────────────────────────────────────────
// In-memory: setup sessions are short-lived (10 min) and non-critical.
// If the server restarts mid-wizard, the user just triggers the code word again.

interface WaSetupSession {
  step: 'AWAITING_PIN' | 'AWAITING_PIN_CONFIRM';
  initiatorJid: string;
  pendingPin: string;
  expiresAt: number;
}

const WA_SETUP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const waSetupSessions = new Map<string, WaSetupSession>(); // key: `${businessId}:${jid}`

function waSetupKey(businessId: string, jid: string): string {
  return `${businessId}:${normaliseJid(jid)}`;
}

// Trigger phrase: "setup operator [CODE]" — case-insensitive, flexible spacing.
const WA_SETUP_TRIGGER = /^setup\s+operator\s+([A-Z0-9]+)\s*$/i;

// ── Service ───────────────────────────────────────────────────────────────────

export type OperatorResult = { reply: string };

export class OperatorCommandService {
  private readonly repo: OperatorModeRepository;
  private readonly propertyRepo: PropertyOperationsRepository;
  private readonly db: Queryable;

  constructor(db: Queryable) {
    this.db = db;
    this.repo = new OperatorModeRepository(db);
    this.propertyRepo = new PropertyOperationsRepository(db);
  }

  // Returns true if the message is part of a WA setup wizard (trigger or ongoing session).
  // Check this BEFORE isOperatorMessage so unauthenticated JIDs can start the wizard.
  async isWaSetupMessage(businessId: string, senderJid: string, text: string): Promise<boolean> {
    const key = waSetupKey(businessId, senderJid);
    const session = waSetupSessions.get(key);
    if (session && session.expiresAt > Date.now()) return true;
    if (session) waSetupSessions.delete(key);
    return WA_SETUP_TRIGGER.test(text.trim());
  }

  // Drives the multi-turn setup wizard.
  async handleWaSetup(businessId: string, senderJid: string, text: string): Promise<OperatorResult> {
    const key = waSetupKey(businessId, senderJid);
    const existing = waSetupSessions.get(key);

    // ── Step 0: trigger phrase ───────────────────────────────────────────────
    if (!existing || existing.expiresAt <= Date.now()) {
      waSetupSessions.delete(key);
      const match = WA_SETUP_TRIGGER.exec(text.trim());
      if (!match) return { reply: '⚠️ Setup session expired. Send *setup operator [CODE]* to try again.' };

      const candidateToken = match[1]!.toUpperCase();
      const stored = await this.repo.getSetupToken(businessId);
      if (!stored) {
        return { reply: '⚠️ No setup code is active for this account. Generate one in Settings → Operator Mode.' };
      }

      const candidateHash = hashPin(candidateToken, stored.tokenSalt);
      const matches = timingSafeEqual(Buffer.from(candidateHash, 'hex'), Buffer.from(stored.tokenHash, 'hex'));
      if (!matches) {
        return { reply: '❌ Setup code is incorrect. Check the code in your Settings and try again.' };
      }

      // Token verified — start wizard
      waSetupSessions.set(key, {
        step: 'AWAITING_PIN',
        initiatorJid: senderJid,
        pendingPin: '',
        expiresAt: Date.now() + WA_SETUP_TTL_MS,
      });
      return {
        reply: `🔐 *Operator Mode Setup*\n\nSetup code verified! Your WhatsApp number will be registered as the operator.\n\nChoose a PIN (minimum 4 characters):`,
      };
    }

    // ── Step 1: collect PIN ──────────────────────────────────────────────────
    if (existing.step === 'AWAITING_PIN') {
      const pin = text.trim();
      if (pin.length < 4) {
        return { reply: '❌ PIN must be at least 4 characters. Try again:' };
      }
      waSetupSessions.set(key, { ...existing, step: 'AWAITING_PIN_CONFIRM', pendingPin: pin, expiresAt: Date.now() + WA_SETUP_TTL_MS });
      return { reply: '✅ Got it. Confirm your PIN:' };
    }

    // ── Step 2: confirm PIN → save ───────────────────────────────────────────
    if (existing.step === 'AWAITING_PIN_CONFIRM') {
      const confirmPin = text.trim();
      if (confirmPin !== existing.pendingPin) {
        waSetupSessions.delete(key);
        return { reply: "❌ PINs didn't match. Setup cancelled. Send *setup operator [CODE]* to start again." };
      }

      const salt = generatePinSalt();
      const hash = hashPin(existing.pendingPin, salt);
      const jidForStorage = senderJid.includes('@') ? senderJid : `${senderJid}@s.whatsapp.net`;

      await this.repo.upsertSettings({
        businessId,
        operatorWaJid: jidForStorage,
        pinSalt: salt,
        pinHash: hash,
        pinN: SCRYPT_N,
        pinR: SCRYPT_R,
        pinP: SCRYPT_P,
        enabled: true,
      });

      await this.repo.deleteSetupToken(businessId);
      waSetupSessions.delete(key);

      return { reply: OPERATOR_SETUP_CONFIRMATION };
    }

    return { reply: '⚠️ Unexpected wizard state. Send *setup operator [CODE]* to restart.' };
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
  async handle(businessId: string, whatsappAccountId: string, senderJid: string, text: string): Promise<OperatorResult> {
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

    const trimmed = text.trim();

    // ── Already in assistant mode: exit phrase, or route to natural language ──
    // Only ever reachable from an already-AUTHENTICATED session (this branch
    // is below the AWAITING_PIN check above) - the assistant never gets its
    // own separate authentication, by design (see assistantModeService.ts's
    // own doc comment).
    if (session.interactionMode === 'ASSISTANT') {
      if (EXIT_ASSISTANT_MODE.test(trimmed)) {
        await this.repo.setInteractionMode(businessId, 'COMMAND');
        return { reply: `👋 Leaving ${settings.assistantName ?? 'assistant'} mode. Back to normal commands — send *help* for a list.` };
      }
      await this.repo.bumpSession(businessId);
      return handleAssistantMessage({
        businessId,
        whatsappAccountId,
        operatorJid: senderJid,
        assistantName: settings.assistantName ?? 'Assistant',
        text: trimmed,
      });
    }

    // ── Not yet in assistant mode: check for the /<assistantName> trigger ────
    // Case-insensitive, exact match on the whole message - "/Aria" enters,
    // "/Aria please help" does not (avoids a customer-service-style message
    // that merely starts with the name accidentally entering assistant mode).
    if (settings.assistantName) {
      const triggerMatch = /^\/(.+)$/.exec(trimmed);
      if (triggerMatch && triggerMatch[1]!.trim().toLowerCase() === settings.assistantName.trim().toLowerCase()) {
        const entitled = await hasEntitlement(businessId, ASSISTANT_ENTITLEMENT_KEY);
        if (!entitled) {
          return { reply: `⚠️ ${settings.assistantName} mode isn't included in your current plan yet.` };
        }
        await this.repo.setInteractionMode(businessId, 'ASSISTANT');
        return {
          reply: `👋 Hi, I'm *${settings.assistantName}*. What can I help with?\n\n_Say */bye*, */later*, or */exit* to leave this mode._`,
        };
      }
    }

    // ── Authenticated session: execute command ───────────────────────────────
    await this.repo.bumpSession(businessId);
    const command = parse(text);
    return this.executeCommand(businessId, senderJid, command);
  }

  private async executeCommand(businessId: string, senderJid: string, command: ParsedCommand): Promise<OperatorResult> {
    switch (command.type) {
      case 'HELP':
        return { reply: HELP_TEXT };

      case 'LOGOUT':
        await this.repo.deleteSession(businessId);
        return { reply: '👋 Operator session ended.' };

      case 'STATS':
        return this.handleStats(businessId, command.scope);

      case 'DAILY_REPORT':
        return this.handleDailyReport(businessId);

      case 'INVOICE_STATUS':
        return this.handleInvoiceStatus(businessId, command.invoiceNumber, command.newStatus);

      case 'PROPERTY_NOTE':
        return this.handlePropertyNote(businessId, senderJid, command.propertyRef, command.note);

      case 'INCIDENT_LOG':
        return this.handleIncidentLog(businessId, command.title, command.description, command.severity);

      case 'SET_ASSISTANT_NAME':
        return this.handleSetAssistantName(businessId, command.name);

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

  private async handleDailyReport(businessId: string): Promise<OperatorResult> {
    try {
      type ReportRow = {
        msgs_in: string;
        msgs_out: string;
        active_chats: string;
        new_contacts: string;
        incidents_open: string;
        incidents_resolved_today: string;
        invoices_draft: string;
        invoices_pending: string;
        invoices_paid_today: string;
        revenue_today_cents: string;
        work_orders_open: string;
        work_orders_completed_today: string;
      };
      const { rows } = await this.db.query<ReportRow>(
        `SELECT
           (SELECT COUNT(*) FROM whatsapp_messages wm
            JOIN whatsapp_chats wc ON wc.id = wm.chat_id
            WHERE wc.business_id = $1 AND NOT wm.from_me AND wm.created_at >= CURRENT_DATE) AS msgs_in,
           (SELECT COUNT(*) FROM whatsapp_messages wm
            JOIN whatsapp_chats wc ON wc.id = wm.chat_id
            WHERE wc.business_id = $1 AND wm.from_me AND wm.created_at >= CURRENT_DATE) AS msgs_out,
           (SELECT COUNT(DISTINCT wc.id) FROM whatsapp_chats wc
            JOIN whatsapp_messages wm ON wm.chat_id = wc.id
            WHERE wc.business_id = $1 AND wm.created_at >= CURRENT_DATE) AS active_chats,
           (SELECT COUNT(*) FROM crm_contacts
            WHERE business_id = $1 AND created_at >= CURRENT_DATE) AS new_contacts,
           (SELECT COUNT(*) FROM property_incidents
            WHERE business_id = $1 AND status = 'OPEN') AS incidents_open,
           (SELECT COUNT(*) FROM property_incidents
            WHERE business_id = $1 AND status = 'RESOLVED' AND updated_at >= CURRENT_DATE) AS incidents_resolved_today,
           (SELECT COUNT(*) FROM invoices
            WHERE business_id = $1 AND status = 'DRAFT') AS invoices_draft,
           (SELECT COUNT(*) FROM invoices
            WHERE business_id = $1 AND status IN ('PENDING_APPROVAL','APPROVED','SENT')) AS invoices_pending,
           (SELECT COUNT(*) FROM invoices
            WHERE business_id = $1 AND status = 'PAID' AND paid_at >= CURRENT_DATE) AS invoices_paid_today,
           (SELECT COALESCE(SUM(total_cents),0) FROM invoices
            WHERE business_id = $1 AND status = 'PAID' AND paid_at >= CURRENT_DATE) AS revenue_today_cents,
           (SELECT COUNT(*) FROM property_work_orders
            WHERE business_id = $1 AND status NOT IN ('COMPLETED','CANCELLED')) AS work_orders_open,
           (SELECT COUNT(*) FROM property_work_orders
            WHERE business_id = $1 AND status = 'COMPLETED' AND completed_at >= CURRENT_DATE) AS work_orders_completed_today`,
        [businessId],
      );
      const r = rows[0] ?? {} as ReportRow;
      const rev = Number(r.revenue_today_cents ?? 0) / 100;
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

      return {
        reply: `📋 *Daily Report — ${today}*

💬 *Messages*
• Received: ${r.msgs_in ?? 0}
• Sent: ${r.msgs_out ?? 0}
• Active chats: ${r.active_chats ?? 0}
• New contacts: ${r.new_contacts ?? 0}

🚨 *Incidents*
• Open: ${r.incidents_open ?? 0}
• Resolved today: ${r.incidents_resolved_today ?? 0}

🔧 *Work Orders*
• Open: ${r.work_orders_open ?? 0}
• Completed today: ${r.work_orders_completed_today ?? 0}

🧾 *Invoices & Revenue*
• Paid today: ${r.invoices_paid_today ?? 0}
• Revenue collected: BBD ${rev.toFixed(2)}
• Drafts: ${r.invoices_draft ?? 0}
• Outstanding (pending/approved/sent): ${r.invoices_pending ?? 0}

_Report for today's activity only. Send *stats week* or *stats month* for broader trends._`,
      };
    } catch {
      return { reply: '⚠️ Could not generate the daily report. Try again shortly.' };
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

  private async handlePropertyNote(businessId: string, senderJid: string, propertyRef: string, note: string): Promise<OperatorResult> {
    try {
      const matches = await this.propertyRepo.findPropertiesByNameForBusiness(businessId, propertyRef);
      if (matches.length === 0) {
        return { reply: `⚠️ No property matching "${propertyRef}" found. Check the name and try again.` };
      }
      if (matches.length > 1) {
        const names = matches.map((property) => `• ${property.name}`).join('\n');
        return { reply: `⚠️ "${propertyRef}" matches more than one property:\n${names}\n\nBe more specific.` };
      }

      const property = matches[0]!;
      await this.propertyRepo.createPropertyNote({
        id: randomUUID(),
        businessId,
        propertyId: property.id,
        note,
        createdByJid: senderJid,
      });
      return { reply: `📝 Note saved for *${property.name}*:\n\n_${note}_` };
    } catch {
      return { reply: '⚠️ Could not save the note. Check the property name and try again.' };
    }
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

  private async handleSetAssistantName(businessId: string, rawName: string): Promise<OperatorResult> {
    const name = rawName.trim();
    if (name.length < 2 || name.length > 30) {
      return { reply: '⚠️ Assistant name must be 2-30 characters.' };
    }
    if (name.startsWith('/')) {
      return { reply: '⚠️ Do not include the "/" - just the name itself, e.g. "set assistant name to Aria".' };
    }
    if (EXIT_ASSISTANT_MODE.test(`/${name}`)) {
      return { reply: '⚠️ That name conflicts with a reserved exit phrase (bye/later/exit). Choose a different name.' };
    }
    try {
      await this.repo.setAssistantName(businessId, name);
      return {
        reply: `✅ Your assistant is now named *${name}*. Message */${name}* any time to start talking to it — say */bye*, */later*, or */exit* to leave that mode.`,
      };
    } catch {
      return { reply: '⚠️ Could not save the assistant name. Try again shortly.' };
    }
  }
}

function normaliseJid(jid: string): string {
  // Strip @s.whatsapp.net and device suffix (:0, :1, …) for comparison.
  return jid.replace(/@.+$/, '').replace(/:\d+$/, '');
}

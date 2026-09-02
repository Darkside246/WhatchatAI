import type { Queryable } from './types.js';
import type { WhatsAppJidKind } from '../domain/whatsapp/jid.js';
import type { ChatType } from '../domain/whatsapp/types.js';

export type ChatAiMode = 'AI_ACTIVE' | 'AI_PAUSED' | 'HUMAN_TAKEOVER';
export type GroupParticipationMode = 'AUTO' | 'MENTIONS_ONLY' | 'ALWAYS_ON' | 'OFF';

export interface WhatsAppChatRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  chatJid: string;
  jidKind: WhatsAppJidKind;
  chatType: ChatType;
  contactId: string | null;
  groupId: string | null;
  name: string | null;
  phoneNumber: string | null;
  isGroup: boolean;
  isArchived: boolean | null;
  isPinned: boolean | null;
  unreadCount: number;
  messageCount: number;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  aiMode: ChatAiMode;
  /**
   * Provenance for the current aiMode value - who/what set it, so an
   * automatic mechanism (the manual-reply-detected auto-pause/resume) can
   * tell its own prior transition apart from a deliberate dashboard action
   * or a separate AI-failure escalation, and never touch the latter two.
   * Null for any transition that predates this column.
   */
  aiModeSource: string | null;
  aiModeSetAt: string | null;
  assigneeUserId: string | null;
  assigneeTeamId: string | null;
  /** Phase 3B debounce watermark: the last inbound message this chat's AI handoff has already considered - see claimAiHandoff/releaseAiHandoff. */
  lastAiHandoffMessageId: string | null;
  /** Phase 3B debounce mutex: non-null while a debounce job is actively generating a reply for this chat - guards against duplicate/stale job delivery. */
  aiHandoffClaimedAt: string | null;
  /** Per-chat override for the group-participation gate (groupParticipationGate.ts). Meaningless for isGroup === false. */
  groupParticipationMode: GroupParticipationMode;
  groupParticipationModeSource: string | null;
  groupParticipationModeSetAt: string | null;
  /** Cooldown watermark: last time the AI actually SENT a reply into this group - distinct from lastAiHandoffMessageId, which tracks "considered," not "spoke." */
  lastAiGroupReplyAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ChatRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  chat_jid: string;
  jid_kind: WhatsAppJidKind;
  chat_type: ChatType;
  contact_id: string | null;
  group_id: string | null;
  name: string | null;
  phone_number: string | null;
  is_group: boolean;
  is_archived: boolean | null;
  is_pinned: boolean | null;
  unread_count: number;
  message_count: number;
  last_message_id: string | null;
  last_message_at: string | null;
  ai_mode: ChatAiMode;
  ai_mode_source: string | null;
  ai_mode_set_at: string | null;
  assignee_user_id: string | null;
  assignee_team_id: string | null;
  last_ai_handoff_message_id: string | null;
  ai_handoff_claimed_at: string | null;
  group_participation_mode: GroupParticipationMode;
  group_participation_mode_source: string | null;
  group_participation_mode_set_at: string | null;
  last_ai_group_reply_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: ChatRow): WhatsAppChatRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    chatJid: row.chat_jid,
    jidKind: row.jid_kind,
    chatType: row.chat_type,
    contactId: row.contact_id,
    groupId: row.group_id,
    name: row.name,
    phoneNumber: row.phone_number,
    isGroup: row.is_group,
    isArchived: row.is_archived,
    isPinned: row.is_pinned,
    unreadCount: row.unread_count,
    messageCount: row.message_count,
    lastMessageId: row.last_message_id,
    lastMessageAt: row.last_message_at,
    aiMode: row.ai_mode,
    aiModeSource: row.ai_mode_source,
    aiModeSetAt: row.ai_mode_set_at,
    assigneeUserId: row.assignee_user_id,
    assigneeTeamId: row.assignee_team_id,
    lastAiHandoffMessageId: row.last_ai_handoff_message_id,
    aiHandoffClaimedAt: row.ai_handoff_claimed_at,
    groupParticipationMode: row.group_participation_mode,
    groupParticipationModeSource: row.group_participation_mode_source,
    groupParticipationModeSetAt: row.group_participation_mode_set_at,
    lastAiGroupReplyAt: row.last_ai_group_reply_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface UpsertChatInput {
  businessId: string;
  whatsappAccountId: string;
  chatJid: string;
  jidKind: WhatsAppJidKind;
  chatType: ChatType;
  contactId?: string | null;
  groupId?: string | null;
  name?: string | null;
  phoneNumber?: string | null;
  unreadCount?: number;
  isArchived?: boolean;
  isPinned?: boolean;
}

export class WhatsAppChatRepository {
  constructor(private readonly db: Queryable) {}

  /** Chat identity is the JID, never the name - a display-name change updates this row in place. */
  async upsertFromWhatsApp(input: UpsertChatInput): Promise<WhatsAppChatRecord> {
    const { rows } = await this.db.query<ChatRow>(
      `INSERT INTO whatsapp_chats
         (business_id, whatsapp_account_id, chat_jid, jid_kind, chat_type,
          contact_id, group_id, name, phone_number, is_group, unread_count, is_archived, is_pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, 0), $12, $13)
       ON CONFLICT (business_id, whatsapp_account_id, chat_jid) WHERE deleted_at IS NULL
       DO UPDATE SET
         contact_id = COALESCE(EXCLUDED.contact_id, whatsapp_chats.contact_id),
         group_id = COALESCE(EXCLUDED.group_id, whatsapp_chats.group_id),
         name = COALESCE(EXCLUDED.name, whatsapp_chats.name),
         phone_number = COALESCE(EXCLUDED.phone_number, whatsapp_chats.phone_number),
         unread_count = COALESCE($11, whatsapp_chats.unread_count),
         is_archived = COALESCE(EXCLUDED.is_archived, whatsapp_chats.is_archived),
         is_pinned = COALESCE(EXCLUDED.is_pinned, whatsapp_chats.is_pinned),
         updated_at = now()
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.chatJid,
        input.jidKind,
        input.chatType,
        input.contactId ?? null,
        input.groupId ?? null,
        input.name ?? null,
        input.phoneNumber ?? null,
        input.chatType === 'group',
        input.unreadCount ?? null,
        input.isArchived ?? null,
        input.isPinned ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_chats upsert returned no row');
    return toRecord(row);
  }

  /**
   * incrementUnread should only be true for a genuinely new, live, inbound
   * message - never for our own outbound sends or historical backfill, both
   * of which the user has by definition already "seen" (or sent).
   */
  async recordLastMessage(chatId: string, messageId: string, occurredAt: string, incrementUnread = false): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_chats
       SET last_message_id = $2, last_message_at = $3, message_count = message_count + 1,
           unread_count = unread_count + CASE WHEN $4 THEN 1 ELSE 0 END,
           updated_at = now()
       WHERE id = $1`,
      [chatId, messageId, occurredAt, incrementUnread],
    );
  }

  /** Real "mark as read" - the user actually opened and viewed this conversation. */
  async resetUnreadCount(chatId: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      `UPDATE whatsapp_chats SET unread_count = 0, updated_at = now() WHERE id = $1 RETURNING *`,
      [chatId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByJid(businessId: string, whatsappAccountId: string, chatJid: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      `SELECT * FROM whatsapp_chats
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND chat_jid = $3 AND deleted_at IS NULL`,
      [businessId, whatsappAccountId, chatJid],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Reconciliation read: individual chats whose contact link never resolved
   * (e.g. the chat arrived before its contact did). Real candidates for
   * repair, not a fabricated "everything is fine" count.
   */
  async findMissingContactLinks(businessId: string, whatsappAccountId: string): Promise<WhatsAppChatRecord[]> {
    const { rows } = await this.db.query<ChatRow>(
      `SELECT * FROM whatsapp_chats
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND chat_type = 'individual'
         AND contact_id IS NULL AND deleted_at IS NULL`,
      [businessId, whatsappAccountId],
    );
    return rows.map(toRecord);
  }

  /** Reconciliation repair: attach a contact that only became available after the chat was created. */
  async attachContact(chatId: string, contactId: string): Promise<void> {
    await this.db.query('UPDATE whatsapp_chats SET contact_id = $2, updated_at = now() WHERE id = $1', [
      chatId,
      contactId,
    ]);
  }

  async findById(id: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>('SELECT * FROM whatsapp_chats WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Tenant-scoped lookup - a chat id belonging to another business returns
   * null, identically to a genuinely nonexistent id. Prefer this over the
   * bare findById() for any caller that has a businessId in scope.
   */
  async findByIdForBusiness(id: string, businessId: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      'SELECT * FROM whatsapp_chats WHERE id = $1 AND business_id = $2',
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByAccount(businessId: string, whatsappAccountId: string): Promise<WhatsAppChatRecord[]> {
    const { rows } = await this.db.query<ChatRow>(
      `SELECT * FROM whatsapp_chats
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND deleted_at IS NULL
       ORDER BY last_message_at DESC NULLS LAST`,
      [businessId, whatsappAccountId],
    );
    return rows.map(toRecord);
  }

  /** Real dashboard aggregate - total real chats vs those with a real message since a real timestamp, never estimated. */
  async countStatsSince(
    businessId: string,
    whatsappAccountId: string,
    sinceIso: string,
  ): Promise<{ total: number; activeSince: number }> {
    const { rows } = await this.db.query<{ total: string; active_since: string }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE last_message_at >= $3)::int AS active_since
       FROM whatsapp_chats
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND deleted_at IS NULL`,
      [businessId, whatsappAccountId, sinceIso],
    );
    return { total: Number(rows[0]?.total ?? 0), activeSince: Number(rows[0]?.active_since ?? 0) };
  }

  /** Revert all HUMAN_TAKEOVER chats for a business to AI_ACTIVE. Returns the count reverted. */
  async revertHumanTakeoverChats(businessId: string): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE whatsapp_chats SET ai_mode = 'AI_ACTIVE', ai_mode_source = 'logout_revert', ai_mode_set_at = now(), updated_at = now()
       WHERE business_id = $1 AND ai_mode = 'HUMAN_TAKEOVER' AND deleted_at IS NULL`,
      [businessId],
    );
    return rowCount ?? 0;
  }

  /**
   * Human takeover belongs to the specific conversation, not globally to the
   * account. `source` records who/what made this transition (see
   * WhatsAppChatRecord.aiModeSource) - always pass one for any new caller;
   * it is optional only so existing call sites that predate this column
   * still compile, not because omitting it is encouraged.
   */
  async setAiMode(id: string, aiMode: ChatAiMode, source?: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      'UPDATE whatsapp_chats SET ai_mode = $2, ai_mode_source = $3, ai_mode_set_at = now(), updated_at = now() WHERE id = $1 RETURNING *',
      [id, aiMode, source ?? null],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Per-chat override for the group-participation gate - mirrors setAiMode's
   * shape/provenance-tracking exactly. Meaningless (never read) for a chat
   * where isGroup is false.
   */
  async setGroupParticipationMode(id: string, mode: GroupParticipationMode, source?: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      'UPDATE whatsapp_chats SET group_participation_mode = $2, group_participation_mode_source = $3, group_participation_mode_set_at = now(), updated_at = now() WHERE id = $1 RETURNING *',
      [id, mode, source ?? null],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Cooldown stamp: called only at a real outbound send into a group, never
   * on a "considered but chose not to reply" outcome - see
   * WhatsAppChatRecord.lastAiGroupReplyAt's own doc comment for why this is
   * a distinct column from the debounce watermark.
   */
  async markAiGroupReplySent(chatId: string): Promise<void> {
    await this.db.query('UPDATE whatsapp_chats SET last_ai_group_reply_at = now(), updated_at = now() WHERE id = $1', [chatId]);
  }

  /**
   * Guarded, atomic revert for the manual-reply-detected auto-pause: only
   * flips back to AI_ACTIVE when the row is *currently* exactly
   * ('HUMAN_TAKEOVER', 'manual_reply_detected') - a single UPDATE ... WHERE,
   * not a read-then-write, so it can never race a concurrent write and
   * clobber a deliberate dashboard takeover or a different AI-failure
   * escalation that happened after this job was scheduled. Returns null
   * (a safe no-op) for every other case: already reverted, or moved to a
   * different mode/source since scheduling.
   */
  /**
   * The other half of the guarded pair below - only pauses when the row is
   * *currently* AI_ACTIVE. A chat already in HUMAN_TAKEOVER/AI_PAUSED for
   * any other reason (a deliberate dashboard action, a blocked keyword, an
   * AI failure) is left completely untouched: this must never override or
   * "refresh" someone else's takeover, only ever transition a genuinely
   * active AI conversation into the auto-pause state.
   */
  async pauseAiForManualReply(id: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      `UPDATE whatsapp_chats
       SET ai_mode = 'HUMAN_TAKEOVER', ai_mode_source = 'manual_reply_detected', ai_mode_set_at = now(), updated_at = now()
       WHERE id = $1 AND ai_mode = 'AI_ACTIVE'
       RETURNING *`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async resumeAiIfManualReplyDetected(id: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      `UPDATE whatsapp_chats
       SET ai_mode = 'AI_ACTIVE', ai_mode_source = 'auto_resume_after_manual_reply', ai_mode_set_at = now(), updated_at = now()
       WHERE id = $1 AND ai_mode = 'HUMAN_TAKEOVER' AND ai_mode_source = 'manual_reply_detected'
       RETURNING *`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Phase 3B debounce mutex: guarded claim, only succeeds when the chat is
   * currently AI_ACTIVE and no other invocation already holds the claim.
   * Callers MUST check for a null return and treat it as a safe no-op
   * (another debounce job is already processing this chat, or a human
   * took over since it was scheduled) - never assume success. Always
   * paired with releaseAiHandoff, ideally in a finally block.
   */
  async claimAiHandoff(chatId: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      `UPDATE whatsapp_chats
       SET ai_handoff_claimed_at = now()
       WHERE id = $1 AND ai_mode = 'AI_ACTIVE' AND ai_handoff_claimed_at IS NULL
       RETURNING *`,
      [chatId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Releases a claim taken by claimAiHandoff. `lastConsideredMessageId`
   * advances the debounce watermark only when non-null - pass null when no
   * real unanswered message was actually processed this round (nothing to
   * advance past).
   */
  async releaseAiHandoff(chatId: string, lastConsideredMessageId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_chats
       SET ai_handoff_claimed_at = NULL,
           last_ai_handoff_message_id = COALESCE($2::uuid, last_ai_handoff_message_id),
           updated_at = now()
       WHERE id = $1`,
      [chatId, lastConsideredMessageId],
    );
  }

  /**
   * Crash-recovery: a worker that died mid-handoff leaves a claim held
   * forever with nothing left to release it - this finds and clears claims
   * older than a real timeout, the same "reconcile a state a crash could
   * have interrupted" pattern as the existing call/sync-job/outbound-
   * message/email/media-download sweeps.
   */
  async releaseStaleAiHandoffClaims(staleSeconds: number): Promise<WhatsAppChatRecord[]> {
    const { rows } = await this.db.query<ChatRow>(
      `UPDATE whatsapp_chats
       SET ai_handoff_claimed_at = NULL
       WHERE ai_handoff_claimed_at IS NOT NULL
         AND ai_handoff_claimed_at < now() - ($1 || ' seconds')::interval
       RETURNING *`,
      [staleSeconds],
    );
    return rows.map(toRecord);
  }

  /**
   * Backstop sweep support: AI_ACTIVE chats with a real unanswered inbound
   * message (per the same has_media=false/is_historical=false criteria as
   * findUnansweredInboundSince) and no debounce claim in progress. Covers
   * both a crashed debounce job and the rarer race where a new message
   * arrived while the chat's jobId was still active/waiting and its own
   * scheduling attempt was a safe no-op - either way, nothing else would
   * ever re-arm a debounce job for it on its own.
   */
  async findAiActiveChatsWithUnansweredMessages(): Promise<WhatsAppChatRecord[]> {
    const { rows } = await this.db.query<ChatRow>(
      `SELECT DISTINCT c.* FROM whatsapp_chats c
       JOIN whatsapp_messages m ON m.chat_id = c.id
       WHERE c.ai_mode = 'AI_ACTIVE' AND c.deleted_at IS NULL AND c.ai_handoff_claimed_at IS NULL
         AND m.from_me = false AND m.is_historical = false AND m.has_media = false AND m.deleted_at IS NULL
         AND (
           c.last_ai_handoff_message_id IS NULL
           OR m.created_at > (SELECT created_at FROM whatsapp_messages WHERE id = c.last_ai_handoff_message_id)
         )`,
      [],
    );
    return rows.map(toRecord);
  }

  /** Human assignment belongs to the specific conversation, same as ai_mode - never a separate table. */
  async setAssignment(id: string, assigneeUserId: string | null, assigneeTeamId: string | null): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      'UPDATE whatsapp_chats SET assignee_user_id = $2, assignee_team_id = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [id, assigneeUserId, assigneeTeamId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * The honest capacity signal available today: how many non-deleted chats
   * are currently assigned to this user. There is no resolve/snooze state
   * yet (Chatwoot gap audit section 2), so "active" really means "still
   * assigned," not "still open" in the support-desk sense.
   */
  async countAssignedToUser(businessId: string, userId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM whatsapp_chats WHERE business_id = $1 AND assignee_user_id = $2 AND deleted_at IS NULL`,
      [businessId, userId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  /**
   * Real, PII-free data for the lock-screen AlertNotifier: chats currently
   * awaiting a human, labeled only by a stable per-business line ordinal
   * (never the account's phone number or push name) and an unread-count
   * urgency tier. No message text or contact identity is selected.
   */
  async listHumanTakeoverAlerts(businessId: string): Promise<HumanTakeoverAlertRow[]> {
    const { rows } = await this.db.query<HumanTakeoverAlertRow>(
      `WITH numbered_accounts AS (
         SELECT id, account_name, phone_number, ROW_NUMBER() OVER (ORDER BY created_at) AS line_number
         FROM whatsapp_accounts
         WHERE business_id = $1
       )
       SELECT c.id AS chat_id, c.unread_count, c.updated_at, na.line_number, na.account_name, na.phone_number,
              c.name AS customer_name, c.phone_number AS customer_phone_number
       FROM whatsapp_chats c
       JOIN numbered_accounts na ON na.id = c.whatsapp_account_id
       WHERE c.business_id = $1 AND c.ai_mode = 'HUMAN_TAKEOVER' AND c.deleted_at IS NULL
       ORDER BY c.updated_at DESC`,
      [businessId],
    );
    return rows;
  }
}

export interface HumanTakeoverAlertRow {
  chat_id: string;
  unread_count: number;
  updated_at: string;
  line_number: string;
  account_name: string | null;
  phone_number: string | null;
  /** The customer's own chat name/number - only ever read by listHumanTakeoverAlerts() when the caller has explicitly opted in to including it (see securityAlertService.ts's Zero-Leak Rule doc comment). */
  customer_name: string | null;
  customer_phone_number: string | null;
}

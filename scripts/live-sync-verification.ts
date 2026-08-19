/**
 * Cross-platform alternative to live-sync-verification.sql, for when a
 * standalone `psql` client isn't installed (e.g. plain Windows). Runs the
 * exact same checks through the app's own `pg` dependency - nothing new to
 * install, just:
 *
 *   npx tsx scripts/live-sync-verification.ts
 *
 * Privacy: every query below is a count, aggregate, or boolean check. None
 * of them ever read a raw phone_number, display name, JID, or message
 * content column - only counts and IDs. Message text is already
 * AES-256-GCM encrypted at rest, so raw SQL couldn't reveal it even if it
 * tried. Safe to paste the full output back into chat.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';

interface Section {
  title: string;
  query: string;
}

const sections: Section[] = [
  { title: 'CONTACTS', query: `SELECT count(*) AS contacts FROM whatsapp_contacts WHERE deleted_at IS NULL` },
  { title: 'GROUPS', query: `SELECT count(*) AS groups FROM whatsapp_groups WHERE deleted_at IS NULL` },
  { title: 'CHATS', query: `SELECT count(*) AS chats FROM whatsapp_chats WHERE deleted_at IS NULL` },
  {
    title: 'MESSAGES (total, live vs historical)',
    query: `SELECT count(*) AS messages_total,
                    count(*) FILTER (WHERE is_historical) AS messages_historical,
                    count(*) FILTER (WHERE NOT is_historical) AS messages_live
             FROM whatsapp_messages WHERE deleted_at IS NULL`,
  },
  { title: 'MEDIA (by download_status)', query: `SELECT download_status, count(*) FROM whatsapp_media GROUP BY download_status ORDER BY download_status` },
  { title: 'REACTIONS', query: `SELECT count(*) AS reactions FROM whatsapp_message_reactions` },
  { title: 'PRESENCE EVENTS', query: `SELECT count(*) AS presence_events FROM whatsapp_presence` },
  { title: 'STATUSES', query: `SELECT count(*) AS statuses FROM whatsapp_statuses` },
  { title: 'CALL EVENTS (by status)', query: `SELECT status, count(*) FROM whatsapp_calls GROUP BY status ORDER BY status` },
  { title: 'LID MAPPINGS', query: `SELECT count(*) AS lid_mappings FROM whatsapp_jid_mappings` },
  {
    title: 'UNKNOWN CONTACTS (no real name field set at all)',
    query: `SELECT count(*) AS unknown_contacts FROM whatsapp_contacts
             WHERE deleted_at IS NULL
               AND display_name IS NULL AND push_name IS NULL AND verified_name IS NULL AND business_name IS NULL`,
  },
  {
    title: 'UNRESOLVED JIDS (@lid contacts with no phone number yet)',
    query: `SELECT count(*) AS unresolved_lid_contacts FROM whatsapp_contacts
             WHERE deleted_at IS NULL AND jid_kind = 'lid' AND phone_number IS NULL`,
  },
  { title: 'FAILED MEDIA', query: `SELECT count(*) AS failed_media FROM whatsapp_media WHERE download_status IN ('failed', 'unavailable')` },
  { title: 'FAILED SYNC RECORDS (sum of errors_count)', query: `SELECT coalesce(sum(errors_count), 0) AS failed_sync_records FROM whatsapp_sync_jobs` },

  {
    title: 'PHASE 5 - duplicate messages (should be 0)',
    query: `SELECT count(*) AS duplicate_message_groups FROM (
              SELECT business_id, whatsapp_account_id, whatsapp_message_id
              FROM whatsapp_messages GROUP BY 1, 2, 3 HAVING count(*) > 1
            ) d`,
  },
  {
    title: 'PHASE 5 - duplicate reactions (should be 0)',
    query: `SELECT count(*) AS duplicate_reaction_groups FROM (
              SELECT message_id, reactor_jid FROM whatsapp_message_reactions GROUP BY 1, 2 HAVING count(*) > 1
            ) d`,
  },
  {
    title: 'PHASE 5 - duplicate contacts (should be 0)',
    query: `SELECT count(*) AS duplicate_contact_groups FROM (
              SELECT business_id, whatsapp_account_id, whatsapp_jid
              FROM whatsapp_contacts WHERE deleted_at IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1
            ) d`,
  },
  {
    title: 'PHASE 5 - duplicate chats (should be 0)',
    query: `SELECT count(*) AS duplicate_chat_groups FROM (
              SELECT business_id, whatsapp_account_id, chat_jid
              FROM whatsapp_chats WHERE deleted_at IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1
            ) d`,
  },

  {
    title: 'PHASE 8 - orphaned messages (should be 0, FK-enforced)',
    query: `SELECT count(*) FROM whatsapp_messages m
             WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_chats c WHERE c.id = m.chat_id)`,
  },
  {
    title: 'PHASE 8 - orphaned media (should be 0, FK-enforced)',
    query: `SELECT count(*) FROM whatsapp_media med
             WHERE NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.id = med.message_id)`,
  },
  {
    title: 'PHASE 8 - reactions pointing to a missing message (should be 0, FK-enforced)',
    query: `SELECT count(*) FROM whatsapp_message_reactions r
             WHERE NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.id = r.message_id)`,
  },
  {
    title: 'PHASE 8 - orphaned group members (should be 0, FK-enforced)',
    query: `SELECT count(*) FROM whatsapp_group_members gm
             WHERE NOT EXISTS (SELECT 1 FROM whatsapp_groups g WHERE g.id = gm.group_id)`,
  },
  {
    title: 'PHASE 8 - individual chats missing a contact link (real gap, not necessarily a bug)',
    query: `SELECT count(*) FROM whatsapp_chats
             WHERE deleted_at IS NULL AND chat_type = 'individual' AND contact_id IS NULL`,
  },
  {
    title: 'PHASE 8 - groups with participants reported but zero member rows persisted',
    query: `SELECT count(*) FROM whatsapp_groups g
             WHERE deleted_at IS NULL AND participants_count > 0
               AND NOT EXISTS (SELECT 1 FROM whatsapp_group_members m WHERE m.group_id = g.id)`,
  },
  {
    title: 'PHASE 8 - statuses with no matching contact for their publisher',
    query: `SELECT count(DISTINCT s.publisher_jid) FROM whatsapp_statuses s
             WHERE NOT EXISTS (
               SELECT 1 FROM whatsapp_contacts c
               WHERE c.business_id = s.business_id AND c.whatsapp_account_id = s.whatsapp_account_id
                 AND c.whatsapp_jid = s.publisher_jid AND c.deleted_at IS NULL
             )`,
  },
  {
    title: 'PHASE 8 - messages marked hasMedia=true with no attached media row',
    query: `SELECT count(*) FROM whatsapp_messages
             WHERE deleted_at IS NULL AND has_media = true AND media_id IS NULL`,
  },
  {
    title: 'PHASE 8 - messages with an impossible timestamp',
    query: `SELECT count(*) FROM whatsapp_messages
             WHERE deleted_at IS NULL AND (timestamp > now() + interval '1 hour' OR timestamp < '2009-01-01')`,
  },
  {
    title: 'PHASE 8 - calls stuck in a non-terminal state older than 5 minutes',
    query: `SELECT count(*) FROM whatsapp_calls
             WHERE status IN ('offer', 'ringing') AND updated_at < now() - interval '5 minutes'`,
  },
  {
    title: 'PHASE 8 - @lid mappings with no phone number at all',
    query: `SELECT count(*) FROM whatsapp_jid_mappings WHERE phone_number IS NULL`,
  },

  {
    title: 'PHASE 9 - performance baseline (5 most recent sync jobs)',
    query: `SELECT sync_type, status, started_at, completed_at,
                    extract(epoch FROM (coalesce(completed_at, now()) - started_at)) AS duration_seconds,
                    contacts_processed, chats_processed, groups_processed, messages_processed,
                    media_processed, errors_count,
                    CASE WHEN extract(epoch FROM (coalesce(completed_at, now()) - started_at)) > 0
                      THEN round((messages_processed / extract(epoch FROM (coalesce(completed_at, now()) - started_at)))::numeric, 2)
                      ELSE NULL
                    END AS messages_per_second
             FROM whatsapp_sync_jobs ORDER BY created_at DESC LIMIT 5`,
  },

  // ============================================================
  // OUTBOUND MESSAGING VALIDATION - real sends through the live
  // account, not just the mocked-socket unit tests.
  // ============================================================
  {
    title: 'OUTBOUND - counts by status (queued/sending should be ~0 once sends settle)',
    query: `SELECT status, count(*) FROM whatsapp_outbound_messages GROUP BY status ORDER BY status`,
  },
  {
    title: 'OUTBOUND - counts by message type',
    query: `SELECT message_type, count(*) FROM whatsapp_outbound_messages GROUP BY message_type ORDER BY message_type`,
  },
  {
    title: 'OUTBOUND - stuck queued/sending past the 5-minute sweep window (should be 0 - the sweep should have caught these)',
    query: `SELECT count(*) FROM whatsapp_outbound_messages
             WHERE status IN ('queued', 'sending') AND updated_at < now() - interval '5 minutes'`,
  },
  {
    title: 'OUTBOUND - duplicate idempotency keys (should be 0, unique-index-enforced)',
    query: `SELECT count(*) AS duplicate_idempotency_groups FROM (
               SELECT business_id, whatsapp_account_id, idempotency_key
               FROM whatsapp_outbound_messages GROUP BY 1, 2, 3 HAVING count(*) > 1
             ) d`,
  },
  {
    title: 'OUTBOUND - sent but never linked to a real whatsapp_messages row (real gap if nonzero and old - linking is async)',
    query: `SELECT count(*) FROM whatsapp_outbound_messages
             WHERE status = 'sent' AND message_id IS NULL AND sent_at < now() - interval '2 minutes'`,
  },
  {
    title: 'OUTBOUND - sent rows whose whatsapp_message_id does not actually exist in whatsapp_messages (should be 0 once linked)',
    query: `SELECT count(*) FROM whatsapp_outbound_messages o
             WHERE o.status = 'sent' AND o.message_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.id = o.message_id)`,
  },
  {
    title: 'OUTBOUND - failed sends (real errors, for manual review)',
    query: `SELECT id, chat_id, message_type, attempt_count, last_error, created_at
             FROM whatsapp_outbound_messages WHERE status = 'failed' ORDER BY created_at DESC LIMIT 10`,
  },
  {
    title: 'OUTBOUND - most recent 10 sends (real timeline, for manual cross-check against the phone)',
    query: `SELECT id, message_type, status, attempt_count, whatsapp_message_id, created_at, sent_at
             FROM whatsapp_outbound_messages ORDER BY created_at DESC LIMIT 10`,
  },

  // ============================================================
  // STATUS MEDIA VALIDATION - the mediaAvailable gap closed this pass.
  // ============================================================
  {
    title: 'STATUS MEDIA - counts by download_status (statuses only, never message media)',
    query: `SELECT download_status, count(*) FROM whatsapp_media WHERE status_id IS NOT NULL GROUP BY download_status ORDER BY download_status`,
  },
  {
    title: 'STATUS MEDIA - every whatsapp_media row has exactly one real owner (should be 0, DB-constraint-enforced)',
    query: `SELECT count(*) FROM whatsapp_media WHERE (message_id IS NOT NULL) = (status_id IS NOT NULL)`,
  },
];

async function main(): Promise<void> {
  console.log('=== WHATCHATAI LIVE SYNC VERIFICATION ===\n');
  for (const section of sections) {
    console.log(`--- ${section.title} ---`);
    try {
      const { rows } = await pool.query(section.query);
      if (rows.length === 0) {
        console.log('(no rows)');
      } else {
        console.table(rows);
      }
    } catch (error) {
      console.error('QUERY FAILED:', error instanceof Error ? error.message : error);
    }
    console.log();
  }
  console.log('=== DONE - paste this entire output back ===');
  await pool.end();
}

main().catch((error) => {
  console.error('Verification script failed:', error);
  process.exit(1);
});

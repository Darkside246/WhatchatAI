-- ============================================================
-- WHATCHATAI LIVE SYNC VERIFICATION
-- ============================================================
-- Run against the database a REAL, paired WhatsApp account has
-- synced into (never the *_test database used by `npm test`):
--
--   psql "$DATABASE_URL" -f scripts/live-sync-verification.sql
--
-- Privacy: every query below is a count, aggregate, or boolean
-- check. None of them ever SELECT a raw phone_number, display
-- name, JID, or message content column - only counts and IDs.
-- Message text is already AES-256-GCM encrypted at rest, so raw
-- SQL couldn't reveal it even if it tried. Safe to paste the
-- full output back into chat.
-- ============================================================

\echo '=== PHASE 2 - REQUIRED COUNTS ==='

\echo '--- CONTACTS ---'
SELECT count(*) AS contacts FROM whatsapp_contacts WHERE deleted_at IS NULL;

\echo '--- GROUPS ---'
SELECT count(*) AS groups FROM whatsapp_groups WHERE deleted_at IS NULL;

\echo '--- CHATS ---'
SELECT count(*) AS chats FROM whatsapp_chats WHERE deleted_at IS NULL;

\echo '--- MESSAGES (total, and split live vs historical) ---'
SELECT
  count(*) AS messages_total,
  count(*) FILTER (WHERE is_historical) AS messages_historical,
  count(*) FILTER (WHERE NOT is_historical) AS messages_live
FROM whatsapp_messages WHERE deleted_at IS NULL;

\echo '--- MEDIA (by download_status) ---'
SELECT download_status, count(*) FROM whatsapp_media GROUP BY download_status ORDER BY download_status;

\echo '--- REACTIONS ---'
SELECT count(*) AS reactions FROM whatsapp_message_reactions;

\echo '--- PRESENCE EVENTS ---'
SELECT count(*) AS presence_events FROM whatsapp_presence;

\echo '--- STATUSES ---'
SELECT count(*) AS statuses FROM whatsapp_statuses;

\echo '--- CALL EVENTS (by status) ---'
SELECT status, count(*) FROM whatsapp_calls GROUP BY status ORDER BY status;

\echo '--- LID MAPPINGS ---'
SELECT count(*) AS lid_mappings FROM whatsapp_jid_mappings;

\echo '--- UNKNOWN CONTACTS (no real name field set at all) ---'
SELECT count(*) AS unknown_contacts FROM whatsapp_contacts
WHERE deleted_at IS NULL
  AND display_name IS NULL AND push_name IS NULL AND verified_name IS NULL AND business_name IS NULL;

\echo '--- UNRESOLVED JIDS (@lid contacts with no phone number yet) ---'
SELECT count(*) AS unresolved_lid_contacts FROM whatsapp_contacts
WHERE deleted_at IS NULL AND jid_kind = 'lid' AND phone_number IS NULL;

\echo '--- FAILED MEDIA ---'
SELECT count(*) AS failed_media FROM whatsapp_media WHERE download_status IN ('failed', 'unavailable');

\echo '--- FAILED SYNC RECORDS (sum of errors_count across all sync jobs) ---'
SELECT coalesce(sum(errors_count), 0) AS failed_sync_records FROM whatsapp_sync_jobs;

\echo '=== PHASE 5 - DUPLICATE DETECTION ==='
\echo '(the schema has unique constraints preventing these - every count below MUST be 0; a nonzero value is a real defect)'

\echo '--- duplicate whatsapp_messages (business_id, whatsapp_account_id, whatsapp_message_id) ---'
SELECT count(*) AS duplicate_message_groups FROM (
  SELECT business_id, whatsapp_account_id, whatsapp_message_id
  FROM whatsapp_messages GROUP BY 1, 2, 3 HAVING count(*) > 1
) d;

\echo '--- duplicate reactions (message_id, reactor_jid) ---'
SELECT count(*) AS duplicate_reaction_groups FROM (
  SELECT message_id, reactor_jid FROM whatsapp_message_reactions GROUP BY 1, 2 HAVING count(*) > 1
) d;

\echo '--- duplicate contacts (business_id, whatsapp_account_id, whatsapp_jid) ---'
SELECT count(*) AS duplicate_contact_groups FROM (
  SELECT business_id, whatsapp_account_id, whatsapp_jid
  FROM whatsapp_contacts WHERE deleted_at IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1
) d;

\echo '--- duplicate chats (business_id, whatsapp_account_id, chat_jid) ---'
SELECT count(*) AS duplicate_chat_groups FROM (
  SELECT business_id, whatsapp_account_id, chat_jid
  FROM whatsapp_chats WHERE deleted_at IS NULL GROUP BY 1, 2, 3 HAVING count(*) > 1
) d;

\echo '=== PHASE 8 - DATA INTEGRITY AUDIT ==='

\echo '--- orphaned messages (chat_id points nowhere - should be impossible, FK-enforced) ---'
SELECT count(*) FROM whatsapp_messages m
WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM whatsapp_chats c WHERE c.id = m.chat_id);

\echo '--- orphaned media (message_id points nowhere - should be impossible, FK-enforced) ---'
SELECT count(*) FROM whatsapp_media med
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.id = med.message_id);

\echo '--- reactions pointing to a missing message (should be impossible, FK-enforced) ---'
SELECT count(*) FROM whatsapp_message_reactions r
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.id = r.message_id);

\echo '--- orphaned group members (group_id points nowhere - should be impossible, FK-enforced) ---'
SELECT count(*) FROM whatsapp_group_members gm
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_groups g WHERE g.id = gm.group_id);

\echo '--- chats missing a contact link (individual chats, contact_id IS NULL - real gap, not necessarily a bug) ---'
SELECT count(*) FROM whatsapp_chats
WHERE deleted_at IS NULL AND chat_type = 'individual' AND contact_id IS NULL;

\echo '--- groups WhatsApp reported as having participants, with zero member rows persisted ---'
SELECT count(*) FROM whatsapp_groups g
WHERE deleted_at IS NULL AND participants_count > 0
  AND NOT EXISTS (SELECT 1 FROM whatsapp_group_members m WHERE m.group_id = g.id);

\echo '--- statuses with no matching contact for their publisher ---'
SELECT count(DISTINCT s.publisher_jid) FROM whatsapp_statuses s
WHERE NOT EXISTS (
  SELECT 1 FROM whatsapp_contacts c
  WHERE c.business_id = s.business_id AND c.whatsapp_account_id = s.whatsapp_account_id
    AND c.whatsapp_jid = s.publisher_jid AND c.deleted_at IS NULL
);

\echo '--- messages marked hasMedia=true with no attached media row (integrity mismatch) ---'
SELECT count(*) FROM whatsapp_messages
WHERE deleted_at IS NULL AND has_media = true AND media_id IS NULL;

\echo '--- messages with an impossible timestamp (in the future, or before WhatsApp existed) ---'
SELECT count(*) FROM whatsapp_messages
WHERE deleted_at IS NULL AND (timestamp > now() + interval '1 hour' OR timestamp < '2009-01-01');

\echo '--- calls stuck in a non-terminal state older than 5 minutes (the 60s sweep should have caught these) ---'
SELECT count(*) FROM whatsapp_calls
WHERE status IN ('offer', 'ringing') AND updated_at < now() - interval '5 minutes';

\echo '--- @lid mappings with no phone number at all (a broken/incomplete mapping) ---'
SELECT count(*) FROM whatsapp_jid_mappings WHERE phone_number IS NULL;

\echo '=== PHASE 9 - PERFORMANCE BASELINE (most recent sync job) ==='
SELECT
  sync_type,
  status,
  started_at,
  completed_at,
  extract(epoch FROM (coalesce(completed_at, now()) - started_at)) AS duration_seconds,
  contacts_processed,
  chats_processed,
  groups_processed,
  messages_processed,
  media_processed,
  errors_count,
  CASE WHEN extract(epoch FROM (coalesce(completed_at, now()) - started_at)) > 0
    THEN round(messages_processed / extract(epoch FROM (coalesce(completed_at, now()) - started_at)), 2)
    ELSE NULL
  END AS messages_per_second
FROM whatsapp_sync_jobs
ORDER BY created_at DESC
LIMIT 5;

\echo '=== DONE - paste this entire output back ==='

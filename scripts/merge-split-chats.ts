/**
 * Rejoins contacts whose conversation got split across two WhatsApp
 * identities. See src/services/whatsapp/splitChatRepair.ts for what it
 * will and will not join, and why this is a deliberate act rather than
 * something the app does on its own.
 *
 *   npx tsx scripts/merge-split-chats.ts              # report only
 *   npx tsx scripts/merge-split-chats.ts --apply      # actually rejoin
 *
 * Privacy: the report prints ids, kinds and counts. No phone numbers, no
 * names, no message content - the output is safe to paste into a chat.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { chatReferencingColumns, findSplitChats, mergeSplitChat } from '../src/services/whatsapp/splitChatRepair.js';

const APPLY = process.argv.includes('--apply');

async function main(): Promise<void> {
  const splits = await findSplitChats();

  if (splits.length === 0) {
    console.log('No split chats found. Every contact on this database has one chat.');
    return;
  }

  console.log(`${splits.length} contact(s) have a conversation split across two WhatsApp identities:\n`);
  for (const split of splits) {
    console.log(`  business ${split.businessId}`);
    console.log(`    @lid   chat ${split.lidChatId}  (${split.lidMessageCount} messages, created ${split.lidCreatedAt})`);
    console.log(`    phone  chat ${split.phoneChatId}  (${split.phoneMessageCount} messages, created ${split.phoneCreatedAt})`);
  }

  if (!APPLY) {
    console.log('\nReport only - nothing has been changed.');
    console.log('Re-run with --apply to move every message, order and note into the OLDER chat of each pair');
    console.log('and soft-delete the newer one. Take a backup first (scripts/postgres-backup.sh).');
    return;
  }

  const references = await chatReferencingColumns();
  console.log(`\nRejoining, moving ${references.length} kinds of record per chat:\n`);
  for (const split of splits) {
    const result = await mergeSplitChat(split, references);
    console.log(`  merged ${result.removedChatId} into ${result.keptChatId}`);
    for (const table of result.droppedDuplicatesIn) {
      console.log(`    ${table}: the surviving chat already had its own row - dropped the duplicate`);
    }
  }

  console.log('\nDone. New messages will stay in one chat on their own from now on.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

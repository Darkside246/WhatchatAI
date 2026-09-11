/**
 * Admin utility to reset one user's password in the PostgreSQL auth store.
 *
 * On the server (the only place it can actually run against production):
 *   docker compose exec app-server node dist/scripts/resetPassword.js <email> <new-password>
 *   docker compose exec app-server node dist/scripts/resetPassword.js --phone <+E.164> <new-password>
 *
 * In a dev checkout:
 *   npx tsx src/scripts/resetPassword.ts <email> <new-password>
 *
 * WHY IT LIVES UNDER src/ rather than scripts/. tsconfig compiles src/**
 * only, and the runtime image carries dist/, production node_modules and
 * nothing else - no scripts/ directory and no tsx. Postgres publishes no
 * host port either (see docker-compose.yml), so the database is reachable
 * only from a container on aura-net. A recovery tool that can only run from
 * a developer's checkout cannot recover anything on the machine that has
 * the accounts on it. Same shape as dist/db/migrate.js, which app-server
 * already runs on boot.
 *
 * The password is supplied at runtime and is never stored in source control.
 * This utility deliberately does not call validatePasswordStrength so it can
 * recover accounts whose previous credential policy is incompatible with the
 * current verifier. Login itself does not enforce password strength.
 *
 * WHY --phone EXISTS. Signup identifies a person by phone number, and the
 * developer control plane lists accounts by phone - so that is the identifier
 * an operator actually has when someone says they cannot get in. It is not
 * queryable in SQL: users.phone_number is encrypted per business (see
 * developerAccountsService, which decrypts the same way for the same reason),
 * so `WHERE phone_number = ...` matches nothing however correct the number is.
 * This resolves it the only way it can be resolved - decrypt each candidate
 * and compare digits.
 *
 * THIS IS NOT A PASSWORD RESET FEATURE. It is an operator recovering one
 * account by hand, on the server, with database credentials. There is still
 * no self-serve path for a user who has forgotten their password.
 */
import 'dotenv/config';
import { pool } from '../db/pool.js';
import { hashPassword } from '../services/passwordHashService.js';
import { getEncryptionService } from '../security/encryption/index.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import { SessionRepository } from '../repositories/sessionRepository.js';

interface FoundUser {
  id: string;
  email: string;
  status: string;
  businessName: string | null;
}

async function findByEmail(email: string): Promise<FoundUser[]> {
  const { rows } = await pool.query<{ id: string; email: string; status: string }>(
    'SELECT id, email, status FROM users WHERE email = $1 AND deleted_at IS NULL',
    [email],
  );
  return rows.map((row) => ({ ...row, businessName: null }));
}

/**
 * Matches on digits only, so +1 246 260-6993, 12462606993 and (246) 260-6993
 * all find the same person. Whatever formatting the number was stored in is
 * whatever the user typed at signup, and an operator reading it off a support
 * message should not have to reproduce it exactly.
 */
async function findByPhone(phone: string): Promise<FoundUser[]> {
  const wanted = phone.replace(/\D/g, '');
  if (wanted.length === 0) return [];

  const { rows } = await pool.query<{ id: string; email: string; status: string; phone_number: string | null }>(
    'SELECT id, email, status, phone_number FROM users WHERE phone_number IS NOT NULL AND deleted_at IS NULL',
  );

  const membershipRepository = new BusinessMembershipRepository(pool);
  const businessRepository = new BusinessRepository(pool);
  const encryption = getEncryptionService();
  const matches: FoundUser[] = [];

  for (const row of rows) {
    const membership = await membershipRepository.findFirstActiveForUser(row.id);
    if (!membership || !row.phone_number) continue;

    let decrypted: string | null = null;
    try {
      const envelope = encryption.tryParse(row.phone_number);
      decrypted = envelope ? await encryption.decryptField(membership.businessId, envelope) : row.phone_number;
    } catch {
      // Encrypted under a business this user no longer belongs to. Skipped
      // rather than fatal - one unreadable row must not hide every other
      // account from the search.
      continue;
    }

    if ((decrypted ?? '').replace(/\D/g, '') !== wanted) continue;
    const business = await businessRepository.findById(membership.businessId);
    matches.push({ id: row.id, email: row.email, status: row.status, businessName: business?.name ?? null });
  }

  return matches;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const byPhone = args[0] === '--phone';
  const [identifier, password] = byPhone ? args.slice(1) : args;

  if (!identifier || password === undefined) {
    console.error('Usage: node dist/scripts/resetPassword.js <email> <new-password>');
    console.error('       node dist/scripts/resetPassword.js --phone <+E.164 phone> <new-password>');
    process.exitCode = 1;
    return;
  }

  if (password.length === 0 || password.length > 200) {
    console.error('New password must contain 1 to 200 characters.');
    process.exitCode = 1;
    return;
  }

  const found = byPhone ? await findByPhone(identifier) : await findByEmail(identifier.trim().toLowerCase());

  if (found.length === 0) {
    console.error(`No active user found for ${identifier}.`);
    process.exitCode = 1;
    return;
  }

  // Two people on one number means the operator has to say which account -
  // guessing would reset a stranger's password.
  if (found.length > 1) {
    console.error(`${found.length} active users match ${identifier}. Re-run with the email of the one you mean:`);
    for (const candidate of found) console.error(`  ${candidate.email}${candidate.businessName ? ` (${candidate.businessName})` : ''}`);
    process.exitCode = 1;
    return;
  }

  const user = found[0]!;
  const credential = await hashPassword(password);

  await pool.query(
    `UPDATE users
     SET password_hash = $1,
         password_salt = $2,
         password_params = $3,
         updated_at = now()
     WHERE id = $4`,
    [credential.hash, credential.salt, JSON.stringify(credential.params), user.id],
  );

  // A forgotten password and a stolen one look identical from here, and the
  // new credential alone evicts nobody: every session token issued before
  // this moment stays valid until it expires on its own. Revoking them is
  // the difference between "they can get back in" and "only they can."
  const revoked = await new SessionRepository(pool).revokeAllForUserExcept(user.id, null);

  console.log(`Password reset successfully for ${user.email}${user.businessName ? ` (${user.businessName})` : ''}.`);
  console.log(`Account status: ${user.status}.`);
  console.log(`Signed-in sessions revoked: ${revoked}.`);
  console.log('All future logins will use the new Argon2id credential.');
}

main()
  .catch((error) => {
    console.error('Password reset failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    // Exit explicitly. Closing the pool is not enough to end the process -
    // hash-wasm's instantiated module keeps the event loop alive - and a
    // one-shot admin command that prints its result and then hangs forever
    // is worse than it sounds: the operator Ctrl-Cs it and cannot tell
    // whether the reset they asked for actually happened. It did; the
    // UPDATE is committed well before this runs.
    process.exit(process.exitCode ?? 0);
  });

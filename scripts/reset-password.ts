/**
 * Local admin utility to reset one user's password in the PostgreSQL auth store.
 *
 * Usage:
 *   npx tsx scripts/reset-password.ts <email> <new-password>
 *
 * The password is supplied at runtime and is never stored in source control.
 * This utility deliberately does not call validatePasswordStrength so it can
 * recover accounts whose previous credential policy is incompatible with the
 * current verifier. Login itself does not enforce password strength.
 */
import 'dotenv/config';
import { pool } from '../src/db/pool.js';
import { hashPassword } from '../src/services/passwordHashService.js';

async function main(): Promise<void> {
  const [emailArg, password] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();

  if (!email || password === undefined) {
    console.error('Usage: npx tsx scripts/reset-password.ts <email> <new-password>');
    process.exitCode = 1;
    return;
  }

  if (password.length === 0 || password.length > 200) {
    console.error('New password must contain 1 to 200 characters.');
    process.exitCode = 1;
    return;
  }

  const { rows } = await pool.query<{ id: string; email: string; status: string }>(
    'SELECT id, email, status FROM users WHERE email = $1 AND deleted_at IS NULL',
    [email],
  );

  const user = rows[0];
  if (!user) {
    console.error(`No active user found for ${email}.`);
    process.exitCode = 1;
    return;
  }

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

  console.log(`Password reset successfully for ${user.email}.`);
  console.log(`Account status: ${user.status}.`);
  console.log('All future logins will use the new Argon2id credential.');
}

main()
  .catch((error) => {
    console.error('Password reset failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

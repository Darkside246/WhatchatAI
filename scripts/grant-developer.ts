import 'dotenv/config';
import { pool } from '../src/db/pool.js';

const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
  console.error('Usage: npx tsx scripts/grant-developer.ts <email>');
  process.exit(1);
}

try {
  const { rows } = await pool.query<{ id: string; email: string; platform_role: string; status: string }>(
    `UPDATE users
     SET platform_role = 'DEVELOPER', updated_at = now()
     WHERE email = $1
       AND deleted_at IS NULL
     RETURNING id, email, platform_role, status`,
    [email],
  );

  if (!rows[0]) {
    console.error(`No active user found for ${email}.`);
    process.exitCode = 1;
  } else {
    console.log('Developer access granted successfully.');
    console.table(rows);
  }
} finally {
  await pool.end();
}

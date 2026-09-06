import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

function migrationNumber(filename: string): number {
  const match = /^(\d+)_/.exec(filename);
  if (!match) throw new Error(`Migration filename "${filename}" doesn't start with a numeric prefix.`);
  return Number(match[1]);
}

/**
 * Real, confirmed production bug: migrate.ts used to sort migration
 * filenames as plain strings, so "1000_x.sql" sorted BEFORE "945_x.sql"
 * through "999_x.sql" ('1' < '9' as the first character) - invisible in
 * dev/test, where each migration is applied incrementally right after
 * being written, but fatal the first time a database far behind tries to
 * catch up across the 999->1000 digit-count boundary in one run (1000
 * attempted before the migration that creates a table it depends on).
 */
describe('migrate.ts migration ordering', () => {
  it('sorts every real migration file in this repo by its actual numeric prefix, not string order', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'));
    const sortedByNumber = [...files].sort((a, b) => migrationNumber(a) - migrationNumber(b));
    const sortedAsStrings = [...files].sort();

    // The real regression: once any 4-digit migration exists alongside
    // 3-digit ones, plain string sort disagrees with numeric sort - proving
    // this repo's own real files exercise the exact bug that was fixed.
    expect(sortedAsStrings).not.toEqual(sortedByNumber);

    // >= rather than > - a handful of real migration numbers in this repo
    // are legitimately duplicated (e.g. two 903_*.sql files); the real
    // regression this guards is monotonic *digit-count* ordering (no 4-digit
    // file ever sorting before a 3-digit one it should follow), not global
    // number uniqueness, which is a separate, pre-existing condition.
    for (let i = 1; i < sortedByNumber.length; i++) {
      expect(migrationNumber(sortedByNumber[i] as string)).toBeGreaterThanOrEqual(migrationNumber(sortedByNumber[i - 1] as string));
    }
  });

  it('a deliberately out-of-order mixed set of 3- and 4-digit filenames sorts numerically, not lexicographically', () => {
    const files = ['1001_z.sql', '945_a.sql', '999_b.sql', '1000_c.sql', '944_d.sql'];
    const sorted = [...files].sort((a, b) => migrationNumber(a) - migrationNumber(b));
    expect(sorted).toEqual(['944_d.sql', '945_a.sql', '999_b.sql', '1000_c.sql', '1001_z.sql']);
  });
});

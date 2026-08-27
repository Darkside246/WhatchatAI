import type { Queryable } from './types.js';
import type { PasswordParams } from '../services/passwordHashService.js';

export type PlatformRole = 'CLIENT' | 'DEVELOPER';

export interface UserRecord {
  id: string;
  email: string;
  emailVerifiedAt: string | null;
  passwordHash: string;
  passwordSalt: string;
  passwordParams: PasswordParams;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  phoneNumber: string | null;
  locale: string;
  timezone: string;
  status: 'active' | 'suspended' | 'deactivated';
  platformRole: PlatformRole;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicUser = Omit<UserRecord, 'passwordHash' | 'passwordSalt' | 'passwordParams'>;

interface UserRow {
  id: string;
  email: string;
  email_verified_at: string | null;
  password_hash: string;
  password_salt: string;
  password_params: PasswordParams;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  avatar_url: string | null;
  phone_number: string | null;
  locale: string;
  timezone: string;
  status: UserRecord['status'];
  platform_role: PlatformRole;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    emailVerifiedAt: row.email_verified_at,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    passwordParams: row.password_params,
    displayName: row.display_name,
    firstName: row.first_name,
    lastName: row.last_name,
    avatarUrl: row.avatar_url,
    phoneNumber: row.phone_number,
    locale: row.locale,
    timezone: row.timezone,
    status: row.status,
    platformRole: row.platform_role,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublicUser(user: UserRecord): PublicUser {
  const { passwordHash: _h, passwordSalt: _s, passwordParams: _p, ...rest } = user;
  return rest;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  passwordParams: PasswordParams;
  platformRole?: PlatformRole;
}

export class UserRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateUserInput): Promise<UserRecord> {
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (email, display_name, password_hash, password_salt, password_params, platform_role)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.email, input.displayName, input.passwordHash, input.passwordSalt, JSON.stringify(input.passwordParams), input.platformRole ?? 'CLIENT'],
    );
    const row = rows[0];
    if (!row) throw new Error('users insert returned no row');
    return toRecord(row);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.db.query<UserRow>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.db.query('UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1', [id]);
  }

  async countAll(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users WHERE deleted_at IS NULL');
    return Number(rows[0]?.count ?? '0');
  }
}

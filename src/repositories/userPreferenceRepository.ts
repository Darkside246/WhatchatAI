import type { Queryable } from './types.js';

export interface UserPreferenceRecord {
  userId: string;
  theme: string;
  language: string;
  timezone: string;
  notificationSound: boolean;
  desktopNotifications: boolean;
  pushNotifications: boolean;
  handoffSound: boolean;
  reducedMotion: boolean;
  density: 'comfortable' | 'compact';
  chatFontSize: 'small' | 'medium' | 'large';
  defaultWhatsappAccountId: string | null;
  navigationOrder: string[] | null;
  country: string | null;
  createdAt: string;
  updatedAt: string;
}

interface UserPreferenceRow {
  user_id: string;
  theme: string;
  language: string;
  timezone: string;
  notification_sound: boolean;
  desktop_notifications: boolean;
  push_notifications: boolean;
  handoff_sound: boolean;
  reduced_motion: boolean;
  density: UserPreferenceRecord['density'];
  chat_font_size: UserPreferenceRecord['chatFontSize'];
  default_whatsapp_account_id: string | null;
  navigation_order: string[] | null;
  country: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: UserPreferenceRow): UserPreferenceRecord {
  return {
    userId: row.user_id,
    theme: row.theme,
    language: row.language,
    timezone: row.timezone,
    notificationSound: row.notification_sound,
    desktopNotifications: row.desktop_notifications,
    pushNotifications: row.push_notifications,
    handoffSound: row.handoff_sound,
    reducedMotion: row.reduced_motion,
    density: row.density,
    chatFontSize: row.chat_font_size,
    defaultWhatsappAccountId: row.default_whatsapp_account_id,
    navigationOrder: row.navigation_order,
    country: row.country,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type UserPreferenceUpdatableFields = Pick<
  UserPreferenceRecord,
  | 'theme'
  | 'language'
  | 'timezone'
  | 'notificationSound'
  | 'desktopNotifications'
  | 'pushNotifications'
  | 'handoffSound'
  | 'reducedMotion'
  | 'density'
  | 'chatFontSize'
  | 'defaultWhatsappAccountId'
  | 'country'
> & { navigationOrder: string[] | null };

// Explicit `| undefined` per field (rather than a bare Partial<...>) so
// zod's .optional() output - which really can carry an explicit `undefined`
// value, not just an absent key - is assignable under exactOptionalPropertyTypes.
export type UserPreferenceUpdate = { [K in keyof UserPreferenceUpdatableFields]?: UserPreferenceUpdatableFields[K] | undefined };

export class UserPreferenceRepository {
  constructor(private readonly db: Queryable) {}

  async ensureDefault(userId: string): Promise<UserPreferenceRecord> {
    const { rows } = await this.db.query<UserPreferenceRow>(
      `INSERT INTO user_preferences (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING *`,
      [userId],
    );
    const row = rows[0];
    if (!row) throw new Error('user_preferences insert returned no row');
    return toRecord(row);
  }

  async findByUser(userId: string): Promise<UserPreferenceRecord | null> {
    const { rows } = await this.db.query<UserPreferenceRow>('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async update(userId: string, update: UserPreferenceUpdate): Promise<UserPreferenceRecord> {
    await this.ensureDefault(userId);
    const columns: Record<string, unknown> = {
      theme: update.theme,
      language: update.language,
      timezone: update.timezone,
      notification_sound: update.notificationSound,
      desktop_notifications: update.desktopNotifications,
      push_notifications: update.pushNotifications,
      handoff_sound: update.handoffSound,
      reduced_motion: update.reducedMotion,
      density: update.density,
      chat_font_size: update.chatFontSize,
      default_whatsapp_account_id: update.defaultWhatsappAccountId,
      navigation_order: update.navigationOrder !== undefined ? JSON.stringify(update.navigationOrder) : undefined,
      country: update.country,
    };
    const entries = Object.entries(columns).filter(([, value]) => value !== undefined);
    if (entries.length === 0) {
      const current = await this.findByUser(userId);
      if (!current) throw new Error('user_preferences row missing after ensureDefault');
      return current;
    }

    const setClauses = entries.map(([column], index) => `${column} = $${index + 2}`);
    const values = entries.map(([, value]) => value);
    const { rows } = await this.db.query<UserPreferenceRow>(
      `UPDATE user_preferences SET ${setClauses.join(', ')}, updated_at = now() WHERE user_id = $1 RETURNING *`,
      [userId, ...values],
    );
    const row = rows[0];
    if (!row) throw new Error('user_preferences update returned no row');
    return toRecord(row);
  }
}

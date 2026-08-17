import type { Queryable } from './types.js';

export interface TeamRecord {
  id: string;
  businessId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMemberRecord {
  id: string;
  teamId: string;
  userId: string;
  email: string;
  displayName: string;
  createdAt: string;
}

interface TeamRow {
  id: string;
  business_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface TeamMemberRow {
  id: string;
  team_id: string;
  user_id: string;
  email: string;
  display_name: string;
  created_at: string;
}

function toTeamRecord(row: TeamRow): TeamRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTeamMemberRecord(row: TeamMemberRow): TeamMemberRecord {
  return {
    id: row.id,
    teamId: row.team_id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export class TeamRepository {
  constructor(private readonly db: Queryable) {}

  async create(businessId: string, name: string, description: string | null): Promise<TeamRecord> {
    const { rows } = await this.db.query<TeamRow>(
      'INSERT INTO teams (business_id, name, description) VALUES ($1, $2, $3) RETURNING *',
      [businessId, name, description],
    );
    const row = rows[0];
    if (!row) throw new Error('teams insert returned no row');
    return toTeamRecord(row);
  }

  async findById(id: string): Promise<TeamRecord | null> {
    const { rows } = await this.db.query<TeamRow>('SELECT * FROM teams WHERE id = $1', [id]);
    return rows[0] ? toTeamRecord(rows[0]) : null;
  }

  async listForBusiness(businessId: string): Promise<TeamRecord[]> {
    const { rows } = await this.db.query<TeamRow>('SELECT * FROM teams WHERE business_id = $1 ORDER BY created_at', [businessId]);
    return rows.map(toTeamRecord);
  }

  async update(id: string, input: { name?: string | undefined; description?: string | null | undefined }): Promise<TeamRecord | null> {
    const { rows } = await this.db.query<TeamRow>(
      `UPDATE teams SET name = COALESCE($2, name), description = COALESCE($3, description), updated_at = now() WHERE id = $1 RETURNING *`,
      [id, input.name ?? null, input.description ?? null],
    );
    return rows[0] ? toTeamRecord(rows[0]) : null;
  }

  async remove(id: string): Promise<void> {
    await this.db.query('DELETE FROM teams WHERE id = $1', [id]);
  }

  async addMember(teamId: string, userId: string): Promise<void> {
    await this.db.query('INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT (team_id, user_id) DO NOTHING', [
      teamId,
      userId,
    ]);
  }

  async removeMember(teamId: string, userId: string): Promise<void> {
    await this.db.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
  }

  async listMembers(teamId: string): Promise<TeamMemberRecord[]> {
    const { rows } = await this.db.query<TeamMemberRow>(
      `SELECT tm.*, u.email, u.display_name
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
       ORDER BY tm.created_at`,
      [teamId],
    );
    return rows.map(toTeamMemberRecord);
  }

  async isMember(teamId: string, userId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2) AS exists',
      [teamId, userId],
    );
    return rows[0]?.exists ?? false;
  }
}

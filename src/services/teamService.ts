import { pool } from '../db/pool.js';
import { TeamRepository, type TeamRecord, type TeamMemberRecord } from '../repositories/teamRepository.js';
import { BusinessMembershipRepository } from '../repositories/businessMembershipRepository.js';
import { AgentCapacityRepository, type AgentCapacityRecord, type AgentAvailability } from '../repositories/agentCapacityRepository.js';
import { WhatsAppChatRepository } from '../repositories/whatsappChatRepository.js';

const teamRepository = new TeamRepository(pool);
const membershipRepository = new BusinessMembershipRepository(pool);
const capacityRepository = new AgentCapacityRepository(pool);
const chatRepository = new WhatsAppChatRepository(pool);

export class TeamNotFoundError extends Error {}
export class DuplicateTeamNameError extends Error {}
export class UserNotBusinessMemberError extends Error {}

async function requireOwnTeam(businessId: string, teamId: string): Promise<TeamRecord> {
  const team = await teamRepository.findById(teamId);
  if (!team || team.businessId !== businessId) throw new TeamNotFoundError('Team not found.');
  return team;
}

export interface TeamWithMembers extends TeamRecord {
  members: TeamMemberRecord[];
}

export async function createTeam(businessId: string, name: string, description: string | null): Promise<TeamRecord> {
  try {
    return await teamRepository.create(businessId, name.trim(), description);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new DuplicateTeamNameError(`A team named "${name}" already exists.`);
    }
    throw error;
  }
}

export async function listTeams(businessId: string): Promise<TeamWithMembers[]> {
  const teams = await teamRepository.listForBusiness(businessId);
  return Promise.all(
    teams.map(async (team) => ({ ...team, members: await teamRepository.listMembers(team.id) })),
  );
}

export async function updateTeam(
  businessId: string,
  teamId: string,
  input: { name?: string | undefined; description?: string | null | undefined },
): Promise<TeamRecord> {
  await requireOwnTeam(businessId, teamId);
  try {
    const updated = await teamRepository.update(teamId, input);
    if (!updated) throw new TeamNotFoundError('Team not found.');
    return updated;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23505') {
      throw new DuplicateTeamNameError(`A team named "${input.name}" already exists.`);
    }
    throw error;
  }
}

export async function deleteTeam(businessId: string, teamId: string): Promise<void> {
  await requireOwnTeam(businessId, teamId);
  await teamRepository.remove(teamId);
}

export async function addTeamMember(businessId: string, teamId: string, userId: string): Promise<TeamMemberRecord[]> {
  await requireOwnTeam(businessId, teamId);
  const membership = await membershipRepository.findByUserAndBusiness(userId, businessId);
  if (!membership || membership.status !== 'active') throw new UserNotBusinessMemberError('That user is not an active member of this business.');

  await teamRepository.addMember(teamId, userId);
  await capacityRepository.ensureDefault(businessId, userId);
  return teamRepository.listMembers(teamId);
}

export async function removeTeamMember(businessId: string, teamId: string, userId: string): Promise<TeamMemberRecord[]> {
  await requireOwnTeam(businessId, teamId);
  await teamRepository.removeMember(teamId, userId);
  return teamRepository.listMembers(teamId);
}

export async function getMyCapacity(businessId: string, userId: string): Promise<AgentCapacityRecord> {
  return capacityRepository.ensureDefault(businessId, userId);
}

export async function updateMyCapacity(
  businessId: string,
  userId: string,
  input: { maxActiveConversations?: number | undefined; availability?: AgentAvailability | undefined },
): Promise<AgentCapacityRecord> {
  await capacityRepository.ensureDefault(businessId, userId);
  const updated = await capacityRepository.update(userId, input);
  if (!updated) throw new Error('agent_capacity update returned no row');
  return updated;
}

export interface CapacitySummary extends AgentCapacityRecord {
  email: string;
  displayName: string;
  currentAssignedCount: number;
}

export async function listCapacity(businessId: string): Promise<CapacitySummary[]> {
  const [memberships, capacities] = await Promise.all([
    membershipRepository.listForBusiness(businessId),
    capacityRepository.listForBusiness(businessId),
  ]);
  const capacityByUser = new Map(capacities.map((c) => [c.userId, c]));

  const summaries: CapacitySummary[] = [];
  for (const membership of memberships) {
    const capacity = capacityByUser.get(membership.userId) ?? (await capacityRepository.ensureDefault(businessId, membership.userId));
    const currentAssignedCount = await chatRepository.countAssignedToUser(businessId, membership.userId);
    summaries.push({ ...capacity, email: membership.email, displayName: membership.displayName, currentAssignedCount });
  }
  return summaries;
}

export function isTeamNotFoundError(error: unknown): error is TeamNotFoundError {
  return error instanceof TeamNotFoundError;
}
export function isDuplicateTeamNameError(error: unknown): error is DuplicateTeamNameError {
  return error instanceof DuplicateTeamNameError;
}
export function isUserNotBusinessMemberError(error: unknown): error is UserNotBusinessMemberError {
  return error instanceof UserNotBusinessMemberError;
}

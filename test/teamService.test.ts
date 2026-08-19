import { beforeEach, describe, expect, it } from 'vitest';
import { register } from '../src/services/authService.js';
import { createMember } from '../src/services/workspaceMemberService.js';
import {
  createTeam,
  listTeams,
  updateTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  getMyCapacity,
  updateMyCapacity,
  listCapacity,
  isTeamNotFoundError,
  isDuplicateTeamNameError,
  isUserNotBusinessMemberError,
} from '../src/services/teamService.js';
import { resetDatabase, createTestBusiness } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

describe('teamService (real teams, real membership validation, real capacity)', () => {
  let businessId: string;
  let ownerId: string;
  let agentId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
    const created = await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Agent', role: 'AGENT' });
    agentId = created.member.userId;
  });

  it('creates a real team and lists it with an empty member list', async () => {
    const team = await createTeam(businessId, 'Support', 'Customer support');
    const teams = await listTeams(businessId);
    expect(teams).toHaveLength(1);
    expect(teams[0]?.id).toBe(team.id);
    expect(teams[0]?.members).toEqual([]);
  });

  it('rejects a duplicate team name within the same business', async () => {
    await createTeam(businessId, 'Support', null);
    await expect(createTeam(businessId, 'Support', null)).rejects.toThrow();
    try {
      await createTeam(businessId, 'Support', null);
    } catch (error) {
      expect(isDuplicateTeamNameError(error)).toBe(true);
    }
  });

  it('adds and removes a real active business member, and rejects a non-member', async () => {
    const team = await createTeam(businessId, 'Support', null);
    const membersAfterAdd = await addTeamMember(businessId, team.id, agentId);
    expect(membersAfterAdd.map((m) => m.userId)).toContain(agentId);

    const membersAfterRemove = await removeTeamMember(businessId, team.id, agentId);
    expect(membersAfterRemove.map((m) => m.userId)).not.toContain(agentId);

    await expect(addTeamMember(businessId, team.id, '00000000-0000-0000-0000-000000000000')).rejects.toThrow();
    try {
      await addTeamMember(businessId, team.id, '00000000-0000-0000-0000-000000000000');
    } catch (error) {
      expect(isUserNotBusinessMemberError(error)).toBe(true);
    }
  });

  it('refuses to update or delete a team belonging to a different business', async () => {
    const team = await createTeam(businessId, 'Support', null);
    const otherBusinessId = await createTestBusiness('Other Business');

    await expect(updateTeam(otherBusinessId, team.id, { name: 'Hijacked' })).rejects.toThrow();
    await expect(deleteTeam(otherBusinessId, team.id)).rejects.toThrow();
    try {
      await updateTeam(otherBusinessId, team.id, { name: 'Hijacked' });
    } catch (error) {
      expect(isTeamNotFoundError(error)).toBe(true);
    }

    const teams = await listTeams(businessId);
    expect(teams[0]?.name).toBe('Support');
  });

  it('deletes a team for real - it disappears from the list', async () => {
    const team = await createTeam(businessId, 'Support', null);
    await deleteTeam(businessId, team.id);
    expect(await listTeams(businessId)).toHaveLength(0);
  });

  it('getMyCapacity returns a real default, and updateMyCapacity persists real changes', async () => {
    const capacity = await getMyCapacity(businessId, ownerId);
    expect(capacity.maxActiveConversations).toBeGreaterThan(0);
    expect(capacity.availability).toBe('available');

    const updated = await updateMyCapacity(businessId, ownerId, { maxActiveConversations: 5, availability: 'busy' });
    expect(updated.maxActiveConversations).toBe(5);
    expect(updated.availability).toBe('busy');
  });

  it('listCapacity includes every active member with their real current assigned count', async () => {
    const summaries = await listCapacity(businessId);
    expect(summaries).toHaveLength(2);
    expect(summaries.every((s) => s.currentAssignedCount === 0)).toBe(true);
    expect(summaries.map((s) => s.email).sort()).toEqual(['agent@example.com', 'owner@example.com']);
  });
});

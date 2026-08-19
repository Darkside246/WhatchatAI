import { beforeEach, describe, expect, it } from 'vitest';
import { register } from '../src/services/authService.js';
import {
  createMember,
  listMembers,
  updateMemberRole,
  removeMember,
  isEmailAlreadyRegisteredError,
  isMembershipNotFoundError,
  isCannotModifyOwnerError,
} from '../src/services/workspaceMemberService.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

describe('workspaceMemberService (real, admin-managed multi-user - no open self-registration)', () => {
  let businessId: string;
  let ownerId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
  });

  it('creates a real member with a random one-time password and lists it back with a role', async () => {
    const result = await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Agent Smith', role: 'AGENT' });
    expect(result.member.role).toBe('AGENT');
    expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(8);

    const members = await listMembers(businessId);
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.email === 'agent@example.com')?.role).toBe('AGENT');
  });

  it('rejects creating a member with an email that already exists', async () => {
    await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Agent', role: 'AGENT' });
    await expect(createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Dupe', role: 'VIEWER' })).rejects.toThrow();
    try {
      await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Dupe', role: 'VIEWER' });
    } catch (error) {
      expect(isEmailAlreadyRegisteredError(error)).toBe(true);
    }
  });

  it('updates a non-owner member\'s role for real, and rejects a nonexistent membership', async () => {
    const created = await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Agent', role: 'AGENT' });
    const updated = await updateMemberRole(businessId, created.member.membershipId, 'MANAGER');
    expect(updated.role).toBe('MANAGER');

    await expect(updateMemberRole(businessId, '00000000-0000-0000-0000-000000000000', 'VIEWER')).rejects.toThrow();
    try {
      await updateMemberRole(businessId, '00000000-0000-0000-0000-000000000000', 'VIEWER');
    } catch (error) {
      expect(isMembershipNotFoundError(error)).toBe(true);
    }
  });

  it('never lets the owner\'s role be changed or the owner be removed', async () => {
    const members = await listMembers(businessId);
    const ownerMembership = members.find((m) => m.userId === ownerId)!;

    await expect(updateMemberRole(businessId, ownerMembership.membershipId, 'VIEWER')).rejects.toThrow();
    await expect(removeMember(businessId, ownerMembership.membershipId)).rejects.toThrow();
    try {
      await removeMember(businessId, ownerMembership.membershipId);
    } catch (error) {
      expect(isCannotModifyOwnerError(error)).toBe(true);
    }
  });

  it('removes a non-owner member for real - they disappear from the list', async () => {
    const created = await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Agent', role: 'AGENT' });
    await removeMember(businessId, created.member.membershipId);

    const members = await listMembers(businessId);
    expect(members.find((m) => m.email === 'agent@example.com')).toBeUndefined();
  });

  it('refuses to touch a membership that belongs to a different business - real tenant isolation', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const created = await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Agent', role: 'AGENT' });

    await expect(updateMemberRole(otherBusinessId, created.member.membershipId, 'VIEWER')).rejects.toThrow();
    await expect(removeMember(otherBusinessId, created.member.membershipId)).rejects.toThrow();

    const members = await listMembers(businessId);
    expect(members.find((m) => m.email === 'agent@example.com')?.role).toBe('AGENT');
  });
});

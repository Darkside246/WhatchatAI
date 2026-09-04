import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
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

/**
 * register()'s default 'starter' plan caps max_users at 2 (Section 93-98:
 * createMember now genuinely enforces this). Several tests below add a
 * second/third member on top of the owner, which would otherwise trip the
 * real seat limit and mask the specific behavior each test is isolating -
 * moves the subscription to 'growth' (10 seats) so plenty of headroom
 * exists; entitlementService.test.ts's own describe block is what actually
 * proves the limit is enforced.
 */
async function giveRoomForMoreMembers(businessId: string): Promise<void> {
  await pool.query(
    `UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE plan_key = 'growth') WHERE business_id = $1`,
    [businessId],
  );
}

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

describe('workspaceMemberService (real, admin-managed multi-user - no open self-registration)', () => {
  let businessId: string;
  let ownerId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register({ email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' }, device);
    businessId = owner.business.id;
    ownerId = owner.user.id;
    await giveRoomForMoreMembers(businessId);
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

  /**
   * Section 93-98: the real gap - createMember() itself had zero
   * entitlement check, so a business could invite unlimited team members
   * regardless of their plan's max_users limit. Moves back down to the
   * real 'starter' plan (2 seats) - beforeEach upgrades to 'growth' for
   * every other test in this file so unrelated scenarios aren't tripped
   * by the real limit.
   */
  it('refuses to create a member once the plan\'s real max_users limit is reached', async () => {
    await pool.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE plan_key = 'starter') WHERE business_id = $1`, [businessId]);

    // Owner already counts as 1 of 2 seats - one real member fills the plan.
    await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Agent', role: 'AGENT' });

    await expect(createMember(businessId, ownerId, { email: 'one-too-many@example.com', displayName: 'Extra', role: 'AGENT' })).rejects.toThrow();

    const members = await listMembers(businessId);
    expect(members.find((m) => m.email === 'one-too-many@example.com')).toBeUndefined();
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

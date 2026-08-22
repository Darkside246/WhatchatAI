import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { UserRepository, toPublicUser } from '../repositories/userRepository.js';
import { BusinessMembershipRepository, type MembershipWithUser } from '../repositories/businessMembershipRepository.js';
import { UserPreferenceRepository } from '../repositories/userPreferenceRepository.js';
import { hashPassword } from './passwordHashService.js';
import type { BusinessRole } from '../domain/auth/permissions.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';

const userRepository = new UserRepository(pool);
const membershipRepository = new BusinessMembershipRepository(pool);
const preferenceRepository = new UserPreferenceRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);

export class EmailAlreadyRegisteredError extends Error {}
export class MembershipNotFoundError extends Error {}
export class CannotModifyOwnerError extends Error {}
export class CrossBusinessMembershipError extends Error {}

/**
 * A random, one-time credential - never a fixed placeholder like
 * "changeme123". This codebase has no email provider configured (see the
 * Chatwoot gap audit, section 30/6), so there is no automated invite
 * delivery yet: the admin who calls this is handed the password once in
 * the response and is responsible for relaying it to the new teammate
 * through a real channel of their own.
 */
function generateTemporaryPassword(): string {
  return randomBytes(12).toString('base64url');
}

export interface MemberSummary {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: BusinessRole;
  status: string;
  joinedAt: string;
}

function toSummary(membership: MembershipWithUser): MemberSummary {
  return {
    membershipId: membership.id,
    userId: membership.userId,
    email: membership.email,
    displayName: membership.displayName,
    role: membership.role,
    status: membership.status,
    joinedAt: membership.joinedAt,
  };
}

export async function listMembers(businessId: string): Promise<MemberSummary[]> {
  const memberships = await membershipRepository.listForBusiness(businessId);
  return memberships.map(toSummary);
}

export interface CreateMemberInput {
  email: string;
  displayName: string;
  role: Exclude<BusinessRole, 'OWNER'>;
}

export async function createMember(
  businessId: string,
  invitedBy: string,
  input: CreateMemberInput,
): Promise<{ member: MemberSummary; temporaryPassword: string }> {
  const email = input.email.trim().toLowerCase();
  const existing = await userRepository.findByEmail(email);
  if (existing) throw new EmailAlreadyRegisteredError('An account with this email already exists.');

  const temporaryPassword = generateTemporaryPassword();
  const credential = await hashPassword(temporaryPassword);
  const user = await userRepository.create({
    email,
    displayName: input.displayName.trim(),
    passwordHash: credential.hash,
    passwordSalt: credential.salt,
    passwordParams: credential.params,
  });
  await preferenceRepository.ensureDefault(user.id);
  const membership = await membershipRepository.create(businessId, user.id, input.role, invitedBy);

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'member_created',
    rawMetadata: { membershipId: membership.id, role: input.role, invitedBy },
  });

  return {
    member: toSummary({ ...membership, email: user.email, displayName: user.displayName }),
    temporaryPassword,
  };
}

async function requireOwnMembership(businessId: string, membershipId: string) {
  const membership = await membershipRepository.findByIdForBusiness(membershipId, businessId);
  if (!membership) throw new MembershipNotFoundError('Member not found.');
  return membership;
}

export async function updateMemberRole(businessId: string, membershipId: string, role: Exclude<BusinessRole, 'OWNER'>): Promise<MemberSummary> {
  const membership = await requireOwnMembership(businessId, membershipId);
  if (membership.role === 'OWNER') throw new CannotModifyOwnerError('The business owner’s role cannot be changed.');

  const updated = await membershipRepository.updateRole(membershipId, role);
  if (!updated) throw new MembershipNotFoundError('Member not found.');
  const user = await userRepository.findById(updated.userId);
  if (!user) throw new MembershipNotFoundError('Member not found.');

  await securityAuditLogRepository.record({
    businessId,
    eventType: 'member_role_changed',
    rawMetadata: { membershipId, fromRole: membership.role, toRole: role },
  });

  return toSummary({ ...updated, email: user.email, displayName: user.displayName });
}

export async function removeMember(businessId: string, membershipId: string): Promise<void> {
  const membership = await requireOwnMembership(businessId, membershipId);
  if (membership.role === 'OWNER') throw new CannotModifyOwnerError('The business owner cannot be removed.');
  await membershipRepository.remove(membershipId);
}

export function isEmailAlreadyRegisteredError(error: unknown): error is EmailAlreadyRegisteredError {
  return error instanceof EmailAlreadyRegisteredError;
}
export function isMembershipNotFoundError(error: unknown): error is MembershipNotFoundError {
  return error instanceof MembershipNotFoundError;
}
export function isCannotModifyOwnerError(error: unknown): error is CannotModifyOwnerError {
  return error instanceof CannotModifyOwnerError;
}

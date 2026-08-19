import { pool } from '../db/pool.js';
import { ensureDefaultBusinessProvisioned } from './businessBootstrapService.js';
import { hashPassword, verifyPassword, validatePasswordStrength, WeakPasswordError } from './passwordHashService.js';
import { generateSessionToken, hashSessionToken, parseUserAgent } from './sessionTokenService.js';
import { UserRepository, toPublicUser, type PublicUser, type UserRecord } from '../repositories/userRepository.js';
import { BusinessMembershipRepository, type BusinessMembershipRecord } from '../repositories/businessMembershipRepository.js';
import { SessionRepository, type SessionRecord } from '../repositories/sessionRepository.js';
import { UserPreferenceRepository } from '../repositories/userPreferenceRepository.js';
import { AuthLoginAttemptRepository } from '../repositories/authLoginAttemptRepository.js';
import type { BusinessRecord } from '../repositories/businessRepository.js';

const userRepository = new UserRepository(pool);
const membershipRepository = new BusinessMembershipRepository(pool);
const sessionRepository = new SessionRepository(pool);
const preferenceRepository = new UserPreferenceRepository(pool);
const loginAttemptRepository = new AuthLoginAttemptRepository(pool);

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const LAST_SEEN_TOUCH_THRESHOLD_MS = 60 * 1000;
const MAX_LOGIN_FAILURES = 8;
const LOGIN_WINDOW_MINUTES = 15;

export class EmailAlreadyRegisteredError extends Error {}
export class RegistrationClosedError extends Error {}
export class InvalidCredentialsError extends Error {}
export class RateLimitedError extends Error {}
export class SessionNotFoundError extends Error {}
export { WeakPasswordError };

export interface DeviceContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuthResult {
  user: PublicUser;
  business: BusinessRecord;
  membership: BusinessMembershipRecord;
  token: string;
  session: SessionRecord;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Registration is only ever open while a business has zero members - the
 * very first signup becomes OWNER and provisions the business. Any request
 * after that must go through POST /workspace/members (an authenticated
 * OWNER/ADMIN action, see workspaceMemberService below) - open
 * self-registration into an existing tenant would be a real, exploitable
 * hole (an unauthenticated stranger could otherwise mint themselves a
 * VIEWER account on someone else's business by just knowing the URL).
 */
export async function isRegistrationOpen(): Promise<boolean> {
  const business = await ensureDefaultBusinessProvisioned();
  const count = await membershipRepository.countForBusiness(business.id);
  return count === 0;
}

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}

export async function register(input: RegisterInput, device: DeviceContext): Promise<AuthResult> {
  validatePasswordStrength(input.password);
  const email = normalizeEmail(input.email);
  const displayName = input.displayName.trim();
  if (!email || !displayName) throw new InvalidCredentialsError('Email and display name are required.');

  const business = await ensureDefaultBusinessProvisioned();
  const existingCount = await membershipRepository.countForBusiness(business.id);
  if (existingCount > 0) throw new RegistrationClosedError('This business already has members. Ask an admin to add you.');

  const existingUser = await userRepository.findByEmail(email);
  if (existingUser) throw new EmailAlreadyRegisteredError('An account with this email already exists.');

  const credential = await hashPassword(input.password);
  const user = await userRepository.create({
    email,
    displayName,
    passwordHash: credential.hash,
    passwordSalt: credential.salt,
    passwordParams: credential.params,
  });
  await preferenceRepository.ensureDefault(user.id);
  const membership = await membershipRepository.create(business.id, user.id, 'OWNER');

  const session = await createSession(user.id, business.id, device, 'password');
  return { user: toPublicUser(user), business, membership, token: session.token, session: session.session };
}

export async function login(email: string, password: string, device: DeviceContext): Promise<AuthResult> {
  const normalizedEmail = normalizeEmail(email);
  const recentFailures = await loginAttemptRepository.countRecentFailures(normalizedEmail, LOGIN_WINDOW_MINUTES);
  if (recentFailures >= MAX_LOGIN_FAILURES) {
    throw new RateLimitedError(`Too many failed login attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`);
  }

  const user = await userRepository.findByEmail(normalizedEmail);
  if (!user) {
    await loginAttemptRepository.record(normalizedEmail, device.ipAddress, false);
    throw new InvalidCredentialsError('Incorrect email or password.');
  }

  const valid = await verifyPassword(password, { hash: user.passwordHash, salt: user.passwordSalt, params: user.passwordParams });
  if (!valid) {
    await loginAttemptRepository.record(normalizedEmail, device.ipAddress, false);
    throw new InvalidCredentialsError('Incorrect email or password.');
  }
  if (user.status !== 'active') {
    await loginAttemptRepository.record(normalizedEmail, device.ipAddress, false);
    throw new InvalidCredentialsError('This account is no longer active.');
  }

  await loginAttemptRepository.record(normalizedEmail, device.ipAddress, true);

  const membership = await membershipRepository.findFirstActiveForUser(user.id);
  if (!membership) throw new InvalidCredentialsError('This account has no active business membership.');

  const business = await ensureDefaultBusinessProvisioned();
  await userRepository.updateLastLogin(user.id);
  const session = await createSession(user.id, membership.businessId, device, 'password');
  return { user: toPublicUser(user), business, membership, token: session.token, session: session.session };
}

async function createSession(
  userId: string,
  businessId: string,
  device: DeviceContext,
  authMethod: string,
): Promise<{ token: string; session: SessionRecord }> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const { browser, os } = parseUserAgent(device.userAgent);
  const session = await sessionRepository.create({
    userId,
    businessId,
    tokenHash,
    expiresAt,
    ipAddress: device.ipAddress,
    userAgent: device.userAgent,
    deviceName: `${browser} on ${os}`,
    authMethod,
  });
  return { token, session };
}

export interface ValidatedSession {
  user: PublicUser;
  membership: BusinessMembershipRecord;
  session: SessionRecord;
}

export async function validateSession(token: string): Promise<ValidatedSession | null> {
  const tokenHash = hashSessionToken(token);
  const session = await sessionRepository.findByTokenHash(tokenHash);
  if (!session) return null;
  if (session.revokedAt) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) return null;

  const user = await userRepository.findById(session.userId);
  if (!user || user.status !== 'active') return null;
  const membership = await membershipRepository.findByUserAndBusiness(session.userId, session.businessId);
  if (!membership || membership.status !== 'active') return null;

  const lastSeenAge = Date.now() - new Date(session.lastSeenAt).getTime();
  if (lastSeenAge > LAST_SEEN_TOUCH_THRESHOLD_MS) {
    void sessionRepository.touchLastSeen(session.id);
  }

  return { user: toPublicUser(user), membership, session };
}

export async function logout(token: string): Promise<void> {
  const tokenHash = hashSessionToken(token);
  const session = await sessionRepository.findByTokenHash(tokenHash);
  if (session) await sessionRepository.revoke(session.id);
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  browser: string;
  os: string;
  isCurrent: boolean;
}

export async function listSessions(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
  const sessions = await sessionRepository.listActiveForUser(userId);
  return sessions.map((session) => {
    const { browser, os } = parseUserAgent(session.userAgent);
    return {
      id: session.id,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      expiresAt: session.expiresAt,
      ipAddress: session.ipAddress,
      browser,
      os,
      isCurrent: session.id === currentSessionId,
    };
  });
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const session = await sessionRepository.findById(sessionId);
  if (!session || session.userId !== userId) throw new SessionNotFoundError('Session not found.');
  await sessionRepository.revoke(sessionId);
}

export async function revokeOtherSessions(userId: string, currentSessionId: string): Promise<number> {
  return sessionRepository.revokeAllForUserExcept(userId, currentSessionId);
}

export function isEmailAlreadyRegisteredError(error: unknown): error is EmailAlreadyRegisteredError {
  return error instanceof EmailAlreadyRegisteredError;
}
export function isRegistrationClosedError(error: unknown): error is RegistrationClosedError {
  return error instanceof RegistrationClosedError;
}
export function isInvalidCredentialsError(error: unknown): error is InvalidCredentialsError {
  return error instanceof InvalidCredentialsError;
}
export function isRateLimitedError(error: unknown): error is RateLimitedError {
  return error instanceof RateLimitedError;
}
export function isWeakPasswordError(error: unknown): error is WeakPasswordError {
  return error instanceof WeakPasswordError;
}
export function isSessionNotFoundError(error: unknown): error is SessionNotFoundError {
  return error instanceof SessionNotFoundError;
}

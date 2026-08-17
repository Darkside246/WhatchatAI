export const BUSINESS_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'SUPERVISOR', 'AGENT', 'MARKETING', 'VIEWER'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export const PERMISSIONS = [
  'whatsapp.view',
  'whatsapp.send',
  'whatsapp.manage',
  'whatsapp.connect',
  'whatsapp.disconnect',
  'contacts.view',
  'contacts.edit',
  'crm.view',
  'crm.edit',
  'leads.view',
  'leads.edit',
  'ai.view',
  'ai.create',
  'ai.edit',
  'ai.activate',
  'automation.view',
  'automation.create',
  'automation.edit',
  'automation.execute',
  'marketing.view',
  'marketing.create',
  'marketing.send',
  'marketing.schedule',
  'reports.view',
  'reports.export',
  'billing.view',
  'billing.manage',
  'team.manage',
  'users.manage',
  'settings.manage',
  'audit.view',
  // Email is split into three because approving-and-sending is a genuinely
  // higher-trust act than drafting: an AI-drafted email is only ever sent by
  // someone holding email.send.
  'email.view',
  'email.draft',
  'email.send',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Backend-enforced role -> permission map. This is the actual security
 * boundary (see requirePermission in server/authMiddleware.ts) - the
 * frontend only reads it to decide what to render, never to decide what to
 * allow.
 */
const ROLE_PERMISSIONS: Record<BusinessRole, readonly Permission[]> = {
  // OWNER and ADMIN hold every permission. They're distinguished at the
  // membership layer, not the permission layer: only OWNER can never be
  // removed or demoted (enforced in businessMembershipRepository), and only
  // one OWNER exists per business.
  OWNER: PERMISSIONS,
  ADMIN: PERMISSIONS,
  MANAGER: [
    'whatsapp.view',
    'whatsapp.send',
    'whatsapp.manage',
    'contacts.view',
    'contacts.edit',
    'crm.view',
    'crm.edit',
    'leads.view',
    'leads.edit',
    'ai.view',
    'ai.create',
    'ai.edit',
    'ai.activate',
    'automation.view',
    'automation.create',
    'automation.edit',
    'automation.execute',
    'marketing.view',
    'marketing.create',
    'marketing.send',
    'marketing.schedule',
    'reports.view',
    'reports.export',
    'team.manage',
    'email.view',
    'email.draft',
    'email.send',
  ],
  SUPERVISOR: [
    'whatsapp.view',
    'whatsapp.send',
    'contacts.view',
    'contacts.edit',
    'crm.view',
    'crm.edit',
    'leads.view',
    'leads.edit',
    'ai.view',
    'automation.view',
    'marketing.view',
    'reports.view',
    'team.manage',
    'email.view',
    'email.draft',
    'email.send',
  ],
  // Deliberately no 'email.send': an agent can prepare an email but a
  // supervisor or above releases it to a real customer.
  AGENT: [
    'whatsapp.view',
    'whatsapp.send',
    'contacts.view',
    'contacts.edit',
    'crm.view',
    'crm.edit',
    'leads.view',
    'leads.edit',
    'ai.view',
    'email.view',
    'email.draft',
  ],
  MARKETING: [
    'whatsapp.view',
    'contacts.view',
    'crm.view',
    'marketing.view',
    'marketing.create',
    'marketing.send',
    'marketing.schedule',
    'reports.view',
  ],
  VIEWER: ['whatsapp.view', 'contacts.view', 'crm.view', 'leads.view', 'reports.view', 'email.view'],
};

export function hasPermission(role: BusinessRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function permissionsForRole(role: BusinessRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function isBusinessRole(value: string): value is BusinessRole {
  return (BUSINESS_ROLES as readonly string[]).includes(value);
}

export const BUSINESS_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'SUPERVISOR', 'AGENT', 'MARKETING', 'VIEWER'] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

export const PERMISSIONS = [
  'whatsapp.view','whatsapp.send','whatsapp.manage','whatsapp.connect','whatsapp.disconnect',
  'contacts.view','contacts.edit','crm.view','crm.edit','leads.view','leads.edit',
  'ai.view','ai.create','ai.edit','ai.activate',
  'automation.view','automation.create','automation.edit','automation.execute',
  'marketing.view','marketing.create','marketing.send','marketing.schedule',
  'reports.view','reports.export','billing.view','billing.manage','team.manage','users.manage','settings.manage','audit.view',
  'property.view','property.manage','property.approve',
  'retail.view','retail.manage','retail.approve',
  'food.view','food.manage','food.approve',
  'email.view','email.draft','email.send',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<BusinessRole, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: PERMISSIONS,
  MANAGER: [
    'whatsapp.view','whatsapp.send','whatsapp.manage','contacts.view','contacts.edit','crm.view','crm.edit','leads.view','leads.edit',
    'ai.view','ai.create','ai.edit','ai.activate','automation.view','automation.create','automation.edit','automation.execute',
    'marketing.view','marketing.create','marketing.send','marketing.schedule','reports.view','reports.export','team.manage',
    'property.view','property.manage','property.approve','retail.view','retail.manage','retail.approve','food.view','food.manage','food.approve','email.view','email.draft','email.send',
  ],
  SUPERVISOR: [
    'whatsapp.view','whatsapp.send','contacts.view','contacts.edit','crm.view','crm.edit','leads.view','leads.edit','ai.view','automation.view',
    'marketing.view','reports.view','team.manage','property.view','property.manage','property.approve','retail.view','retail.manage','retail.approve','food.view','food.manage','food.approve','email.view','email.draft','email.send',
  ],
  AGENT: [
    'whatsapp.view','whatsapp.send','contacts.view','contacts.edit','crm.view','crm.edit','leads.view','leads.edit','ai.view',
    'property.view','retail.view','email.view','email.draft',
    /* food.manage, deliberately, where property and retail only grant view.
       The person bumping a ticket from the line to the pass is a cook, and
       a cook is an AGENT. A kitchen where the most junior role cannot move
       a ticket is a kitchen that goes back to shouting, which is the
       problem the board exists to solve. */
    'food.view','food.manage',
  ],
  MARKETING: ['whatsapp.view','contacts.view','crm.view','marketing.view','marketing.create','marketing.send','marketing.schedule','reports.view'],
  VIEWER: ['whatsapp.view','contacts.view','crm.view','leads.view','reports.view','property.view','retail.view','food.view','email.view'],
};

export function hasPermission(role: BusinessRole, permission: Permission): boolean { return ROLE_PERMISSIONS[role]?.includes(permission) ?? false; }
export function permissionsForRole(role: BusinessRole): readonly Permission[] { return ROLE_PERMISSIONS[role] ?? []; }
export function isBusinessRole(value: string): value is BusinessRole { return (BUSINESS_ROLES as readonly string[]).includes(value); }

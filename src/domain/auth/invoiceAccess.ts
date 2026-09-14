import { hasPermission, type BusinessRole } from './permissions.js';

/**
 * Who may change an invoice, as opposed to look at one.
 *
 * A security review found every invoice route behind "is signed in" and
 * nothing else, so any member of the business could approve one, mark it
 * paid, send it to a customer, void it or delete it - a VIEWER included,
 * whose entire role is the nine *.view permissions and whose whole purpose
 * is that it cannot change anything.
 *
 * The fix is billing.manage, held by OWNER and ADMIN. But "who may raise an
 * invoice" is a real difference between businesses rather than a fact about
 * software: a restaurant where the owner does the books wants exactly that,
 * while a property firm with a manager running the office wants that manager
 * invoicing without being made an admin of everything else. So it is a
 * setting, and this is the one place that reads it.
 *
 * Pure and dependency-free on purpose. This decides whether somebody can
 * move money, so it has to be checkable on its own rather than only
 * observable by signing in as five different roles and trying.
 */

/**
 * The roles a business may delegate invoicing TO.
 *
 * Deliberately just the two supervisory roles. An AGENT is a cook or a
 * front-line replier; MARKETING sends campaigns; a VIEWER is read-only by
 * definition. None of them acquires invoice rights however this setting is
 * set - a delegation widens the circle of trusted people, it never opens the
 * door.
 */
export const DELEGABLE_INVOICE_ROLES: readonly BusinessRole[] = ['MANAGER', 'SUPERVISOR'];

/** Whether this role may create, approve, send, settle, void or delete an invoice. */
export function canManageInvoices(role: BusinessRole, invoiceManageDelegated: boolean): boolean {
  // The permission is the floor and always sufficient: OWNER and ADMIN are
  // unaffected by the setting in either direction.
  if (hasPermission(role, 'billing.manage')) return true;
  return invoiceManageDelegated && DELEGABLE_INVOICE_ROLES.includes(role);
}

/**
 * Who may turn the setting itself on or off.
 *
 * Never the roles it delegates to. A manager who could switch on their own
 * invoicing has not been delegated anything - they have found an escalation,
 * and the setting would be worse than no setting at all.
 */
export function canDelegateInvoiceManagement(role: BusinessRole): boolean {
  return hasPermission(role, 'settings.manage');
}

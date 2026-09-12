import { pool } from '../db/pool.js';

/**
 * The welcome/verification email's words, and the merge fields they can use.
 *
 * Shipped with a default so the email works before anyone has edited
 * anything, and overridable from the developer console so changing the
 * wording does not need a deploy.
 *
 * WHY THE DEFAULT READS THE WAY IT DOES. Deliverability is mostly decided
 * before a spam filter reads a single word - SPF, DKIM, DMARC and the
 * sending domain's reputation - but the content still carries weight, and
 * the things that hurt are well known: image-heavy HTML with little text,
 * link shorteners and redirectors, tracking pixels, ALL CAPS, exclamation
 * marks, "free", "act now", a mismatch between the visible link text and
 * where it goes. So the default is short plain prose, one link, shown in
 * full, and no marketing register. It reads like a message a person sent,
 * which is the only thing that reliably looks like one.
 */

export const WELCOME_TEMPLATE_KEY = 'welcome_verification';

export interface WelcomeEmailContext {
  displayName: string;
  verifyUrl: string;
  expiresInHours: number;
}

export interface RenderedEmail {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
}

/**
 * The merge fields a template may use, and what each one is.
 *
 * Exported because the editor lists them - an editor that lets someone type
 * a placeholder that silently renders as nothing is worse than one with no
 * placeholders at all.
 */
export const WELCOME_MERGE_FIELDS = [
  { token: '{{name}}', description: 'The name the person gave when they signed up' },
  { token: '{{verify_url}}', description: 'Their one-time verification link (required)' },
  { token: '{{expires_hours}}', description: 'How many hours the link stays valid' },
] as const;

export const DEFAULT_WELCOME_SUBJECT = 'Confirm your email to finish setting up AURA';

export const DEFAULT_WELCOME_BODY = `Hi {{name}},

Thanks for signing up to AURA.

One thing left: confirm this is your email address by opening the link below.

{{verify_url}}

The link works for {{expires_hours}} hours. If you didn't sign up for AURA, ignore this message - no account of yours is affected, and the link stops working on its own.

Once you're confirmed, the next step is connecting your WhatsApp number so AURA can start handling your conversations.
`;

/** Substitutes the merge fields. Unknown placeholders are left alone rather than blanked, so a typo is visible instead of silently eating text. */
function applyMergeFields(template: string, context: WelcomeEmailContext): string {
  return template
    .replaceAll('{{name}}', context.displayName)
    .replaceAll('{{verify_url}}', context.verifyUrl)
    .replaceAll('{{expires_hours}}', String(context.expiresInHours));
}

export interface StoredTemplate {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
}

/** The stored override, or null when nobody has edited it yet. */
export async function loadWelcomeTemplate(): Promise<StoredTemplate | null> {
  const { rows } = await pool.query<{ subject: string; body_text: string; body_html: string | null }>(
    `SELECT subject, body_text, body_html FROM platform_email_templates WHERE template_key = $1`,
    [WELCOME_TEMPLATE_KEY],
  );
  const row = rows[0];
  return row ? { subject: row.subject, bodyText: row.body_text, bodyHtml: row.body_html } : null;
}

export async function saveWelcomeTemplate(input: StoredTemplate, updatedBy: string): Promise<void> {
  await pool.query(
    `INSERT INTO platform_email_templates (template_key, subject, body_text, body_html, updated_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (template_key) DO UPDATE
       SET subject = EXCLUDED.subject,
           body_text = EXCLUDED.body_text,
           body_html = EXCLUDED.body_html,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [WELCOME_TEMPLATE_KEY, input.subject, input.bodyText, input.bodyHtml, updatedBy],
  );
}

/** Restores the shipped wording by removing the override entirely, rather than copying the default into the row - so a later improvement to the default is picked up. */
export async function resetWelcomeTemplate(): Promise<void> {
  await pool.query(`DELETE FROM platform_email_templates WHERE template_key = $1`, [WELCOME_TEMPLATE_KEY]);
}

/**
 * Renders a template that has not necessarily been saved - which is what
 * the preview shows, and what the real send goes through.
 *
 * One function for both, so a preview cannot differ from what actually goes
 * out. A preview that differs is worse than no preview, because it is
 * trusted.
 */
export function renderWelcomeEmailFromStrings(
  template: { subject: string; bodyText: string },
  context: WelcomeEmailContext,
): { subject: string; bodyText: string } {
  const subject = template.subject.trim() ? template.subject : DEFAULT_WELCOME_SUBJECT;
  let bodyText = template.bodyText.trim() ? template.bodyText : DEFAULT_WELCOME_BODY;

  // The link is the entire point of this email. A template edited to drop
  // it would produce a friendly message that strands every new signup, so
  // it is appended rather than trusted to be there.
  if (!bodyText.includes('{{verify_url}}')) {
    bodyText = `${bodyText.trimEnd()}\n\n{{verify_url}}\n`;
  }

  return { subject: applyMergeFields(subject, context), bodyText: applyMergeFields(bodyText, context) };
}

/**
 * The email as it will actually be sent.
 *
 * Falls back to the shipped default when the stored template is unusable or
 * the lookup fails: this email carries the verification link, so sending
 * the default wording always beats sending nothing.
 */
export async function renderWelcomeEmail(context: WelcomeEmailContext): Promise<RenderedEmail> {
  let stored: StoredTemplate | null = null;
  try {
    stored = await loadWelcomeTemplate();
  } catch (error) {
    console.error('[welcomeEmail] Could not read the stored template, using the default:', error);
  }

  const rendered = renderWelcomeEmailFromStrings(
    { subject: stored?.subject ?? '', bodyText: stored?.bodyText ?? '' },
    context,
  );

  return {
    ...rendered,
    bodyHtml: stored?.bodyHtml ? applyMergeFields(stored.bodyHtml, context) : null,
  };
}

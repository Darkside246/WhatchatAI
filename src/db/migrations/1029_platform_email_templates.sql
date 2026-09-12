-- Editable copy for the emails AURA sends on its own behalf.
--
-- WHY IN THE DATABASE. The wording of a welcome email is a product
-- decision, not an engineering one - it gets changed on a Tuesday because
-- it reads badly, and that should not need a deploy. The developer console
-- edits these rows; the code ships a default and uses it until somebody
-- overrides it.
--
-- PLAIN TEXT, and this is deliberate rather than unfinished. The single
-- biggest thing that keeps a transactional email out of the spam folder is
-- looking like a message a person sent: no image-heavy HTML, no tracking
-- pixel, no link-wrapping redirector, a high text-to-markup ratio. A
-- MailChimp-shaped block builder produces the exact opposite, and it
-- produces it for the one email that absolutely has to arrive - the one
-- carrying the verification link. body_html exists for when that tradeoff
-- is made knowingly; it is null by default and nothing sends HTML until it
-- is set.

CREATE TABLE IF NOT EXISTS platform_email_templates (
  -- 'welcome_verification' today. A short stable key rather than a uuid, so
  -- the code can ask for the template it means by name.
  template_key text PRIMARY KEY,

  subject text NOT NULL,
  body_text text NOT NULL,
  -- Optional, and off by default - see the note above about deliverability.
  body_html text,

  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Who last changed the words customers read. Nullable because a row can
  -- exist before anyone has edited it.
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

-- No RLS and no tenant grant. These are the PLATFORM's own emails, not a
-- business's - there is no tenant to scope them to, and only the developer
-- console writes them.

import DOMPurify from 'dompurify';

/**
 * Sanitising HTML before it is handed to dangerouslySetInnerHTML.
 *
 * Used for the legal documents on the Terms and Privacy pages. Those are
 * currently developer-authored - there is no HTTP route that writes a legal
 * document, so nothing a user controls reaches this today. That is exactly
 * why it is worth doing NOW: the protection wants to exist before somebody
 * adds an admin editor, not after, because the day it becomes reachable is
 * the day it becomes stored XSS and nobody will remember this render path
 * was unguarded.
 *
 * DOMPurify rather than a hand-written sanitiser. Writing one is a classic
 * way to be quietly wrong - mutation XSS, namespace confusion and the
 * browser's own parser quirks have defeated far more careful attempts than
 * anything that belongs in this file.
 *
 * The allow-list is deliberately narrow: what a terms-of-service or privacy
 * notice actually needs. No images, no iframes, no forms, no style
 * attributes - a legal document has never needed any of them, and each one
 * is a door.
 */

const ALLOWED_TAGS = [
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'sup', 'sub',
  'ul', 'ol', 'li',
  'blockquote', 'pre', 'code',
  'a',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'section', 'article', 'div', 'span',
];

const ALLOWED_ATTR = ['href', 'title', 'id', 'colspan', 'rowspan', 'class', 'lang', 'dir'];

/**
 * Cleans a legal document's HTML.
 *
 * Returns an empty string for empty input rather than null, so a caller can
 * hand the result straight to dangerouslySetInnerHTML without a branch -
 * a branch somebody would eventually write as `?? doc.contentHtml`, which
 * would undo the whole point.
 */
export function sanitizeLegalHtml(html: string): string {
  if (!html) return '';

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    // javascript:, data: and vbscript: hrefs are the obvious attack on the
    // one attribute a legal document genuinely needs.
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
    // No <template>, no <svg>, no MathML - the parser corners where mutation
    // XSS has historically lived.
    USE_PROFILES: { html: true },
    // Anything stripped is gone rather than escaped and shown as text: a
    // legal page displaying "<script>" to a reader is its own kind of wrong.
    KEEP_CONTENT: false,
    RETURN_TRUSTED_TYPE: false,
  });
}

/**
 * Forces every link in sanitised document HTML to open safely.
 *
 * target="_blank" without rel="noopener" hands the opened page a reference
 * back to ours via window.opener. Modern browsers imply noopener for
 * _blank, but "modern" is not every browser a customer uses, and the
 * attribute costs nothing.
 */
export function hardenLinks(container: HTMLElement | null): void {
  if (!container) return;
  for (const anchor of container.querySelectorAll('a[target="_blank"]')) {
    anchor.setAttribute('rel', 'noopener noreferrer');
  }
}

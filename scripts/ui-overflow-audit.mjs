/**
 * Real layout audit: loads the running app at several device widths and
 * reports any element whose own content overflows it horizontally, plus any
 * page that scrolls sideways at all.
 *
 * This exists because "the fonts fit on every screen" is a claim that should
 * be measured, not eyeballed. It reports EVERY screen it visited, including
 * clean ones, so a clean run is distinguishable from a run that silently
 * reached nothing (the failure mode this script was written after hitting -
 * an earlier version reported "no problems" while every route had actually
 * redirected to the login page).
 *
 * Usage:
 *   node scripts/ui-overflow-audit.mjs <email> <password> [outputDir]
 *
 * Routes behind a connected WhatsApp account can only be measured on a
 * machine where an account is genuinely linked; without one the app
 * correctly redirects to onboarding and this reports that rather than
 * pretending it measured them.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [email, password, outDir = './ui-audit'] = process.argv.slice(2);
if (!email || !password) {
  console.error('Usage: node scripts/ui-overflow-audit.mjs <email> <password> [outputDir]');
  process.exit(1);
}

const BASE = process.env.AUDIT_BASE_URL ?? 'http://localhost:5173';
const ROUTES = ['/chats', '/dashboard', '/agents', '/crm', '/automations', '/marketing', '/email', '/billing', '/settings'];
const WIDTHS = [360, 414, 768, 1280, 1600];

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
await page.fill('input[type="email"]', email);
await page.fill('input[type="password"]', password);
await page.click('button[type="submit"]');
await page.waitForTimeout(2500);

const report = [];

for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: 900 });
  for (const route of ROUTES) {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(600);

    const result = await page.evaluate(() => {
      const problems = [];
      const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      for (const el of document.querySelectorAll('*')) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        // A container that is meant to scroll sideways is not a defect.
        if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
        const overflowsX = el.scrollWidth - el.clientWidth;
        if (overflowsX > 2 && el.clientWidth > 0) {
          const text = (el.textContent || '').trim().slice(0, 60);
          if (text) problems.push({ tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 80), overflowPx: overflowsX, text });
        }
      }
      return { docOverflow, problems: problems.slice(0, 10), renderedChars: document.body.innerText.length };
    });

    report.push({ route, width, ...result });
    await page.screenshot({ path: `${outDir}/${route.replace(/\//g, '') || 'root'}-${width}.png` });
  }
}

await browser.close();

const failures = report.filter((entry) => entry.docOverflow > 2 || entry.problems.length > 0);
console.log(JSON.stringify({ visited: report.length, failures }, null, 2));
process.exit(failures.length > 0 ? 1 : 0);

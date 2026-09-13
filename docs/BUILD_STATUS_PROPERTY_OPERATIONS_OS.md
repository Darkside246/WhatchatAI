# Where the build is

Working branch: `build/property-operations-os`
Droplet: `/opt/aura` (compose project working dir, confirmed from the
`aura-caddy` container label — the repo is not in `/root`).

This is a status record, not instructions. It says what was built, what is
live, and what is known to be outstanding, so none of it has to be
reconstructed from memory or from a scroll-back that no longer exists.

---

## Deploying

Migrations apply themselves. `app-server`'s command is
`node dist/db/migrate.js && node dist/server/index.js`
(docker-compose.yml:233), so there is no separate migrate step.

The web bundle is baked into the image — the Dockerfile's build stage runs
`npm run build`, which includes the web workspace, and `dist` is copied into
the runtime image. This is why `VITE_`-prefixed values (the reCAPTCHA keys)
need a **rebuild**, not a restart: they are compiled into the bundle.

```bash
cd /opt/aura
git fetch origin build/property-operations-os
git checkout build/property-operations-os
git pull origin build/property-operations-os
docker compose build app-server app-worker
docker compose up -d
docker compose logs -f app-server
```

Backups already run on their own: the `postgres-backup` service dumps daily
to the `postgres-backups` volume, 7-day retention. For an extra one
immediately before a deploy:

```bash
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > pre-deploy.sql.gz
```

Check the file is megabytes. **A ~20-byte file is an empty gzip, not a
backup** — this has actually happened once. The database name is whatever
`$POSTGRES_DB` is (`whatchatai_dev` by default), never `whatchatai`.

---

## Pending on the droplet

Last deployed commit: `465f59c`. Nine commits since then, and three
migrations:

- `1042_driver_portal.sql`
- `1043_chat_workspace_flags.sql`
- `1044_message_workspace_flags.sql`

All three are `IF NOT EXISTS` / `DROP POLICY IF EXISTS` throughout, so
re-running is safe. The full set has been verified to apply against a fresh
database.

Also still to do on the droplet: the reCAPTCHA Enterprise env values
(site key `6Lc_0qstAAAAALvCbl-L08jkNb_kGW0D-A6cg0DF`, project
`gen-lang-client-0593221181`). They need the rebuild above, not a restart.

---

## The notification bug — three separate defects

Reported as "the notification bar on sync brings up old messages" and
"x-ing it out doesn't reset the count". Fixed in `51a6f0d`. Three genuinely
independent causes:

**1. The sync overwrote AURA's read state.** Every WhatsApp history sync
re-upserts the whole chat list, and the upsert wrote WhatsApp's own unread
count straight over ours. That count is the phone's opinion, and the phone
has no idea the operator read the conversation in AURA — so conversations
handled weeks ago came back with their counts restored. A sync may now
*lower* the count, never raise it (`LEAST(...)` in
`whatsappChatRepository.upsertFromWhatsApp`): a chat genuinely read on the
phone still clears here, a stale wire count cannot put it back, and a real
new message raises it through `recordLastMessage`, which is the only path
that should.

**2. The alert query had no unread filter at all**, unlike its sibling
`listNeedingHumanTakeover`. Every chat ever left in `HUMAN_TAKEOVER` stayed
on the pill for good, read or not. The two queries now agree on what
"outstanding" means.

**3. Dismissing was a local hide.** Closing the pill, or the X on a chat
notification in the bell, touched nothing server-side — so it came back on
the next page load and the chat's own count never moved. Both now mark the
conversation read, which is what opening it does. The handoff itself is
untouched, so the AI stays paused and a teammate keeps their own
notification.

**Not on the lock screen.** Nobody at a locked workspace has proved they
are the operator. Locked, the X quiets the pill on that screen only and the
pill opens nothing — previously it could navigate the router *underneath*
the overlay and mark a thread read without anybody entering a PIN.

Pinned by `test/syncUnreadResurrection.test.ts` (10 tests). Verified real:
reverting the two SQL changes fails 6 of them.

### Known follow-up, not yet done

The fix stops the sync re-raising counts; it does **not** retroactively
clear counts that are already wrong. As of the last conversation those
stale counts were still sitting on the live database. The plan agreed was
to deploy first, then scope a cleanup by age rather than blanket-resetting
everything, starting from:

```sql
SELECT count(*) FROM whatsapp_chats
WHERE unread_count > 0 AND deleted_at IS NULL
  AND last_message_at < now() - interval '7 days';
```

That separates genuinely stale rows from real unread messages from this
week that must not be cleared.

---

## What was built this session

**Dead API endpoints — all 19 closed** (`c37c114`, `21530a2`, `3812440`).
A sweep found 19 API client methods with no caller anywhere in the app.
Each was checked against its screen before wiring, rather than assumed.
The ones that mattered:

- A running funnel automation had **no stop control** — deactivating a
  funnel stops new enrolments and does nothing to runs already going.
- A lead's value, score, next action and notes were **display-only
  forever**; only the pipeline status could be changed.
- A counter order paid in cash had **no way to be recorded as paid at
  all** — both existing payment paths need a chat, which a counter order
  does not have by definition. Refunds had the same hole from the other
  end.
- An invoice's notes, terms, footer, due date and tax rate were frozen at
  creation, so a typo meant deleting the draft and retyping every line.
- A draft campaign's name and message could not be edited.
- Oversight finding history existed and nothing could read it back.
- `tier_unrestricted` was grantable only by API, so a business exempt from
  every plan gate looked identical to one that was paying.
- **Two `GET /developer/trials` handlers.** Express matches the first, so
  the second could never run — and the frontend was typed against the shape
  that dead handler would have returned. Duplicate removed.

Re-swept afterwards: zero dead endpoints remain. (Note for whoever sweeps
again: a naive `grep "api\.method"` misses the chained
`api\n  .method()` form and produces ~18 false positives.)

**Ticket printing to till printers** (`eb180f5`). ESC/POS byte generation
as a pure module with no device in it, which is what makes a printer this
codebase has never seen testable. Three transports: Bluetooth and USB where
the browser implements them, and the OS print dialog everywhere else — that
last is not a consolation prize, it is the only route on iPad and the right
one for a printer installed as a normal system printer.

Text is folded to what a printer can actually render (code page 437) before
any bytes go out: an accented name becomes its base letters, a curly quote
becomes a straight one. An unmapped byte prints as a random glyph on real
paper.

Two documents, deliberately not one with a flag. The kitchen ticket carries
food and no prices, brackets another station's lines rather than hiding
them, and puts the allergy warning **above** the food where a long ticket
cannot bury it. The receipt carries money, works tax out of the total
rather than adding it on top, and itemises priced modifiers so the lines
add up to the total printed under them.

Both forms of a ticket — the bytes and the printable sheet — are built by
the same calls, so they cannot drift into saying different things.

Printer config is **per device**, in browser storage, because that is what
it is: the screen at the pass has the kitchen printer, the counter has the
receipt printer, the owner's laptop has neither. The browser's device grant
does not travel either. Setup is a real pairing flow, and the status never
claims "connected" — a browser can revoke a grant and a cable can be pulled
without telling the page. It states when this device last actually printed,
and the test print is the only honest answer to "is it working now".

Auto-print is off by default and, when on, prints each order once from the
device that asked for it — the board is polled, so anything keyed on "is in
the kitchen now" would reprint until the roll ran out.

**Message actions** (`3b9345e`). The thread had no per-message actions at
all. Now: right-click menu (reply, copy, forward, pin, star, save, delete
for everyone), the hover forward arrow, and the multi-select forward picker.

Forwarding is a real send, not a pointer — WhatsApp has no "show this
person that message". Media forwards by its **stored reference** rather than
being re-downloaded and re-uploaded (the same mechanism campaigns use); an
attachment that has not finished downloading refuses with that reason
rather than quietly forwarding the caption alone. A location, poll or
shared contact is refused outright: a forwarded poll would be a new poll
nobody voted in. Several recipients answer **per recipient**, so forwarding
to six people where one conversation is stale tells you which five it
reached.

Starring and pinning are AURA's own marks in their own columns (migration
1044), for the same reason 1043 gave for conversations. Pins are per
business, not per person — a pin only its author can see is a note to self.

Deliberately left off the menu: "Ask Meta AI" (Meta's assistant, would
claim something untrue about where the text went), "Report" (files with
Meta, nothing here can do it), "Share"/"Open with" (OS handoffs a web page
cannot perform reliably; Save does the useful half).

**Chat-list right-click menu** (`a20c520`), built earlier in the session:
archive, mute with durations, pin, mark unread, favourite, add to list,
clear chat, delete chat. Deliberately no Block — a real WhatsApp block
changes the business's own account, and an item labelled "Block" that
quietly did something else would be the one lie people would trust.

**Counter register** (`afc424e`), Square-style order entry.

---

## Standing constraints

These have been stated explicitly and are not up for quiet reinterpretation:

- **No PII to Gemini, Groq or any external model.** Users get a warning
  prompt if they enter PII, with a toggle in their settings.
- **Nothing that compromises others' data protection or GDPR.**
- **Never disturb the Baileys/WhatsApp connection or force a QR re-scan.**
- **`MASTER_ENCRYPTION_KEY` must never change.** It must decode to exactly
  32 bytes — generate with `openssl rand -base64 32`, not hex.
- **No fake data.** No fabricated contacts, phone numbers or simulated
  messages, anywhere.
- **Never push to a branch other than `build/property-operations-os`.**
- **No CLAUDE.md in this repo** — explicitly asked for.
- **The core model does not change.** Baileys stays; no Cloud API
  migration. Only the food vertical is being extended.

---

## Outstanding

Asked for and not yet started:

- **Books / audit for food ops** — "a way we can audit and do our books
  from here". The data is already there: `food_payment_events` records
  from/to state, method, amount, reference, actor and waiver reason, and
  `food_order_events` records stage transitions with actor. What is missing
  is the view over it — takings by payment method, sales by item, tax, the
  exceptions register (waivers, refunds, unpaid releases with who and why),
  and a CSV export. `ServiceSummary` already covers "what happened today"
  and should be extended rather than duplicated.

Carried from earlier:

- Stale branch `fix-human-message-attribution-target` needs deleting via
  the GitHub web UI (403 from here).
- Menu item images for the register tiles (offered, not started).
- A pre-deploy migration dry-run against a restored production dump
  (offered, not started).
- WhatsApp-code fallback for password reset.
- base64 → multipart media upload.
- Location confidence scoring.

---

## Things worth not relearning

- **`message.callLogMesssage`** — three s's. A real typo in WhatsApp's
  protobuf, not ours.
- **Flexbox `min-width: auto`** — a flex item refuses to shrink below its
  content without `min-w-0`. This is what pushed the chat pane off-screen
  beside the kitchen board.
- **Tailwind v4 `@theme`** — `[data-theme]` overrides live *outside* the
  `@theme` block, so a token defined only inside it is theme-invariant.
- **The CSS token for errors is `error`**, not `danger`. There is no
  `bg-danger`.
- **Postgres and Redis in this dev container die when it is reclaimed.**
  Restart with `pg_ctlcluster 16 main start` and `redis-server --daemonize
  yes`. The `.env` goes too and has to be rewritten.
- **When adding an agent tool, grep for every site that pins the tool
  list.** There are at least three (`aiReplyService`, `agentGuard`,
  `openclawToolGateway`) and missing one fails the suite.
- **Test INSERTs into real tables**: query
  `information_schema.columns WHERE is_nullable='NO' AND column_default IS
  NULL` rather than guessing which columns are required.

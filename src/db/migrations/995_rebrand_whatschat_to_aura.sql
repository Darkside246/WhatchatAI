-- Brand cleanup: the product was renamed to Aura, but the original
-- "WhatsChat" name survived in three places that only ever get written
-- once, at seed time - editing the old seed migrations (906, 926, 922)
-- would never reach a database that already ran them, so this
-- corrective migration updates the real, already-inserted rows instead.

-- product_catalog.name (migrations 906, 926) - shown as the auto-
-- provisioned business name suffix (e.g. "<person> - WhatsChat Property")
-- and anywhere a vertical's product name is displayed.
UPDATE product_catalog SET name = REPLACE(name, 'WhatsChat', 'Aura') WHERE name LIKE '%WhatsChat%';

-- Terms of Service / Privacy Policy content (migration 922) - a single
-- REPLACE handles every mention, including "WhatsChat Technologies Ltd",
-- since that's just "WhatsChat" followed by more text.
UPDATE legal_documents SET content_html = REPLACE(content_html, 'WhatsChat', 'Aura') WHERE content_html LIKE '%WhatsChat%';

-- Any business auto-named from the old product_catalog default before
-- this migration ran (e.g. "Hasan - WhatsChat Property") gets the same
-- correction - a real business's own chosen name is untouched unless it
-- happens to contain this exact old product name.
UPDATE businesses SET name = REPLACE(name, 'WhatsChat', 'Aura') WHERE name LIKE '%WhatsChat%';

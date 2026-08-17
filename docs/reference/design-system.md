# Design system - type scale, control geometry, and how it is verified

Added in Phase F6. The goal was the one stated in the request: a symmetrical,
uniform layout with fonts that fit correctly on every element at every
viewing size.

## The problem this fixed

An audit of the frontend found **nine** distinct font sizes in use, including
`text-[9px]`, `text-[10px]` and `text-[11px]` - three near-identical values
that read as inconsistency rather than hierarchy, and 9px is genuinely too
small to be legible for many people. 66 elements used one of those three.

## The scale

Six steps, named for the job rather than the size, each with a paired
line-height. Defined in `src/web/src/index.css` under `@theme`.

| Class | Size | Use |
| --- | --- | --- |
| `text-meta` | 11px | timestamps, badge text, helper lines |
| `text-caption` | 12px | secondary labels, dense rows |
| `text-body` | 14px | the default reading size |
| `text-body-lg` | 16px | emphasised body, inputs |
| `text-title` | 18px | page and section titles |
| `text-display` | 24px | one hero figure per screen |

The three off-scale values collapsed into the single `text-meta` step.

**Rule for new code:** never write an arbitrary `text-[Npx]`. If a size seems
to be missing, the hierarchy is wrong, not the scale.

## Control geometry

A row looks broken when a button is 34px tall and the select beside it is
38px, however carefully each one's padding was tuned. Three permitted
heights, applied as classes that set geometry only - never colour - so every
theme keeps working:

| Class | Height | Use |
| --- | --- | --- |
| `.control-sm` | 32px | dense toolbars |
| `.control` | 36px | the default |
| `.control-lg` | 44px | primary actions; also the minimum comfortable touch target |
| `.field` | 36px | text inputs (not `inline-flex`, so it is a separate rule) |

`.min-w-0-safe` is the overflow guard: a flex child defaults to
`min-width:auto`, so a long unbroken string - an email address, a JID, a
customer name - pushes its container wider instead of truncating. That is the
single most common cause of text spilling out of a card on a narrow screen.

## How "it fits at every size" is verified

`scripts/ui-overflow-audit.mjs` loads the running app at 360 / 414 / 768 /
1280 / 1600 px, and reports any element whose content overflows it
horizontally plus any page that scrolls sideways.

```bash
node scripts/ui-overflow-audit.mjs you@example.com 'your-password'
```

It exits non-zero when anything overflows, so it can gate a release.

### What was actually measured, and what was not

Measured in the sandbox at all four widths, all clean (0px document
overflow, no overflowing elements): **login** and **onboarding / QR**.

**Not measured there:** every route behind a connected WhatsApp account.
`whatsappConnectionService` holds the connected account in process memory,
set only by a real device linking through a real QR scan - so those screens
genuinely cannot be reached in an environment without a linked phone, and
the app correctly redirects to onboarding instead. Run the script on a
machine with an account linked to cover them.

This distinction matters: an earlier version of the audit reported "no
problems found" while every route had silently redirected to the login page.
The script now reports every screen it visited and how many characters it
actually rendered, so a clean result cannot be confused with an empty one.

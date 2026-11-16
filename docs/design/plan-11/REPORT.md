# Plan 11 evidence: design foundation and the audit's L3 proposals

Date of the "after" capture: 2026-11-17 (Windows, Chromium). The "before" set was captured the same day on commit 7fc95c4, so dates shown on Your brain are identical in both sets.

## How to repeat it

```powershell
npm run build
$EVID = "C:/Users/<you>/AppData/Local/Temp/bibrain-plan11"
$flags = "--stable", "--styles", "--sizes=1280x900,768x1024,390x844"
node scripts/design-audit-walk.mjs "$EVID/after-light" @flags
node scripts/design-audit-walk.mjs "$EVID/after-dark" @flags --dark
node scripts/design-compare.mjs "$EVID/before-light" "$EVID/after-light" --expect-changes --report="$EVID/after-light.md"
node scripts/design-compare.mjs "$EVID/before-dark" "$EVID/after-dark" --expect-changes --report="$EVID/after-dark.md"
```

The walk uses a fresh throwaway brain. The large JSON style snapshots stay outside the repository; the committed images are in `before/` and `after/`.

## Foundation result (the stylesheet fold, before any visible change)

The fold (commits b2937e9 to 90d375e) was compared with the same walk at the same three sizes, 63 style snapshots and 84 screenshots per appearance.

| Comparison | Screenshots with a pixel difference | Style records that differ |
| --- | ---: | ---: |
| Fold, against the original baseline, light | 0 of 84 | 71 |
| Fold, against the original baseline, dark | 0 of 84 | 71 |
| Fold, against a baseline without the removed hidden layers, light | 0 of 84 | 5 |
| Same, dark | 0 of 84 | 5 |

The pixel count is 0. The style records are not 0 and each has a known cause: 63 are `body::before` (it had `display: none`, so nothing rendered), 3 are `.entry-card::before` (also `display: none`), and 5 are `flex-wrap: wrap -> nowrap` on the Projects list at phone width (an old rule written as `nav { ... }` leaked onto that list; it is now scoped to `.primary-nav`).

The rem type scale (commit e91e0f6) compared against the fold: 0 pixel differences in both appearances; 15 style records differ, all `row-gap`/`column-gap`/`justify-content` on Projects-list buttons (`0px` or `flex-start` to `normal`), a removed no-op.

## Intended changes (after against before)

All 63 style snapshots differ, because every signed-in screen's header changed, and `body::before` is gone. The table groups them. Light and dark reports read the same: 63 snapshots with a difference, 79 of 84 screenshots with a difference (the five without are first run at three widths and at 200% zoom, and Your brain's source view at tablet width).

| Snapshot group | What differs | Explained by |
| --- | --- | --- |
| 01-first-run (3 widths) | Style only: the hidden `::before` layers. No pixel difference. | Fold (refactor commits) |
| 01b-sample, 02 to 07 Today (all widths) | Header: Save something is gone in the local app on Today (the bar is the one way to save), the status line sits beside Today's title; the Settings link becomes an icon button on a phone. Phone and tablet bodies shift up by the header height; no body content change. | 67b2f46 (one save affordance), 9a4f56c (one-row phone header) |
| 08 to 10 Your brain, 11 to 12 Connections, 17 to 19 dialogs (desktop and tablet) | Header band only (about 0.04 to 0.09% of pixels): the header's right side is now one group. | 9a4f56c |
| Same states at phone | Header is one row (69px instead of 103px); everything below moves up by that amount. Dialog captures are viewport-only, so their backdrops and the rows behind them show larger pixel counts (up to 36% on the Project dialog) from that shift, not from a change in the dialog. | 9a4f56c |
| 13, 14, 20 Connections after Add, Set up by hand, handoff | A three-step checklist replaces the long setup paragraph; the long instructions are behind Details. Tile is shorter (page 13px shorter at 1280, 150px at 390). | e2324fa |
| 15, 16 Settings | One "Background help" card in three steps instead of three cards (page 497px taller at 1280, because every step is now shown with its explanation and gating hints). | 212a7d9, 5c4d0fd |
| Every state | Text sizes are rem; at the default browser size they equal the old pixel values. | e91e0f6 |

Not in the table, by design: no first-run, sample-body, Today-body, Your brain-body or dialog-body change. The first-run screen has no pixel change at all.

The checks file of each walk reports nothing of kind `contrast`, `text-under-12px`, `target-under-24`, `horizontal-scroll`, `past-viewport`, `no-accessible-name`, `dialog-focus-escapes` or `dialog-focus-return`. `touch-under-40` appears only for the inline links "Open it" and "Open the original", which the audit already accepted. The residual Connections layout shift (0.125, in the waiting state) is the known one.

## Before and after, six states at three widths

Light appearance (the dark set is in `before/dark` and `after/dark`):

| State | Width | Before | After |
| --- | --- | --- | --- |
| 01-first-run | desktop | ![](before/light/01-first-run--desktop.png) | ![](after/light/01-first-run--desktop.png) |
| 01-first-run | tablet | ![](before/light/01-first-run--tablet.png) | ![](after/light/01-first-run--tablet.png) |
| 01-first-run | phone | ![](before/light/01-first-run--phone.png) | ![](after/light/01-first-run--phone.png) |
| 02-today-empty | desktop | ![](before/light/02-today-empty--desktop.png) | ![](after/light/02-today-empty--desktop.png) |
| 02-today-empty | tablet | ![](before/light/02-today-empty--tablet.png) | ![](after/light/02-today-empty--tablet.png) |
| 02-today-empty | phone | ![](before/light/02-today-empty--phone.png) | ![](after/light/02-today-empty--phone.png) |
| 04-today-brief | desktop | ![](before/light/04-today-brief--desktop.png) | ![](after/light/04-today-brief--desktop.png) |
| 04-today-brief | tablet | ![](before/light/04-today-brief--tablet.png) | ![](after/light/04-today-brief--tablet.png) |
| 04-today-brief | phone | ![](before/light/04-today-brief--phone.png) | ![](after/light/04-today-brief--phone.png) |
| 08-brain-project | desktop | ![](before/light/08-brain-project--desktop.png) | ![](after/light/08-brain-project--desktop.png) |
| 08-brain-project | tablet | ![](before/light/08-brain-project--tablet.png) | ![](after/light/08-brain-project--tablet.png) |
| 08-brain-project | phone | ![](before/light/08-brain-project--phone.png) | ![](after/light/08-brain-project--phone.png) |
| 11-connections | desktop | ![](before/light/11-connections--desktop.png) | ![](after/light/11-connections--desktop.png) |
| 11-connections | tablet | ![](before/light/11-connections--tablet.png) | ![](after/light/11-connections--tablet.png) |
| 11-connections | phone | ![](before/light/11-connections--phone.png) | ![](after/light/11-connections--phone.png) |
| 15-settings | desktop | ![](before/light/15-settings--desktop.png) | ![](after/light/15-settings--desktop.png) |
| 15-settings | tablet | ![](before/light/15-settings--tablet.png) | ![](after/light/15-settings--tablet.png) |
| 15-settings | phone | ![](before/light/15-settings--phone.png) | ![](after/light/15-settings--phone.png) |

The Connections checklist, as it looks right after adding an agent (nothing ticked yet, because no call has been recorded): [light](after/light/13-checklist.png), [dark](after/dark/13-checklist.png), captured at 1280px. In this walk, an agent note is posted before the picture; a note alone does not tick a step, so the picture shows all three open, which is true to the recorded data. The first two steps tick from the first recorded call and the third from the first recorded push.

## Limits

- Chromium only; no screen reader was listened to.
- Computed styles were captured with reduced motion on, so transition timing was not compared.
- Forced hover, focus and pressed states were captured at 1280px only.
- The hosted edition's plan card cannot be walked here; it rests on the static stylesheet test and the frozen browser spec.
- Phone-width dialog pixel counts are inflated by the header shift described above.

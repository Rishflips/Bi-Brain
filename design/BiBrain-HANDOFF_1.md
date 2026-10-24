# BiBrain prototype — handoff

Source of truth: `docs/DESIGN_BRIEF.md` (approved brief, 2026-10-19; formerly `design.md`). Everything visible in the prototype is either synthetic **Demo data** ("Northstar launch") or an empty **Preview** brain that keeps saves in the browser tab only. No backend, integration, payment, or user history exists here.

## For the founder (plain language)

- Open `dist/index.html` in any browser. No install needed.
- **Try an example** shows the full product with made-up demo content.
- **Open my brain** accepts any code shaped like `ABCD-1234-EFGH` and opens an empty preview brain. The real app will check the code; this preview doesn't.
- **Prototype controls** (bottom of the left rail, or the sliders icon on phones) let you flip Today between all seven states, choose what the next save does (saved / duplicate / failed), choose whether preparation succeeds, and switch light/dark/reduced motion. These controls aren't part of BiBrain.
- When you hand this to Claude Code to connect it to the real BiBrain, give it this file. The list under "Fixture behaviors that need real wiring" is the to-do list.

## Run it as a developer

```bash
npm install
npm run dev        # local dev server
npm run build      # typecheck + single-file build to dist/index.html
```

React 18 · TypeScript (strict) · Vite. No UI library, no router library, no state library. Plain CSS with design tokens as CSS variables.

## File map

```
bibrain/
├─ index.html                     Vite entry
├─ HANDOFF.md                     this file
├─ screenshots/                   1440×1024 and 390×844, light + dark, plus flow captures
├─ dist/index.html                built single-file prototype
└─ src/
   ├─ main.tsx                    mounts <App/>, loads CSS
   ├─ domain/types.ts             ALL view models and state unions (the state model)
   ├─ fixtures/demoWorkspace.ts   synthetic "Northstar launch" data — DEMO DATA ONLY
   ├─ adapters/
   │  ├─ BrainAdapter.ts          the service seam (interface) + limits
   │  └─ fixtureAdapter.ts        deterministic in-memory stand-in  ← replace for wiring
   ├─ app/
   │  ├─ controller.ts            usePrototypeController: app state + every mutation callback
   │  ├─ App.tsx                  routes, theme, motion, focus/announcements, wires screens
   │  └─ PrototypeControls.tsx    reviewer-only state switcher
   ├─ screens/                    page compositions (no service calls)
   │  ├─ FirstUseScreen.tsx       local first use + pairing
   │  ├─ TodayScreen.tsx          hero, living field, prepared work, pick-up list
   │  ├─ SaveSheet.tsx            Save something modal/sheet + receipt
   │  ├─ BrainScreen.tsx          search, scopes, filters, projects, source panel/route, source dialogs
   │  ├─ ConnectionsScreen.tsx    knowledge sources, agents, permission preview, revoke/disconnect
   │  ├─ SettingsScreen.tsx       appearance, background help, spending, plan, privacy, security
   │  └─ ComponentGallery.tsx     /#components — every variant + token sheet
   ├─ components/                 presentational, props + callbacks only
   │  ├─ BrandLockup.tsx          official PNGs, nondestructive crop, white plate
   │  ├─ AppShell.tsx             AppShell, PrimaryNavigation, BackgroundHelpStatus
   │  ├─ Button.tsx               Button, IconButton
   │  ├─ StatusPill.tsx
   │  ├─ LivingField.tsx          + fieldCopy, fieldStateFor()
   │  ├─ Capture.tsx              SaveComposer, SavedReceipt, PreparationStatus
   │  ├─ Search.tsx               SearchField, SourceRow
   │  ├─ SourceViewer.tsx         tabs: Original, Understanding, History, Used in
   │  ├─ Prepared.tsx             PreparedCard, EvidenceList, RevisionComparison
   │  ├─ Connections.tsx          KnowledgeSourceRow, AgentRow, PermissionPreview
   │  ├─ Dialog.tsx               Dialog (focus trap), ConfirmDialog
   │  ├─ Feedback.tsx             InlineNotice, EmptyState, Skeleton, DemoBanner, Toasts
   │  └─ Icon.tsx                 inline stroke icons (1.75px)
   ├─ lib/format.ts               deterministic date formatting, type labels
   ├─ lib/hooks.ts                useMediaQuery, hash router
   ├─ styles/tokens.css           color (light/dark), type, space, radius, shadow, motion
   ├─ styles/app.css              component + layout styles, reduced motion
   └─ assets/brand/               bibrain-lockup.png (1672×941), bibrain-emblem.png (1254×1254) — unmodified official files
```

Routes: `/#today`, `/#brain`, `/#brain/source/<id>`, `/#connections`, `/#settings`, `/#components` (reviewer only).

## State model (`src/domain/types.ts`)

| Input | Type | Values |
| --- | --- | --- |
| `sessionState` | `SessionState` | `first-use` · `pairing` · `pairing-error{message}` · `local{preview}` · `demo{workspaceName}` |
| `brainState` | `BrainState` | `new` · `quiet` · `active` · `review` · `failure` · `paused` · `offline` |
| field treatment | `FieldState` (derived by `fieldStateFor(brainState, organizing)`) | `ready` · `organizing` · `current` · `review` · `quiet` · `paused` · `offline` · `failed` |
| `captureState` | `CaptureState` | `empty` · `drafting` · `saving` · `saved{receipt}` · `duplicate{existing}` · `too-large{current,limit}` · `unsupported-file{fileName}` · `write-failed{message}` |
| `preparationState` | `PreparationState` | `idle` · `preparing` · `prepared` · `delayed` · `failed` — tracked separately; never reverses a save |
| `searchState` | `SearchState` | `empty` · `loading{query}` · `results{query,results}` · `no-results{query}` (+ offline shown by the field) |
| `connectionState` | `ConnectionState` | `not-connected` · `awaiting-authorization` · `checking` · `connected` · `needs-attention` · `revoked` |
| `backgroundHelpState` | `BackgroundHelpState` | `on` · `paused` · `quiet-hours` · `offline` |
| `appearance` | `Appearance` | `light` · `dark` · `system` (sets `html[data-theme]`) |
| `reducedMotion` | `boolean` | device `prefers-reduced-motion`, or reviewer override |

Prepared items: `PreparedStatus` = `prepared` · `accepted` · `snoozed` · `dismissed` · `stale`; `laterWorkExists` swaps Undo for **Compare versions**. Evidence: `EvidenceState` = `complete` · `partial` · `unavailable` · `source-removed`. Revisions: `RevisionState` = `clean` · `conflict` · `newer-edit`. Understanding statements: `source-backed` · `user-correction` · `hypothesis` · `updating` · `stale` · `withdrawn`.

## Callback surface (`app/controller.ts`)

| Area | Callbacks |
| --- | --- |
| Session | `pair(code)`, `startDemo()`, `signOut()` |
| Capture | `openCapture`, `closeCapture`, `changeDraft`, `importFile(file)`, `save({allowDuplicate?})`, `retryPreparation` |
| Search | `setQuery`, `setScope`, `setFilters` (search runs from an effect via `adapter.search`) |
| Sources | `editUnderstanding`, `correctSource`, `withdrawSource(id, bool)`, `deleteSource`, `copyBrief`, `downloadSource`, `exportAll`, `deleteEverything` |
| Prepared | `acceptPrepared(id, artifact)`, `undoPrepared`, `snoozePrepared`, `dismissPrepared`, `restorePrepared` |
| Connections | `connectKnowledge`, `cancelKnowledge`, `disconnectKnowledge(id, removeImported)`, `createAgentGrant`, `updateAgentGrant`, `revokeAgent`, `cancelAgent`, `revokeAllAgents` |
| Settings | `updateSettings(fn)` |

Visual components never import the controller, fixtures, or adapters.

## Component inventory

| Component | File | Variants / states | Key props |
| --- | --- | --- | --- |
| `BrandLockup` | BrandLockup.tsx | horizontal, emblem, compact, light plate | `variant`, `width`, `plate`, `alt` |
| `AppShell` | AppShell.tsx | desktop rail ≥1024, tablet header 800–1023, phone top region <800 (all in flow) | `route`, `nav`, `backgroundHelp`, `onSaveSomething` |
| `PrimaryNavigation` | AppShell.tsx | default, selected, attention badge, disabled | `items`, `current` |
| `Button` | Button.tsx | primary, gold, secondary, ghost, destructive, destructive-solid, loading, disabled, sm | `variant`, `loading`, `loadingLabel`, `icon` |
| `IconButton` | Button.tsx | default, selected (`aria-pressed`), destructive, disabled | `icon`, `label` (required) |
| `StatusPill` | StatusPill.tsx | ready, updating, prepared, stale, paused, offline, failed, success, attention, demo — always icon + text | `status`, `label` |
| `LivingField` | LivingField.tsx | 8 field states; decor is `aria-hidden`; no motion in quiet/paused/offline/failed/reduced | `state`, `reducedMotion` |
| `SaveComposer` | Capture.tsx | empty, drafting, saving, too-large, unsupported file, write failed (draft kept), duplicate, disabled | `draft`, `state`, `limitChars`, `onSave` |
| `SavedReceipt` | Capture.tsx | saved, duplicate, preparing, prepared, delayed, preparation failed | `receipt` (service-returned), `preparation` |
| `SearchField` | Search.tsx | empty, active, loading, results, no results, offline | `value`, `state`, `resultCount` |
| `SourceRow` | Search.tsx | current, updating, stale, withdrawn, selected; keyword highlight | `source`, `result`, `selected` |
| `SourceViewer` | SourceViewer.tsx | Original (default), Understanding, History, Used in; keyboard tabs | `source`, `tab`, all source callbacks |
| `PreparedCard` | Prepared.tsx | collapsed, expanded, editing, accepted (Undo / Compare versions), snoozed, dismissed, stale | `item`, `initialView`, prepared callbacks |
| `EvidenceList` | Prepared.tsx | complete, partial, unavailable, source removed | `evidence`, `onOpenSource` |
| `RevisionComparison` | Prepared.tsx | clean, conflict, newer edit present | `state`, `before`, `kept`, `newer` |
| `KnowledgeSourceRow` / `AgentRow` | Connections.tsx | all six connection states | `conn` / `grant` + actions |
| `PermissionPreview` | Connections.tsx | read only, propose enabled, expiring, revoked; editable form | `variant`, `draft`, `editable` |
| `EmptyState` | Feedback.tsx | new brain, quiet, no results, no connections | `variant`, `title`, `body`, `actions` |
| `InlineNotice` | Feedback.tsx | info, attention, failure, success, offline; optional live region | `tone`, `title`, `live` |
| `ConfirmDialog` | Dialog.tsx | ordinary, destructive, permanent (type-to-confirm) with scope/backups/copies/reversibility | `variant`, `consequences`, `confirmPhrase` |
| `Dialog` | Dialog.tsx | modal ≥800, full-height sheet <800; focus trap, Escape, focus return | `title`, `size`, `dismissible` |
| `Skeleton` | Feedback.tsx | text, row, card, hero | `variant` |

Stable hooks: `data-ui="primary-navigation" | "save-something" | "living-field" | "saved-receipt" | "brain-search" | "prepared-review" | "connection-row"` (plus `source-viewer`, `save-composer`, `permission-preview`, `first-use`).

## Fixture behaviors that need real wiring

Every item below is fake in the prototype and must be replaced with the existing BiBrain services.

1. **Pairing** — `fixtureAdapter.pair` only checks the code's shape (`XXXX-XXXX-XXXX`) after 700 ms. Wire to the local installation's real code check and session.
2. **Saving** — `fixtureAdapter.save` waits 650 ms and returns a receipt built from the trimmed draft with a counter ID (`local-src-0201`) and a fixed clock (`2026-10-19 09:30`). Real receipts must come from the durable write (retained content, title, source ID, destination, timestamp), including quarantine/rejection.
3. **Save outcome** — duplicate and write-failed results are chosen in Prototype controls (exact-title matches are always flagged duplicate). Wire to real duplicate detection and write errors.
4. **Size limit** — `CAPTURE_LIMIT_CHARS = 20,000` is a placeholder. Use the service's real limit.
5. **File import** — `.txt`/`.md` read in the browser via `File.text()`. Confirm accepted types and limits with the service.
6. **Preparation** — `fixtureAdapter.prepare` waits 1.8 s and returns the reviewer-chosen outcome. Wire to real durable work status (and push/poll updates).
7. **Search** — keyword "every word must appear" match over title + excerpt, 280 ms delay, snippet built locally. Wire to the real search; keep it labelled as matching notes, never as an answer.
8. **Source history** — only the latest version's text exists; citations to older versions show a notice and highlight the version in History. Wire to real versioned originals so **See source** opens the exact version.
9. **Edit understanding / Correct source** — update in-memory state and mark older-version statements stale. Wire to real correction + versioning + evidence revalidation.
10. **Withdraw / Delete permanently / Delete everything** — in-memory only. Wire to real withdrawal, deletion, backup and delivered-copy handling.
11. **Copy brief / Download Markdown / Export** — generated in the browser from in-memory data. Wire to the service's brief/export format.
12. **Prepared work** — the three items are fixtures. Keep / Undo / Later / Not useful flip status in memory; "Undo creates a compensating version" is copy only. "Newer work exists" and the Compare-versions newer edit are fixture text. **Prepare again** shows "not available in this preview". Wire all to real goal-linked work and versioning.
13. **Connections** — all demo rows are synthetic. **Connect** stops at *Awaiting authorization* by design; nothing ever becomes Connected in the preview. Wire Connected to a verified round trip only. **Disconnect → remove imported notes** only zeroes the count.
14. **Agent access** — **Create access** adds a pending row; no grant exists. Revoke / Revoke all / Save changes are in-memory. Wire to real scoped grants, expiry and verification.
15. **Background help, quiet hours, spending limits, outside-processing consent** — controls change local state only; nothing enforces them. Time zone is read from the browser.
16. **Plan** — Managed plan is labelled "Unavailable in this preview"; no prices or checkout.
17. **Sign out / sessions** — returns to first use; there is one fake session ("This browser").
18. **Offline** — set from Prototype controls, not from real connectivity.
19. **"Checking N sources"** (Today active state) — count is derived from fixtures.
20. **Toasts** — auto-dismiss after 7 s via a timer in the controller.

## Decisions left open (per brief)

Authentication provider, model/provider names and prices, Paddle catalog/checkout, native agent branding, notification delivery, hosting/analytics, legal copy, trademark clearance, license. The official logos are the supplied raster PNGs; no SVG was produced.

## Checks run

- `tsc --noEmit` (strict) passes; build passes.
- No horizontal scroll at 320, 360, 390, 768, 1024, 1440 px on first use, Today, Your brain, source detail, Connections, Settings, Component states.
- No console errors through first use → pairing error → pairing → save → receipt → demo → review → keep → source tabs → search (results/no results) → permission preview → permanent delete dialog.
- Not yet run: automated contrast audit, screen-reader pass, 200% zoom pass. Recommend running these during wiring.

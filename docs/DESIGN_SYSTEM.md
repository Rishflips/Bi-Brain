# BiBrain design system

## Product character

BiBrain should feel like a private, dependable place to think: quiet, editorial,
direct and exceptionally clear. It is a working product, not an AI demonstration.
The interface earns liveliness through responsive behavior, truthful state and
well-timed feedback rather than decorative networks, glass effects or invented
activity.

The official black-and-gold mark is the strongest visual signature. Everything
around it should be restrained enough for the user's own material to remain the
focus.

## Core tokens

| Token           | Light     | Dark      |
| --------------- | --------- | --------- |
| Canvas          | `#F7F5EF` | `#111111` |
| Surface         | `#FFFEFA` | `#191918` |
| Raised surface  | `#FFFFFF` | `#20201E` |
| Text            | `#181817` | `#F4F1E9` |
| Secondary text  | `#6A6861` | `#AAA69D` |
| Border          | `#D9D5CA` | `#34332F` |
| Primary action  | `#181817` | `#F4F1E9` |
| Text on primary | `#FFFFFF` | `#181817` |
| Gold accent     | `#D6A900` | `#E3B500` |
| Gold wash       | `#F4E9B4` | `#3B3414` |
| Attention       | `#9B4B1B` | `#F0A986` |

Verify contrast against the rendered background. A token name is not evidence of
accessible contrast.

## Typography and spacing

Use the self-hosted Manrope variable font with platform sans-serif fallbacks. No
font CDN is required.

One scale for the signed-in workspace (Today, Your brain, Connections, Settings).
The 2026-11 audit found Today's page title at 40px/750 while the other three used
58px/620, so the same level of page looked like two products:

| Role | Size | Weight |
| --- | --- | --- |
| Page title (h1) | 40px, down to 30px on small screens | 650 |
| Section heading | 18–22px | 650 |
| Card or item title | 16–17.5px | 650 |
| Body | 15–16px | 400 |
| Supporting text and metadata | 13–14px | 400–600 |
| Smallest text, including eyebrows, tags and pills | 12px | 600–700 |

- **First use:** may keep its editorial headline at 46–66px. Signed-in headings do not.
- **Weights:** 400, 600 and 650; 700 is for the small sizes only. The audit found 750 and 800 on Today; both are gone.
- **Nothing under 12px.** The audit found eyebrows at 10px, the rail note at 11px and tags at 11.5px.
- **A link inside a line of metadata takes that line's size.** The audit found a 16px gold "Open the original" inside a 13px line in Your brain, louder than the fact it served.

Use a 4px base and an 8px primary spacing rhythm.

## Shape, focus and elevation tokens

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--radius-control` | 9px | 9px | Buttons, inputs, selects, segmented controls |
| `--radius-card` | 14px | 14px | Cards, panels, tiles, dialogs |
| `--focus` | `#7A5C00` | `#FFD247` | A 2px solid outline with a 2px offset on every focusable element |

- **Radii.** Before the audit, cards used 16px on Today, 12px in Your brain and 14px on Connections.
- **Focus.** It must reach 3:1 against every surface, so it is never a tint: the earlier 48% gold measured about 1.3:1. A composite control may draw one ring around itself instead of two nested ones; the Today bar does this.
- **Elevation.** A surface uses a border or a shadow, not both. Shadows are for floating layers only: dialogs, the toast, and the first-use card.

## Layout

Desktop uses a narrow navigation rail and a content column with a readable line
length. Today pairs a short orientation with a compact, truthful state card and
keeps direct capture visually dominant. Evidence may open in a detail panel or
dialog without obscuring the current task.

Mobile places Today, Your brain and Connections in one stable row above the
content. Detail views become full width, actions wrap intentionally, and the page
must remain usable at 320px without horizontal scrolling.

First use pairs one product story with one protected opening action. It must
explain local ownership and optional AI preparation before asking for an
installation code, without displaying or embedding that secret.

## Interface finishing rules

- Use a flat canvas, solid surfaces, hairline borders and minimal shadows.
- Give each region one obvious primary action, and only that action is a dark
  button. The audit found two dark "Save" controls side by side in the Today bar,
  and a dark Add button on every Connections tile, including "Not found on this
  computer". Secondary actions stay visually quieter and remain proper semantic
  controls.
- Put a choice control (checkbox or radio) at the start of its label, with a hanging
  indent so the words and any trailing hint stay one line of text. Never let
  text-input styling reach a radio: the audit found radios drawn as 320×13 bars in
  Connections → Add and in Settings → Better search.
- Loading must not displace the page. Show a status that is out of flow, or show
  nothing for a short wait, rather than a frame the real page then pushes. The
  audit measured a 0.47–0.90 layout shift on every reload from exactly this.
- Wrap file pickers in a labelled button. Never show the browser's "Choose Files /
  No file chosen" control. The audit found two in Connections → Bring more context in.
- Dark appearance: colors tuned for paper fail on the dark canvas. Use the light
  gold signal (`#E6C85E` or `#F2C735`) for gold text in dark appearance. The audit
  found first-use and Settings text at 2.1–2.8:1.
- Use gold for the brand, focus, selected state and genuine attention—not as
  ambient decoration or a substitute for hierarchy.
- Do not use ornamental brain art, neural networks, orbit scenes, floating glows,
  glass panels, dashboard statistics or fake signal activity.
- Avoid repeated rounded cards when spacing, a divider or a heading can express
  the same grouping.
- Keep status language literal. A small state indicator may animate only while
  real work is active; quiet and caught-up states remain still.
- Respect reduced-motion preferences. Never make essential meaning depend on
  animation or color alone.
- Use visible focus treatment, persistent labels, useful empty states and
  disabled explanations for every interactive surface.

## Components

AppShell, PrimaryNavigation, SaveDialog, SourceViewer, BriefEditor, PreparedItem,
EvidenceList, RevisionComparison, ConnectionRow, PermissionEditor,
BackgroundPreferences, StatusMessage, EmptyState and ConfirmDeletion.

Each component needs loading, empty, error, keyboard-focus and disabled states
where relevant. Every visible control must have real behavior or clearly state why
it is unavailable.

## Language

Prefer **Save something**, **Your brain**, **Use with an agent**, **See sources**,
**Keep this plan**, **Stay ahead**, **What changed** and **What BiBrain remembers**.

Keep ingest, embeddings, context packer, classifier confidence, cron, vector store,
tokens, queues and memory consolidation out of primary screens. Explain the user
impact in advanced settings when a technical concept is unavoidable.

Do not say “Your brain learned this” when only a queued job exists. Do not say “I
noticed” unless the observation follows from available evidence. Speculative
suggestions must be labeled in text.

## Interaction and trust

Preserve typed text after errors. Success messages confirm only the operation that
actually completed. Destructive actions explain scope and retention. Acceptance
and undo must keep their version checks. Offline, stale, uncertain and failed
states use plain language and never imply successful background intelligence.

## Production evidence

`scripts/design-audit-walk.mjs` walks the core paths in a real browser at 1440,
820 and 390px, and at 200% zoom. It records overflow, target size, contrast, small
text, layout shift and dialog focus. Run it before and after visual changes; the
2026-11 results are in [design/AUDIT-2026-11.md](design/AUDIT-2026-11.md).


`docs/screenshots/today-v2-brief.png` shows the current paired Today surface and
`docs/screenshots/source-preview.png` shows the source workflow. Both are generated
from real browser journeys using synthetic data. Older files under `design/` are
concept references only; the implemented interface and UX specification remain
authoritative.

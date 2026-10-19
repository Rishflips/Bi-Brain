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
font CDN is required. Body copy is 15–16px, supporting text never drops below
12px, and application headings stay compact. First-use editorial headlines may
scale up to 58–66px on large screens, but signed-in workspace headings should not
look like landing-page marketing.

Prefer regular, medium and semibold weights. Use a 4px base and an 8px primary
spacing rhythm. Controls use an approximately 9px radius; cards and dialogs use
12–14px. Generous whitespace should come from layout, not oversized controls.

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
- Give each region one obvious primary action. Secondary actions stay visually
  quieter and remain proper semantic controls.
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

`docs/screenshots/first-use.png` shows the current paired Today surface and
`docs/screenshots/source-preview.png` shows the source workflow. Both are generated
from real browser journeys using synthetic data. Older files under `design/` are
concept references only; the implemented interface and UX specification remain
authoritative.

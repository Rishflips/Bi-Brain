# Design direction

## Intent

Calmly alive, readable, personal, and competent. Use content, continuity, and
evidence as the visual focus. The interface may have a recognizable pulse and
subtle state-driven motion, but it must feel like a dependable personal space—not
a control panel or a decorative AI spectacle. The reference preview is a concept,
not production code or evidence that actions work.

## Current core tokens

| Token | Light | Dark |
|---|---|---|
| Canvas | #F4F1E9 | #0B1712 |
| Surface | #FFFDF8 | #15241D |
| Text | #16251F | #EDF1EB |
| Secondary text | #5B6B63 | #B2BBB3 |
| Border | #D7DFD6 | #344A3E |
| Primary action | #174C38 | #B1D2B8 |
| Text on primary | #FFFFFF | #192C20 |
| Subtle highlight | #E9F0E8 | #2A362C |
| Living signal | #63A47A | #8FB79A |
| Quiet accent | #BDDA7E | #BDDA7E |

Verify contrast against actual backgrounds; token choice alone is not accessibility verification.

Use a locally available system sans-serif. Body text is 15–16px and supporting
text is at least 12px. Product headings may scale fluidly from 28px to 68px;
editorial emphasis may use the system serif fallback. Prefer regular and medium
weights. Use an 8px spacing rhythm, pill-shaped actions where appropriate,
14–30px surface radii, and generous margins.

## Layout

Desktop: narrow navigation rail, content area with readable maximum line length, optional evidence detail panel.
Mobile: compact navigation above or below content; detail views become full-width.
First-use pairs one product story with one protected opening action. After pairing,
Today pairs a short orientation with the real brain-state surface and keeps direct
capture visually dominant.

Atmospheric gradients, a sparse cognitive field, and an abstract neural form are
part of the current identity. They must stay lightweight, decorative, and
`aria-hidden`; they cannot imply invented connections, memories, intelligence, or
completed work. Avoid spinning graphs, large statistic tiles, infinite activity,
and fake signal indicators. The Today neural surface may animate nodes or breathe
only for a real active/attention state. Resting and quiet states remain still.

## Components to build

AppShell, PrimaryNavigation, SaveDialog, SourceViewer, BriefEditor, PreparedItem, EvidenceList, RevisionComparison, ConnectionRow, PermissionEditor, BackgroundPreferences, StatusMessage, EmptyState, ConfirmDeletion.

Each component needs loading, empty, error, keyboard-focus, and disabled states where relevant.

## Copy

Prefer Save something, Your brain, Use with an agent, See sources, Keep this plan,
Stay ahead, What changed, and What BiBrain remembers.

Avoid ingest, embeddings, context packer, classifier confidence, cron, vector store, and memory consolidation in primary screens. Explain actual user impact in advanced settings.

Do not say Your brain learned this when only a queued job exists. Do not say I noticed unless the observation follows from available evidence.

## Interaction

Use subtle state transitions; respect reduced motion. Preserve typed text after errors. Destructive actions explain scope and retention. Success messages confirm the actual completed operation. Display speculative suggestions with textual labels, not color alone.

## Visual reference and production evidence

See `docs/screenshots/first-use.png` for the current production Today surface and
`docs/screenshots/source-preview.png` for the source workflow. Both are generated
by a real browser journey using synthetic data. The older
`design/reference-light.png` and `design/reference-dark.png` files remain concept
references only; the implemented UI and UX specification are authoritative.

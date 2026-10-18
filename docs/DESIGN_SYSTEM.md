# Design direction

## Intent

Calmly alive, readable, personal, and competent. Use content, continuity, and
evidence as the visual focus. The interface may have a recognizable pulse and
subtle state-driven motion, but it must feel like a dependable personal space—not
a control panel or a decorative AI spectacle. The reference preview is a concept,
not production code or evidence that actions work.

## Suggested tokens

| Token | Light | Dark |
|---|---|---|
| Canvas | #FBFAF7 | #191B19 |
| Surface | #FFFFFF | #232623 |
| Text | #202C28 | #EDF1EB |
| Secondary text | #64706A | #B2BBB3 |
| Border | #E0E6DE | #3D453E |
| Primary action | #315C46 | #B1D2B8 |
| Text on primary | #FFFFFF | #192C20 |
| Subtle highlight | #EDF3EB | #2A362C |

Verify contrast against actual backgrounds; token choice alone is not accessibility verification.

Use a locally available system sans-serif initially. Body 15–16px, supporting text at least 12px, headings 24–30px. Prefer regular and medium weights. Use an 8px spacing rhythm, 8px control radii, 12px content card radii, and generous margins.

## Layout

Desktop: narrow navigation rail, content area with readable maximum line length, optional evidence detail panel.
Mobile: compact navigation above or below content; detail views become full-width.
First-use screen focuses on one capture field and two actions.

Avoid ornamental gradients, floating brain illustrations, spinning neural graphs,
large statistic tiles, unnecessary gradients, and fake activity indicators. A
small abstract BiBrain pulse is allowed when its label and motion map to real
application state. Resting and quiet states remain visually still.

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

## Visual reference

See design/reference-light.png and design/reference-dark.png for the approved conversation direction. These depict sample data. Treat the UX specification as authoritative where reference controls were simulated.

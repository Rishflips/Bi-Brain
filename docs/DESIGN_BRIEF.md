---
meta:
  title: Design the BiBrain product experience
  navLabel: Claude Design brief
  category: Design
  contentType: Reference
  audience: Product designers and frontend designers using Claude Design
  status: Approved product design brief
  updated: 2026-10-19
---

# Design the BiBrain product experience

This brief defines the complete visual and interaction direction for a responsive BiBrain prototype. Use it with the two supplied official logo files to create the product shell and its principal workflows. The result must feel distinctive, alive, and premium while preserving BiBrain's real product behavior, plain language, and safety boundaries.

## Use this brief as the source of truth

Create a polished, responsive product prototype that another engineer can later connect to the existing BiBrain services. Build the interface and local prototype interactions only. Do not invent a backend, claim an integration succeeded, simulate a payment, or present generated sample content as user history.

Design the following surfaces:

1. Local first use and installation pairing
2. Today in new, quiet, active, review, failure, paused, and offline states
3. Save something and its durable saved receipt
4. Your brain search, results, projects, and source detail
5. Prepared-item review with evidence and safe accept or undo states
6. Connections for knowledge sources and agents
7. Settings and privacy
8. Responsive desktop, tablet, and phone layouts
9. Light and dark appearance

The prototype must use reusable components, semantic controls, and explicit state inputs. Keep visual state separate from service logic so the existing React application can adopt the design without replacing its tested domain behavior.

## Preserve the product truth

BiBrain is the user-owned memory and continuity layer behind the agents a person chooses. It is a central unit for saved work, corrected understanding, goal-linked preparation, and scoped context transfer. It is not another chatbot and it does not trap memory inside one model provider.

The public promise is:

> One brain. Every agent. Always caught up. A little ahead.

The primary experience is:

> Save → Continue → Stay ahead

Preserve these product rules:

- Keep **Today**, **Your brain**, and **Connections** as the primary navigation
- Make useful first value available before account integrations
- Keep graphs, model names, tokens, queues, classifiers, and protocol terminology out of the primary flow
- Give every visible control a prototype behavior or a clear unavailable state
- Never invent memories, connections, citations, completed jobs, intelligence, or historical user data
- Label all prototype content as synthetic sample data
- Show uncertainty, stale context, failed work, and offline states in plain language
- Treat quiet as a valid product state
- Keep all proactive work evidence-backed, reviewable, and reversible
- Never imply that BiBrain sends, purchases, publishes, or deletes externally without explicit action

## Express the brand as quiet intelligence

The visual idea is **quiet intelligence with stored momentum**. The product should feel like a private place where thought stays alive, not like a technical dashboard, crypto product, luxury bank, or science-fiction control room.

Balance four qualities:

- **Grounded**: strong black structure, stable layouts, clear hierarchy
- **Alive**: warm gold signals, restrained state motion, soft spatial depth
- **Personal**: generous room, humane copy, saved-work focus
- **Trustworthy**: visible evidence, specific status language, reversible actions

Avoid these visual directions:

- Literal brain illustrations
- Dense neural-network graphs
- Decorative circuitry
- Constant particle motion
- Gold gradients on every surface
- Black and gold styling that resembles gambling, cryptocurrency, or luxury finance
- Glassmorphism that weakens contrast
- Large vanity metrics or fake intelligence scores
- Chat bubbles as the main product structure
- Infinite suggestion feeds
- Generic purple artificial-intelligence gradients

## Use the official logo assets

Treat the following raster files as the official prototype identity:

| Role | File | Use |
| --- | --- | --- |
| Primary horizontal lockup | `design/logo-concepts/BiBrain Black and Gold Logo (2).png` | First-use screen, marketing header, wide product masthead |
| Primary emblem | `design/logo-concepts/Mirrored Black and Gold Brain Emblem.png` | App shell, favicon reference, compact navigation, empty states, loading mark |

![Official BiBrain horizontal lockup](<design/logo-concepts/BiBrain Black and Gold Logo (2).png>)

![Official BiBrain emblem](<design/logo-concepts/Mirrored Black and Gold Brain Emblem.png>)

The horizontal lockup is 1672 × 941 pixels. The emblem is 1254 × 1254 pixels. Both Portable Network Graphics (PNG) source files have opaque white canvases. They are not transparent assets.

Follow these logo rules:

- Use the supplied files. Do not redraw the symbol with Cascading Style Sheets (CSS), replace the wordmark with typed text, recolor the halves, add outlines, or change proportions
- Keep the black half on the left and the gold half on the right
- Preserve a clear area around the visible mark equal to one inner-lobe width
- Do not place the opaque PNG directly on a dark background
- Place the logo on a white or near-white plate when the surrounding interface is dark
- Crop built-in white canvas only through a nondestructive wrapper in the prototype
- Do not modify the source files
- Do not add shadows inside the logo artwork
- Do not animate the two logo halves independently
- Treat the logo as identity, not a progress indicator or data visualization

Approximate visible crop bounds can guide a nondestructive wrapper:

| Asset | Horizontal crop | Vertical crop |
| --- | --- | --- |
| Horizontal lockup | 7% to 93% | 29% to 69% |
| Emblem | 14% to 86% | 19% to 79% |

Keep the full files available in the design source. A future production handoff may replace them with transparent or vector masters. Do not infer trademark clearance or manufacture a Scalable Vector Graphics (SVG) file from the raster image.

Use these minimum visible sizes:

- Horizontal lockup: 176 px wide in product UI, 240 px wide on first use
- Emblem: 28 px in compact navigation, 40 px in the desktop shell, 72 px or larger in an empty-state illustration

## Build the color system from black, gold, and warm paper

Gold is a signal, not a reading color. Use it for selected state, the primary save moment, focus detail, and the living center. Use black or ivory for primary actions and long-form text.

### Brand colors

| Token | Value | Purpose |
| --- | --- | --- |
| `brand.black` | `#0D0D0E` | Primary structure and the black logo half |
| `brand.gold` | `#FABC08` | Main gold sampled from the official lockup |
| `brand.goldBright` | `#FFD247` | Highlight and dark-mode signal edge |
| `brand.goldDeep` | `#8A5A00` | Accessible gold-family text on pale surfaces |
| `brand.ivory` | `#FAF8F2` | Warm brand canvas |
| `brand.white` | `#FFFFFF` | Official logo plate and highest surface |

### Light appearance

| Token | Value | Use |
| --- | --- | --- |
| `canvas` | `#F6F3EC` | Application background |
| `canvasWarm` | `#EFE8D8` | Hero atmosphere and selected zones |
| `surface` | `#FFFFFF` | Cards, dialogs, inputs |
| `surfaceMuted` | `#F1EDE4` | Secondary regions and skeletons |
| `text` | `#121212` | Primary text |
| `textMuted` | `#676158` | Supporting text |
| `textFaint` | `#8C857A` | Metadata only |
| `border` | `#DDD6C8` | Default borders |
| `borderStrong` | `#B8AE9C` | Emphasized boundaries |
| `primary` | `#111111` | Standard primary action |
| `onPrimary` | `#FFFFFF` | Text on standard primary action |
| `signal` | `#FABC08` | Living state and save emphasis |
| `signalSoft` | `#FFF1B8` | Selected or prepared surface |
| `focus` | `#7A4F00` | Focus ring on light surfaces |

### Dark appearance

| Token | Value | Use |
| --- | --- | --- |
| `canvas` | `#0C0C0D` | Application background |
| `canvasWarm` | `#17130A` | Hero atmosphere |
| `surface` | `#171719` | Cards and dialogs |
| `surfaceMuted` | `#202024` | Secondary regions and skeletons |
| `text` | `#F8F5ED` | Primary text |
| `textMuted` | `#BBB4A8` | Supporting text |
| `textFaint` | `#8F887D` | Metadata only |
| `border` | `#37332C` | Default borders |
| `borderStrong` | `#5C5447` | Emphasized boundaries |
| `primary` | `#F8F5ED` | Standard primary action |
| `onPrimary` | `#111111` | Text on standard primary action |
| `signal` | `#FABC08` | Living state and save emphasis |
| `signalSoft` | `#3B300A` | Selected or prepared surface |
| `focus` | `#FFD247` | Focus ring on dark surfaces |

### Semantic colors

Semantic state must always include text or an icon. Never depend on color alone.

| Meaning | Light | Dark | Example label |
| --- | --- | --- | --- |
| Success | `#16724A` | `#65D49B` | Saved |
| Information | `#2856A8` | `#8CB7FF` | Updating |
| Attention | `#A44913` | `#FFAA70` | Needs review |
| Failure | `#B42318` | `#FF8A80` | Could not prepare |
| Offline | `#656B73` | `#AEB4BC` | Offline |

Use gold for brand state, not warnings. A warning may use a warm orange, an icon, and specific language.

## Use one restrained type system

Use `Inter`, `Geist Sans`, or the system sans-serif stack. Prefer the font already available in the target environment. Do not load a decorative display font solely for this prototype.

| Style | Desktop | Phone | Weight | Line height |
| --- | ---: | ---: | ---: | ---: |
| Display | 64 px | 42 px | 650 | 1.02 |
| Page title | 44 px | 34 px | 620 | 1.08 |
| Section title | 28 px | 24 px | 600 | 1.16 |
| Card title | 20 px | 19 px | 600 | 1.25 |
| Body large | 18 px | 17 px | 420 | 1.55 |
| Body | 16 px | 16 px | 420 | 1.55 |
| Label | 14 px | 14 px | 560 | 1.3 |
| Metadata | 13 px | 13 px | 500 | 1.4 |

Use sentence case. Keep measure between 52 and 72 characters for long text. Use tabular numbers for dates, limits, counts, and spending. Use the official image for the wordmark instead of approximating its lettering.

## Use a spatial system with a stable center

Build spacing from a 4 px base and favor 8 px increments:

| Token | Value | Common use |
| --- | ---: | --- |
| `space.1` | 4 px | Icon correction |
| `space.2` | 8 px | Tight inline gap |
| `space.3` | 12 px | Label to control |
| `space.4` | 16 px | Standard component padding |
| `space.5` | 20 px | Compact card padding |
| `space.6` | 24 px | Default card padding |
| `space.8` | 32 px | Section gap |
| `space.10` | 40 px | Large card padding |
| `space.12` | 48 px | Page-section gap |
| `space.16` | 64 px | Hero spacing |
| `space.20` | 80 px | Wide-screen breathing room |

Use these supporting tokens:

- Radius: 10 px for inputs, 14 px for buttons, 20 px for cards, 28 px for hero surfaces, and 999 px for status pills
- Border: 1 px default, 2 px for selected or keyboard focus
- Shadow: soft neutral shadow only for floating dialogs and elevated saved receipts
- Icon stroke: 1.75 px at 20 px or 24 px
- Content width: 760 px for reading, 1120 px for working layouts, 1440 px maximum shell width

Avoid nested cards where spacing and a divider can establish hierarchy. One primary surface per section is usually enough.

## Create a recognizable living field

The living field is BiBrain's state surface. It gives the interface a sense of continuity without pretending to visualize the user's brain.

Compose it from:

- One official emblem or a cropped official emblem plate
- Two to five broad, low-opacity radial fields
- Four restrained orbital paths or memory arcs
- Six to twelve small state nodes at most
- One short state label, one title, and one explanatory sentence

The paths and nodes are decorative. Mark the visual layer `aria-hidden="true"`. Never map paths to invented memories, agents, or relationships.

Use the following state treatments:

| State | Title | Visual behavior |
| --- | --- | --- |
| Ready | Your brain is ready | Still field, one soft gold center |
| Organizing | Putting this in place | One slow 2.8s breathing ring |
| Keeping current | Checking what changed | One directional arc moves once per cycle |
| Review | Something is ready for you | Gold center with a fixed attention halo |
| Caught up | Nothing needs your attention | Completely still, lower contrast |
| Paused | Background help is paused | Still field, muted nodes |
| Offline | Your brain is available on this device | Still field, gray status edge |
| Failure | Your note is safe | No alarm animation, specific recovery action |

Do not loop motion faster than 2.4s. Animate only opacity and transform. Stop all nonessential motion when `prefers-reduced-motion: reduce` is active. Motion must stop when the state becomes quiet, complete, paused, or offline.

## Build the app shell first

The desktop shell uses a 232 px navigation rail and a fluid content region. Keep the rail calm and mostly monochrome. Use gold only for the selected destination, the compact emblem detail, and a meaningful attention badge.

Desktop shell order:

1. Official emblem and BiBrain product name
2. Primary navigation
3. Global **Save something** action
4. Flexible empty space
5. Background-help status
6. **Settings & privacy**

Use these primary navigation items exactly:

- Today
- Your brain
- Connections

On screens below 800 px, move navigation into a bottom bar or a compact top region. Keep it in document flow. Do not let it cover capture controls, dialogs, saved receipts, or the software keyboard.

Include a visible skip link and a single page-level `main` landmark. Announce route changes and meaningful save status without announcing decorative motion.

## Design the local first-use screen

The first-use screen should explain the value before presenting the installation code. It must feel like the product, not a server console.

Use a split layout on wide screens:

- Left: official horizontal lockup, promise, short explanation, three trust points
- Right: protected pairing card with installation-code field and primary action

Use this copy:

- Eyebrow: **YOUR THINKING, STILL ALIVE**
- Heading: **A private brain for everything you are building.**
- Body: **Save what matters once. Continue with any agent without rebuilding the context.**
- Trust points: **Private by default**, **Originals stay inspectable**, **You control every connection**
- Pairing title: **Open your local brain**
- Pairing help: **Enter the installation code stored on this computer. No account is required.**
- Field label: **Installation code**
- Primary action: **Open my brain**
- Secondary action: **Try an example**

The example path must enter a clearly labeled demo mode. Do not mix sample content into the person's real brain. Keep the security explanation available beside the field without using operator jargon.

On phones, show the cropped horizontal logo at the top, then the promise, then the pairing card. Use at least 20 px side padding. Keep the primary action full width.

## Design Today as the product center

Today should answer three questions in this order:

1. What is my brain doing now?
2. What needs my attention?
3. What do I want to remember next?

Use a two-column hero on desktop. Place orientation and actions on the left. Place the living field on the right. Stack both areas on phones, with the state label and message before the decorative field.

Use this default orientation:

- Eyebrow: **TODAY**
- Heading: **Pick up where you left off.**
- Body: **Your saved work stays ready, even when the agent changes.**

Place **Save something** and **Find in your brain** beneath the orientation. The save action is gold with black text. The find action is neutral or outlined.

Below the hero, use this content order:

1. Direct capture composer or compact save entry
2. One highest-value prepared item, when present
3. Pick up where you left off
4. Up to two additional prepared items under **More prepared work**
5. Background-help status

Do not fill empty space with suggestions. In the quiet state, show:

- Title: **Nothing needs your attention.**
- Body: **Your saved work is ready when you are.**
- Actions: **Save something**, **Find in your brain**

In a failure state, lead with what remains safe:

- Title: **Your note is saved.**
- Body: **BiBrain could not prepare the brief. You can retry or open the original.**
- Actions: **Retry preparation**, **View original**

## Design the save flow around durable capture

Open **Save something** as a modal on desktop and a full-height sheet on phones. Keep the draft inside the component until the application confirms a durable write.

Required controls:

- Editable title
- Multiline content field
- Optional `.txt` or `.md` import
- Destination, defaulting to Inbox
- Plain size and format guidance
- **Save to my brain** action
- **Cancel** action

Required states:

- Empty
- Drafting
- Saving…
- Saved
- Duplicate found
- Input too large
- Unsupported file
- Write failed with the complete draft retained
- Saved but preparation delayed

After a confirmed capture, show a saved receipt. The receipt must use the returned retained content, title, source identifier, destination, and timestamp. Do not echo an unsafe draft if the service rejected or quarantined it.

Receipt actions:

- **View original**
- **Find in Your brain**
- **Save another**
- **Dismiss**

Keep preparation status visually separate from saved status. A preparation failure cannot visually reverse a confirmed save.

## Design Your brain for recognition, not administration

Your brain should feel like a library of active work, not a file manager or knowledge graph.

Use this structure:

- Page title and compact item count
- Full-width search field
- Scope controls for **Everything**, **Inbox**, and projects
- Optional filter button for type and date
- Recent or matching material list
- Project section

Search results should show:

- Familiar title
- Source type
- Project or Inbox
- Updated date
- One bounded matching snippet
- Current, updating, withdrawn, or stale status when relevant

Do not show relevance percentages. Do not present keyword results as semantic answers. Use the no-result copy: **No matching notes. Try a different word or save something new.**

On desktop, the source detail may open in a right-side panel. On phones, open a full-width route. Preserve the search query and scroll position when the person returns.

## Design source detail around evidence

Source detail has three layers:

1. Retained original
2. What BiBrain remembers
3. History and dependent work

Use tabs or anchored sections named **Original**, **Understanding**, **History**, and **Used in**. Open the original by default.

The understanding section must separate these states:

- Exact source-backed statement
- User correction
- Hypothesis
- Updating
- Stale because the source changed
- Withdrawn

Every factual derived statement needs a **See source** action. A citation opens the exact source and version. Do not show a generic sparkle icon as proof.

Use these actions where valid:

- **Edit understanding**
- **Correct source**
- **Withdraw from active use**
- **Delete permanently**
- **Copy brief**
- **Download Markdown**

Destructive actions must explain scope, retained backups, delivered copies, and reversibility before confirmation.

## Design prepared work as a review, not an instruction

A prepared item is a proposal connected to a goal. It never looks accepted before the person acts.

Collapsed card content:

- Project and goal
- Specific title
- Why it matters now
- Evidence count
- **Prepared** label
- **Review**, **Later**, and **Not useful** actions

Expanded review content:

1. Earlier understanding
2. Suggested change or prepared artifact
3. Source excerpts with dates and direct links
4. Unknowns and hypotheses
5. Editable final artifact
6. Actions

Use **Keep this plan** for acceptance. Use **Edit**, **Later**, and **Not useful** for alternatives. Undo must create a compensating version. If later work exists, replace direct undo with **Compare versions**.

Gold may frame the prepared artifact, but it must not imply acceptance. Use a specific text label and status icon.

## Design Connections as a permission surface

Split Connections into **Knowledge sources** and **Agents**. Do not combine import status with agent access.

Use only these connection states:

- Not connected
- Awaiting authorization
- Checking
- Connected
- Needs attention
- Revoked

A configured token does not qualify as Connected. The wired application will set Connected only after a verified round trip.

Knowledge-source rows need:

- Name and source type
- Selected scope
- Last successful check
- Freshness state
- **Review import**, **Disconnect**, and retained-data actions

Agent rows need:

- Agent name or custom label
- Readable projects
- Ability to propose memories
- Expiration
- Last verified access
- **Review access** and **Revoke**

Use a permission preview before creating a grant. Explain what the agent can read, what it can propose, and what remains private. Never use a universal **Allow everything** shortcut.

## Design Settings and privacy for confidence

Group settings by the person's intent:

- **Appearance**: light, dark, system, reduced motion follows device
- **Background help**: remember, prepare, pause, quiet hours, local time zone
- **Processing & spending**: provider consent, daily cap, per-job cap, availability
- **Plan**: local edition or managed plan status
- **Privacy & data**: export, backup guidance, withdrawal, permanent deletion
- **Security**: active sessions, agent grants, revoke actions

Keep model identifiers, price versions, and operator configuration inside an advanced disclosure. Do not show a working live-payment action in the prototype. If the managed plan card appears, label it **Unavailable in this preview** unless Claude Design receives a separate live-commerce brief.

## Define the component library

Build these reusable components with explicit variants:

| Component | Required variants or states |
| --- | --- |
| `BrandLockup` | horizontal, emblem, light plate, compact |
| `AppShell` | desktop rail, tablet header, phone navigation |
| `PrimaryNavigation` | default, selected, attention, disabled |
| `Button` | primary, gold emphasis, secondary, ghost, destructive, loading |
| `IconButton` | default, selected, destructive, disabled |
| `StatusPill` | ready, updating, prepared, stale, paused, offline, failed |
| `LivingField` | ready, organizing, current, review, quiet, paused, offline, failed |
| `SaveComposer` | empty, drafting, saving, error, disabled |
| `SavedReceipt` | saved, duplicate, preparing, preparation failed |
| `SearchField` | empty, active, loading, results, no results, offline |
| `SourceRow` | current, updating, stale, withdrawn, selected |
| `SourceViewer` | original, understanding, history, used in |
| `PreparedCard` | collapsed, expanded, editing, accepted, snoozed, stale |
| `EvidenceList` | complete, partial, unavailable, source removed |
| `RevisionComparison` | clean, conflict, newer edit present |
| `ConnectionRow` | all six connection states |
| `PermissionPreview` | read only, propose enabled, expiring, revoked |
| `EmptyState` | new brain, quiet, no results, no connections |
| `InlineNotice` | information, attention, failure, success |
| `ConfirmDialog` | ordinary, destructive, permanent deletion |
| `Skeleton` | text, row, card, hero |

Every interactive component needs hover, active, focus-visible, disabled, loading, success, and error treatment where the state applies. Disabled controls need a visible explanation nearby or in accessible description text.

## Make interactions feel responsive and reversible

Use animation to explain a state change, not to decorate idle time.

Recommended motion:

- Button and control feedback: 120 to 160 ms
- Card or panel transition: 180 to 240 ms
- Modal or sheet entry: 220 to 280 ms
- Living-field cycle: 2.8 to 4.8s
- Route content transition: 160 ms opacity with no large translation

Use an ease-out curve for entry and ease-in for exit. Limit movement to 8 px for interface transitions. Do not animate layout height while the person is typing. Preserve focus and scroll context when panels open or close.

When reduced motion is active:

- Remove breathing, orbit, shimmer, and parallax motion
- Replace moving loading indicators with a static progress label where possible
- Keep instantaneous focus, color, and visibility changes
- Preserve all state information

## Design for phones from the same hierarchy

Validate at 1440 px, 1024 px, 768 px, 390 px, 360 px, and 320 px widths.

At phone widths:

- Keep 16 to 20 px side padding
- Stack the Today hero before prepared work
- Use full-width sheets for save, filters, permissions, and source detail
- Keep primary actions reachable without sticky overlays covering content
- Allow action groups to wrap or stack
- Keep touch targets at least 44 × 44 px
- Avoid horizontal page scrolling
- Keep evidence and original text readable without pinch zoom
- Preserve safe-area padding around bottom navigation

At tablet widths, collapse the navigation rail before compressing content below a readable width.

## Meet accessibility requirements

Target Web Content Accessibility Guidelines (WCAG) 2.2 AA.

Required behavior:

- Native buttons, inputs, links, headings, lists, dialogs, and landmarks
- Visible `:focus-visible` treatment with at least a 2 px ring
- Text contrast of at least 4.5:1, with 3:1 for large text and interface boundaries where applicable
- Status text or icon in addition to color
- Accessible names for icon-only controls
- Correct dialog focus trap, initial focus, Escape behavior, and focus return
- Meaningful live-region announcements only for saved, failed, connected, revoked, and similar changes
- No announcement for decorative living-field motion
- All actions available without hover
- Keyboard-complete workflows
- Zoom support to 200% without lost content or controls
- Reduced-motion support

Do not use brand gold for small text on white. Use `brand.goldDeep` or primary text instead.

## Use plain product language

Use these phrases in primary screens:

- Save something
- Save to my brain
- Your brain
- Find in your brain
- What BiBrain remembers
- See source
- Use with an agent
- Keep this plan
- Stay ahead
- What changed
- Nothing needs your attention

Avoid these phrases in primary screens:

- Ingest
- Embeddings
- Vector store
- Memory consolidation
- Classifier confidence
- Context packer
- Queue
- Cron
- MCP
- Token budget
- Model picker

Use **BiBrain** as one word. Use **Your brain** for the navigation destination. Do not call BiBrain a sentient mind, personal oracle, or autonomous employee.

## Use synthetic prototype content only

Create one clearly labeled demo workspace named **Northstar launch**. Include no owner data and no invented claim that a provider processed the content.

Suggested synthetic items:

- Note: **Private beta interview themes**
- Decision: **Invite ten research partners before opening sign-ups**
- Goal: **Prepare the private beta launch**
- Open question: **Which onboarding promise is clearest?**
- Prepared item: **Compare the saved launch decision with two interview notes**

Label the workspace **Demo data** anywhere it appears. Keep citations linked to the synthetic source cards. Do not use celebrity, health, legal, financial, or politically sensitive examples.

## Prepare the prototype for later wiring

Use React and TypeScript if Claude Design generates code. Keep presentation components separate from fixture data and event adapters.

Expose these interface states as props or typed view models:

- `sessionState`
- `brainState`
- `captureState`
- `preparationState`
- `searchState`
- `connectionState`
- `backgroundHelpState`
- `appearance`
- `reducedMotion`

Use callback props for all mutations. Examples include `onSave`, `onRetry`, `onSearch`, `onOpenSource`, `onAccept`, `onUndo`, `onSnooze`, `onRevoke`, and `onDelete`. Do not place networking, timers, generated identifiers, payment logic, or persistence inside visual components.

Add stable attributes to principal controls and regions:

- `data-ui="primary-navigation"`
- `data-ui="save-something"`
- `data-ui="living-field"`
- `data-ui="saved-receipt"`
- `data-ui="brain-search"`
- `data-ui="prepared-review"`
- `data-ui="connection-row"`

Keep route names compatible with the product surfaces:

- `/#today`
- `/#brain`
- `/#connections`
- `/#settings`

The prototype may use local fixtures for navigation and visual state changes. Keep fixture transitions deterministic. Label any unavailable real behavior in the interface and document each fixture boundary in the handoff.

## Deliver the complete Claude Design package

Return these outputs:

1. A responsive desktop and phone prototype
2. Light and dark appearances
3. Component variants and state examples
4. The first-use, Today, save, search, source, prepared-review, Connections, and Settings screens
5. A token sheet for color, type, spacing, radius, borders, elevation, and motion
6. A component inventory with prop and state notes
7. A short file map for the generated frontend
8. A list of fixture-only behaviors that require real wiring
9. Screenshots at 1440 × 1024 and 390 × 844 for first use, Today, Your brain, and Connections

Do not return only a landing page. Do not return static frames without component states. Do not replace the supplied official identity with a generated logo.

## Check the design before handoff

The design is ready to bring back for wiring only when every item below passes:

- [ ] The official horizontal logo and emblem appear without distortion or recoloring
- [ ] Opaque logo files sit on a white or near-white plate
- [ ] Today, Your brain, and Connections remain the primary navigation
- [ ] First value is available before integrations
- [ ] Today supports new, quiet, active, review, failure, paused, and offline states
- [ ] Save status is distinct from preparation status
- [ ] Your brain search does not pretend to be semantic answering
- [ ] Prepared work is visibly proposed, evidence-backed, and reversible
- [ ] Connection status never claims success from configuration alone
- [ ] Every visible action works in the prototype or states why it is unavailable
- [ ] All sample content is labeled as demo data
- [ ] Light and dark appearances meet contrast requirements
- [ ] Keyboard focus, dialogs, live regions, and reduced motion are defined
- [ ] Layout works without horizontal scrolling at 320 px
- [ ] No sticky element covers capture, receipts, dialogs, or mobile navigation
- [ ] Components accept state and callbacks instead of owning service behavior
- [ ] Fixture-only behavior is listed for the wiring handoff

## Keep these decisions open for wiring

Do not decide the following inside Claude Design:

- Authentication provider or hosted sign-in implementation
- Real model provider, model name, or processing price
- Paddle catalog, customer price, allowance, checkout, or portal behavior
- Native agent branding or verified connection status
- Production notification delivery
- Production domain, hosting, analytics, or telemetry
- Legal terms, privacy disclosures, trademark clearance, or software license

The existing BiBrain implementation owns authorization, persistence, source history, evidence validation, durable work, deletion, spending safeguards, and connection grants. The returned design must make those behaviors visible without replacing or weakening them.

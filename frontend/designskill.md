---
name: rex-planner-design
description: Expert-level UX/UI design and frontend engineering for the Rex Planner railway maintenance block-planning app (KTV-PSA corridor, SIH — Ministry of Railways submission). Use this skill for ANY frontend or visual-design work anywhere in this codebase, on any page — Dashboard, Baseline vs AI, Schedule/timeline (Gantt, weekly and monthly views, policy-weight sliders, approval workflow), Approvals & audit, DRM oversight, My requests, Reference data — and for any reusable component, icon, badge, chart, or design-token change. Trigger on any of: redesigning a screen, adding or changing a dashboard card or KPI, building a new page, reviewing a mockup or screenshot, fixing a layout or spacing/alignment issue, auditing visual or honesty-framing consistency across pages, adding or changing an icon, or any request to make something "look better," "look premium," "look professional," "look clean," "not look messy," or "not look AI-generated" — even when the user doesn't use design/UX vocabulary explicitly. Also trigger whenever the user references, links, or pastes a screenshot of an external site, template, or dashboard (e.g. admin-dashboard templates like Materio/Vuexy) as inspiration — this skill governs exactly what is and isn't safe to borrow from such references for this specific app, since generic SaaS-dashboard patterns often conflict with this app's honesty-first design rules. Also trigger for any new KPI, metric, weekly/monthly view, or baseline-vs-AI comparison anywhere in the app, since every one of those carries both a visual-design and a trust/caveat-framing component here. Do not use for backend logic, CP-SAT/optimizer internals, or database schema work unless a UI change is also involved.
---

# Rex Planner design system & frontend practice

You are acting as both the UX designer and the frontend engineer for Rex Planner — a
maintenance block-planning tool for the KTV-PSA railway corridor, built for judges,
railway domain experts, and real operators to trust. The app's actual competitive edge
is not visual polish for its own sake — it's that every number on screen is honest about
what it does and doesn't know. A beautiful screen that overstates certainty is a worse
outcome here than a plain screen that's honest. Hold both bars at once.

## Before touching anything: ground yourself in what's real

Never design from a blank slate or from generic dashboard instincts. This app already
has an established visual and rhetorical language — your job is to extend it
consistently, not invent a new one next to it.

1. **Read the actual component you're changing, and at least one sibling screen**,
   before proposing anything. Check `frontend/src` for the existing component
   structure, styling approach (CSS modules, Tailwind, styled-components — verify,
   don't assume), and whichever shared UI primitives already exist (buttons, cards,
   badges). Reusing an existing `Card`/`Badge`/`StatComparison` component is always
   preferable to writing new markup that looks similar but isn't the same component.
2. **Check for a design-token source of truth** (a theme file, CSS variables, a
   Tailwind config) before picking a single color, spacing value, or font size by eye.
   If one exists, every value you use must trace back to it. If none exists, flag that
   explicitly — introducing tokens is a bigger, separate decision, not something to do
   silently mid-task.
3. **Identify what data is actually driving this screen** — which backend endpoint,
   which optimizer output field — before designing how to present it. A convincing
   mockup built on invented numbers is worse than useless here; it teaches the wrong
   lesson about what the real screen will look like. If the real field doesn't exist
   yet, say so and design around that fact rather than quietly fabricating a shape.

## The house style, extracted from what's already built

The `Baseline vs AI` screen is the reference point for this app's voice. Match it, don't
just imitate its surface (the red/green numbers) without the substance underneath:

- **Every comparison names its own scope before showing numbers.** "Of 818 pending
  tasks, 240 fit no combination of windows at all... every figure below is drawn from
  the 578 contestable tasks" — a number is never presented as if it speaks for the
  whole system without saying which subset it actually covers.
- **A metric that could mislead gets a badge that says so, in the reader's favor, not
  the system's.** `READS BACKWARDS` on a case where the baseline scores numerically
  higher for a bad reason (over-subscription) is the single best design decision on
  that page — it costs the AI story a moment of looking "worse," in exchange for the
  reader trusting every other number more. Never omit a badge like this to make a
  metric look cleaner.
- **A smaller AI number is sometimes the honest, better outcome**, and the copy says so
  directly (`FEWER, BY DESIGN` — "that is not a regression: it refuses to schedule a
  task before its prerequisite completes"). Don't let "AI number should look bigger/
  better" become an unstated design rule; let the real mechanism decide the framing.
- **Color carries a fixed, narrow meaning**: red = the thing a human should worry
  about or that the baseline does badly; green = what the optimizer achieves. Don't
  repurpose this pair for anything else on the same page (e.g., not for generic
  status/success unrelated to the baseline-vs-AI comparison) — reusing red/green for
  something else nearby dilutes the one signal this app trained its reader to trust.
- **Every AI-derived number that rests on a documented limitation gets its caveat
  in the same visual weight as the number**, not a footnote. If you add a card
  surfacing the risk model, the fragmentation score, or anything from a module with
  a `FRAMING`/non-goal disclaimer in its docstring, the caveat is part of the card's
  design, not optional trim. Reuse the existing `KnownLimitations`/`DatasetProvenance`/
  `SyntheticBadge`-style pattern rather than writing new disclaimer copy from scratch.
- **The prototype banner at the top of every page is load-bearing, not decorative.**
  Never design a new page that could ship without it, and never let a new screen's
  tone imply more certainty than that banner already admits to.

## Visual design fundamentals (apply through the above lens, never against it)

- **Type scale**: a small number of steps (e.g. 12/14/16/20/24/32px), each with a
  clear job — body text, secondary/muted text, card values, section headers. Never
  introduce a one-off font size for a single element; find the nearest existing step.
- **Spacing**: pick a base unit (commonly 4px or 8px) and multiply — 8/16/24/32/48.
  Consistent spacing reads as intentional even before anyone consciously notices it;
  inconsistent spacing reads as unfinished even when every individual choice looks fine.
- **Hierarchy over decoration**: solve "how do I make this clearer" by adjusting size,
  weight, color, and whitespace before reaching for a new visual device (icon, border,
  shadow). The existing screen gets its clarity almost entirely from typographic
  hierarchy and card grouping, not ornament — match that restraint.
- **Density is a deliberate choice here, not a flaw to fix.** This is an operator tool
  for people who will use it daily, not a marketing page — resist the instinct to add
  generous whitespace and large hero elements just because it "looks more premium."
  A denser, faster-to-scan layout is usually the more respectful design for this
  audience, as long as hierarchy and grouping keep it navigable.
- **Accessibility is not optional for a government-facing tool.** Meet WCAG AA contrast
  at minimum (4.5:1 body text, 3:1 large text/UI components) — check the red/green
  comparison numbers specifically, since that exact color pair is a common contrast
  failure point and this app leans on it constantly. Never encode a meaning (baseline
  vs AI, pass vs fail) in color alone — the existing arrow (`→`) between numbers and
  the explicit BASELINE/AI-OPTIMISED labels are already doing this correctly; carry
  that pattern into anything new rather than relying on color alone.
- **Every interactive element needs a visible focus state and a real accessible name**
  — not just a hover state. Domain experts and judges may navigate by keyboard during
  a demo; a control that's invisible without a mouse is a real defect here.

## Frontend engineering rules

- **Match the existing stack, don't introduce a new one.** Before writing a component,
  confirm: the styling approach in use, whether there's a shared component library
  already (don't duplicate a `Card` if one exists), and how state/data-fetching is
  handled (this app uses RTK Query in at least some screens per prior grep — check
  before writing a new fetch pattern next to it).
- **TypeScript types are the contract, not an afterthought.** If a screen consumes a
  new field from the optimizer or backend, trace its actual shape from the Pydantic/
  Mongoose model or API response before typing the frontend prop — don't infer a
  plausible-looking shape and move on.
- **Large tables/lists (task backlog, corridor list) need virtualization or pagination**
  once they exceed a few hundred rows — this app's real data (818+ tasks, 8,990+
  stations) will break a naive `.map()` render. Check row count assumptions against
  real data volumes mentioned in this project before assuming a simple list is fine.
- **Responsive behavior**: this is presented on a projector/judge's laptop as the
  primary case, but don't hard-code desktop-only assumptions if the existing app
  already handles smaller viewports elsewhere — check a sibling screen's breakpoint
  handling and match it.
- **Loading and empty states are part of the design, not a follow-up task.** A card
  showing a baseline-vs-AI comparison needs a defined look for "still solving" (the
  monthly CP-SAT solve can take 30+ seconds) and "no contestable tasks this run" —
  don't ship a card that only has a design for the happy path.
- **Never fabricate placeholder copy or numbers to fill a mockup you're showing the
  user as final.** If real data isn't available yet, say so and either use clearly
  marked placeholder values or wait for the real field — this mirrors the project's
  own data-honesty rule (never fabricate, mark PLACEHOLDER) and applies to UI copy
  exactly as much as it applies to the CP-SAT pipeline's numbers.

## Premium visual craft — genuine polish, not borrowed decoration

It's fair to want this app to look as considered and finished as a professional admin
dashboard. Most of what makes those genuinely feel premium is systemic craft, not
content — the same craft is achievable here without importing what those products
are actually for (selling a SaaS tool, tracking vanity metrics). Adopt the craft.
Reject the content model underneath it.

**Adopt these — they're real technique, independent of what's being shown:**
- **A deliberate elevation system**: a small, fixed set of shadow/border-weight levels
  that communicate depth and importance consistently (e.g. flat → subtle ring →
  resting shadow → raised-on-hover). Apply the same level to the same kind of element
  everywhere, never pick a shadow by eye per component.
- **Numeric hierarchy as typography, done well**: a large, confident number, a small
  label above it, a smaller supporting line below — this is a genuinely strong pattern
  or, and it's fully compatible with everything already required here (the badge and
  caveat still attach to that same stat block, just typeset with more discipline).
- **Icon-in-a-tinted-chip as a container pattern** (a small rounded-square background
  behind an icon) is a nice, reusable shape — but the color inside that chip still has
  to follow this app's rules (see below), not an arbitrary per-card rainbow.
- **Micro-interactions**: real hover/focus transitions (150-200ms, transform/opacity
  only), a pressed state on buttons, a subtle lift on hover for clickable cards. This
  app almost certainly has none of this yet, and it's one of the highest-leverage,
  lowest-risk things to add — it costs nothing in honesty and reads as immediately
  more finished.
- **Chart restraint**: when a chart earns its place (per the existing rule — it proves
  a point, it isn't decoration), keep it minimal and label-light, the way the Tier 2
  utilisation bar already does. That's the right amount of chart for this app.

**Do NOT import these, even from an otherwise-good reference — each one actively
works against a rule already established above:**
- **No decorative illustrations, mascots, 3D characters, or abstract gradient blobs.**
  Every visual element here must carry information (per "Hierarchy over decoration"
  above); an illustrated character next to a stat card is pure ornament and, for a
  government-facing tool judged by domain experts, reads as less credible, not more.
- **No emoji or casual marketing copy** ("Growth this month 😎") — wrong register
  entirely for a Ministry of Railways decision-support tool.
- **No arbitrary per-card category colors.** Red and green stay reserved exclusively
  for baseline-vs-AI meaning, everywhere in this app. Any other icon/chip uses a single
  neutral or brand accent color, not a different hue per card for visual variety.
- **No "just a number and a trend arrow" for anything that needs a caveat.** The
  numeric-hierarchy technique above is for presentation, not for stripping content —
  every AI-derived stat that currently carries a badge or caveat keeps it, just
  typeset more elegantly. A premium-looking number that hides why it's trustworthy is
  a worse outcome here than a plain one that shows its work.
- **No "Buy Now"/upsell/vanity-metric framing.** This is a submission being evaluated
  for whether its reasoning holds up, not a product being sold — nothing on this page
  exists to create urgency or excitement for its own sake.

**A reality check worth keeping in view**: the audience for this app is railway domain
experts and technical judges, not consumers. What reads as "impressive" to that
audience is closer to "obviously professional, dense with real information, and every
number survives being questioned" than "looks like a CRM sales dashboard." Chasing a
generic SaaS-premium look too literally risks reading as tone-deaf to the actual
evaluators, on top of undermining the honesty apparatus this app depends on. Polish the
craft; keep the substance the differentiator.

## Workflow for a redesign or new-screen request

1. **Audit** — read the current screen (or the closest sibling if building new), and
   name explicitly which established patterns it should inherit (badges, card style,
   comparison framing, disclaimer components).
2. **Map to data** — identify every number/field the screen needs and its real source.
   Flag anything not yet available rather than mocking it silently.
3. **Propose before building** — for anything more than a small tweak, describe the
   layout and new copy in plain terms and get a yes before writing the component. This
   project's owner has an explicit standing preference: hand him a clear plan or prompt
   he can review and run himself rather than surprising him with completed changes.
4. **Build using existing primitives** — reuse components; only add a new shared
   component when the pattern will clearly recur, and put it in the shared location,
   not inline in one page.
5. **Self-check before calling it done**:
   - Does every AI-derived number that needs a caveat have one, at equal visual weight?
   - Does color alone ever carry meaning anywhere? (It shouldn't.)
   - Does this match the existing type scale and spacing unit, with no one-off values?
   - Does the prototype banner still make sense against this screen's new content?
   - Would this survive a domain expert or judge reading every word on the page, not
     just glancing at the big numbers?

## When in doubt

Prefer the choice that makes the app's numbers easier to distrust-and-then-verify over
the choice that makes them merely look more impressive. That trade is this project's
actual design principle — everything above is downstream of it.
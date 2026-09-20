# Rex Planner design system

Source of truth for color, type, spacing, elevation, radius, and icon rules
across the frontend. Every value below already existed in the codebase before
this doc — this file names it as a rule so nothing new gets picked by eye.
See `designskill.md` for the full design practice (honesty-first rules,
workflow, Premium Visual Craft) this system serves.

## Color roles

Fixed meanings. Don't repurpose a role for something it doesn't mean, even on
a page where the "real" meaning doesn't apply.

| Role | Tokens | Meaning |
|---|---|---|
| Neutral UI | `slate-*` | text, borders, backgrounds — the default |
| Baseline vs AI (reserved, exclusive) | `rose-*` / `emerald-*` | never used for anything else, anywhere in the app |
| Department identity (Gantt only) | `sky` (Engineering) / `teal` (S&T) / `orange` (TRD) | fixed per department everywhere it appears |
| Cross-department / highlight | `violet-*` | shared blocks, "moved from default" indicators |
| Status semantics | `emerald` (ok) / `amber` (warn) / `rose` (down) | via `StatusPill` |
| Provenance badges | `emerald` (real) / `violet` (synthetic) | via `SyntheticBadge` |

## Type scale

This is a dense operator tool, not a marketing page — small captions are a
deliberate choice, not a flaw. The rule is that every size has exactly one
named job; nothing is picked as a one-off `text-[Npx]`.

| Token | Size | Job |
|---|---|---|
| `text-3xs` | 9px | Space-constrained exceptions only: chip labels inside the Gantt shared-block bar, and SVG chart axis labels/ticks (`TrendChart`) — where even 11px doesn't fit. Never body copy or a card caption. |
| `text-2xs` | 11px | Captions, KPI note lines, badge sub-text |
| `text-xs` | 12px | Secondary labels, uppercase tags |
| `text-sm` | 14px | Body/default — table cells, panel copy |
| `text-base` / `lg` / `xl` / `2xl` / `3xl` | 16–30px | Card values → headline stats, ascending by importance |

**Contrast note:** `slate-400` on a white background is ~2.56:1 — it fails WCAG AA (4.5:1) at any text size, including the sizes above. `slate-500` clears AA at ~4.76:1 and is the established caption color everywhere else in the app; use `slate-500`, not `slate-400`, for any caption/label text on a white card. This was found and fixed on `TrendChart`'s axis labels and `ServiceStatusPanel`'s "Last checked" caption (2026-09-19) — **flag this specifically to re-check during the ControllerDashboard/`GanttTimeline` migration**, since that page has the highest density of small, space-constrained labels (block tooltips, day-strip captions, legend text) and is the most likely place for the same `slate-400`-on-white pattern to recur.

## Spacing

Use Tailwind's default 4px scale only. An arbitrary px value (`p-[13px]`,
etc.) is allowed *only* for a fixed-layout measurement (e.g. a Gantt column
width) — never for a padding/gap/margin choice, which should always resolve
to a named step.

## Elevation

Three tiers, plus one micro-interaction:

- **Resting** — `shadow-sm`. Cards, panels. The default for anything sitting
  flat on the page.
- **Floating** — `shadow-lg`. Popovers, dropdowns, tour overlays. (Don't use
  `shadow-xl` — it was one page's one-off for the same job as `shadow-lg`
  elsewhere; use `shadow-lg` everywhere for this tier.)
- **Raised-on-hover** — `hover:shadow-md` plus a 150–200ms transform/opacity
  transition. For clickable cards (Gantt blocks, corridor rows). This tier is
  new — the app has no hover-lift today.

## Border radius

Six values, each with one job — don't introduce a seventh without updating
this table.

| Token | Job |
|---|---|
| `rounded-full` | pills, dots, circular elements only |
| `rounded-lg` | the default — cards, panels, buttons, inputs |
| `rounded-md` | compact inline chips/badges/table tags |
| `rounded-xl` / `rounded-2xl` | large primary containers only (login card, page-level hero card) — one hierarchy level up from `rounded-lg`, never the default |
| `rounded-sm` | the one documented exception: dense grid cells (Gantt monthly reservation cells), where `rounded-md`'s 6px reads disproportionate at that size |

## Icon system

**Library: `lucide-react`.** Outline-only, single fixed stroke weight, no
filled/colorful variants — matches the "no decorative illustration, no
per-card rainbow" rule better than an icon set with multiple styles would.

**Every icon is meaningful, never decorative-for-its-own-sake.** Before
adding a new icon anywhere, confirm it's replacing information that's
currently text-only or unicode-glyph-only — don't add icons to a card just
to make it "feel" more finished (see Premium Visual Craft's icon-in-chip
rule: the chip shape is fine, the color inside it still follows the roles
above, never a per-card rainbow).

**Accessible-name rule, checked per usage, not assumed:**
- If the icon sits next to text that already states its meaning (a label, a
  sentence, an adjacent description) → `aria-hidden="true"` on the icon; the
  accessible name comes from the adjacent text.
- If the icon is the *only* content of an interactive element (e.g. an
  icon-only close button) → the icon stays `aria-hidden="true"`, and the
  accessible name goes on the element itself via `aria-label` — never rely on
  the glyph/icon alone to carry the name.

**Current mapping** (unicode glyph → icon, migrated page-by-page per the
rollout order, not as a blanket pass):

| Glyph | Icon | Meaning |
|---|---|---|
| `✓` | `Check` | confirmed / passed / applied |
| `✕` | `X` | rejected / failed / close |
| `⚠` | `AlertTriangle` | warning / emergency |

## Metric-caveat consistency (not a token, but the same class of rule)

Any metric that carries an established caveat elsewhere in the app (e.g.
`blockUtilisationPct`'s D-031 over-subscription warning) must carry that same
caveat, at equal visual weight, everywhere it's shown as a standalone stat —
never just on the page it was first built on. Before adding a new place a
caveated metric appears, check `lib/comparison.ts`, `lib/oversight.ts`, and
`lib/trends.ts` for the existing wording and reuse it rather than
paraphrasing.

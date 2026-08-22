# `/frontend` — React dashboard

React 19 + TypeScript on Vite, styled with Tailwind CSS v4, state managed with
Redux Toolkit. This is where the demo lives: the Controller Dashboard and the
Baseline-vs-AI comparison screen are the two views judges actually see
(PRD Section 8).

## Run

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # tsc -b && vite build
npm run lint
npm run preview   # serve the production build
```

`VITE_*` variables are read from the **repo-root** `.env` via `envDir` in
`vite.config.ts` — there is no separate `.env` in this folder
(`docs/DECISIONS.md` D-002). They are inlined at build time, so nothing secret
belongs in them.

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Base URL of the Express API |
| `VITE_PROTOTYPE_BANNER` | Wording of the PRD Section 5 disclaimer |

## Layout

```
src/
  api/
    apiSlice.ts     RTK Query — the single HTTP client for the backend
  store/
    store.ts        configureStore; server vs client state split
    hooks.ts        typed useAppDispatch / useAppSelector
    slices/
      authSlice.ts  session + role (FR10.1)
  components/       presentational + composed UI
  pages/            route-level screens (task T11)
  hooks/            shared custom hooks
  config.ts         typed access to VITE_* variables
  App.tsx           application shell
```

## State management

State is split on a deliberate line (`docs/DECISIONS.md` D-003):

- **Server state** — health, tasks, corridors, schedules, comparison output —
  belongs to the RTK Query `api` slice. Every backend call is declared as an
  endpoint there. **No component calls `fetch` directly.**
- **Client state** — auth session, policy-slider positions, current selection,
  what-if panel state — belongs in a slice under `src/store/slices/`.

Do not copy server data into a hand-written slice; derive it from the RTK Query
cache instead, or the two will drift.

Components use `useAppSelector` / `useAppDispatch` from `src/store/hooks.ts`
rather than the raw react-redux hooks, so state is fully typed at every call
site.

## Styling

Tailwind v4 via the `@tailwindcss/vite` plugin — configuration is
`@import "tailwindcss"` in `src/index.css`, with no `tailwind.config.js`.

Two conventions worth keeping as the dashboard grows:

- **Colour is never the only signal.** Status is shown with a coloured pill
  *and* a text label — the demo runs on a projector, and department colour-
  coding on the Gantt has to stay readable to a colour-blind viewer.
- **No fabricated numbers in the UI.** Every metric rendered must come from a
  real API response. Any placeholder gets a `PLACEHOLDER` comment so it cannot
  reach the pitch deck by accident.

## Routes

Routing uses `react-router-dom`. All five views are reachable from the header
nav; `/` redirects to `/corridors`.

| Route | Shows |
|---|---|
| `/corridors` | The ~30 real sections carrying maintenance demand — traffic, utilisation, free minutes, block windows, task count |
| `/corridors/:id` | One section: real infrastructure and occupancy, its free block windows, and the assets, backlog and resources on it |
| `/assets` | Assets ranked by FR2.1 criticality score, with the dominant factor |
| `/tasks` | The maintenance backlog, filterable by department |
| `/resources` | Crews, machines and permissions with their depot corridor scope |
| `/status` | Live service wiring **and** the data provenance record |

These are deliberately plain tables. The Gantt timeline, KPI strip and
Controller Dashboard (PRD Section 8) are tasks T12/T13 — there is nothing to
visualise until the CP-SAT solver exists to produce a schedule.

## Showing what is real and what is simulated

`SyntheticBadge` renders from the `synthetic` flag carried on each record, and
`/status` renders the field-level provenance map — both served from MongoDB,
neither written by the UI. This is PRD Section 5's honesty requirement reaching
the screen rather than stopping at a JSON file (`docs/DECISIONS.md` D-015).

The badge distinguishes three cases, which matters because the boundary runs
*through* a record: an asset is `SYNTHETIC`, but its `trainsAffectedCount`
column is badged `REAL` because that number is the train count observed in the
published timetable.

Unscored values render as "unscored", never as 0 — `priorityScore` is null
until the priority engine (T7) exists, and a zero would read as "lowest
priority".

Testing here is manual/visual by design — a hackathon budget is better spent on
solver correctness than on component coverage (`CLAUDE.md` testing priorities).
`npm run build` type-checks the whole app, and `npm run lint` runs ESLint.

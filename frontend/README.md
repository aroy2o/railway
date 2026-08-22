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

## Current state

The landing screen is build-phase scaffolding: the PRD Section 5 prototype
banner, a live probe of React → Express → MongoDB + CP-SAT, and the build
order. It is replaced by role-based routing (T11) and the Controller Dashboard
(T13).

Testing here is manual/visual by design — a hackathon budget is better spent on
solver correctness than on component coverage (`CLAUDE.md` testing priorities).
`npm run build` type-checks the whole app, and `npm run lint` runs ESLint.

# Project instructions for Claude Code

Read `PRD_AI_Block_Planning_SIH_26027.md` in full before writing any code. That document is the source of truth for scope, architecture, data model, and terminology — this file just governs *how* to work, not *what* to build.

## What this project is
SIH hackathon prototype: an AI-assisted railway maintenance block planning system. MERN core + a Python FastAPI microservice for optimization/ML. Solo developer, hard deadline, judged on a live demo.

## Build discipline — read this before touching anything
The PRD Section 16 defines a strict priority order: 🔴 must-build, 🟠 differentiators, 🟡 stretch. **Follow it in order. Do not start a 🟠 item until every 🔴 item works end-to-end.** If I ask you to jump ahead to a 🟠/🟡 feature before the 🔴 list is done, flag it back to me rather than silently doing it — this is the single biggest risk to this project shipping on time.

Within any phase, prefer: get one thing fully working over three things half-working. If something is going to be mocked/stubbed for time reasons, say so explicitly in code comments and in your response — never silently fake a result.

## Repo structure
```
/backend        Node.js + Express API in TypeScript (auth, CRUD, orchestration)
/optimizer      Python FastAPI microservice (CP-SAT, risk model, /explain)
/frontend       React (Vite) dashboard
/data           synthetic data generator scripts + real dataset ingestion scripts
/docs           PRD and any architecture notes
```
Each of `/backend`, `/optimizer`, `/frontend` gets its own `package.json`/`requirements.txt` and can run independently in dev. `docker-compose.yml` at the root wires them together for the demo.

## Tech stack (do not deviate without asking)
- Backend: Node.js + Express in **TypeScript** (strict), MongoDB (Mongoose), JWT auth
  - `tsx` runs dev/seed/tests from source; `tsc` emits `dist/` for production. See docs/DECISIONS.md D-041,
    which supersedes D-001's original "backend stays JavaScript" call.
- Optimizer/AI service: Python + FastAPI, Google OR-Tools (CP-SAT) for scheduling, scikit-learn/lifelines for the risk model, Claude API for the `/explain` endpoint
- Frontend: React (Vite), TailwindCSS, Recharts or D3 for charts, a custom SVG/CSS Gantt component (or `react-big-calendar` if it's faster to integrate)
- Communication: Node calls the Python service over internal REST; never call OR-Tools directly from Node

## Data rules
- Real data (station codes, corridors, timetable) comes from the datasets listed in PRD Section 5.1 — actually fetch and parse these, don't invent station names or codes.
- Synthetic data (maintenance/defects/assets/resources) must be generated per PRD Section 5.2's distributions — not literally random/uniform, since realistic skew is part of what makes this credible.
- Never fabricate final demo numbers (utilization %, delay-minutes-avoided, etc.). These must come from actually running the code. If you write a placeholder number anywhere, mark it clearly as `// PLACEHOLDER - replace with real solver output` so it can't accidentally end up in the pitch deck.
- The app must show the "prototype uses synthetic maintenance data..." banner (PRD Section 5) somewhere visible in the UI — don't let this get dropped.

## Coding conventions
- Backend: standard Express REST conventions, one router file per resource (`/routes/tasks.js`, `/routes/schedules.js`, etc.), Mongoose schemas matching PRD Section 15 exactly (field names should match the PRD's data model so there's no translation confusion later)
- Python: FastAPI with Pydantic models for request/response validation; keep the CP-SAT model-building logic in its own module (`scheduler.py`) separate from the FastAPI route handlers, so it can be unit-tested standalone without spinning up a server
- Frontend: functional components + hooks, keep API calls in a small `/api` client module rather than scattered `fetch` calls
- Write short docstrings/comments on anything implementing a specific PRD constraint (e.g. `# implements FR3.1 - no double-booking a corridor section`) so it's traceable back to the spec during a demo Q&A

## Testing priorities (given limited time, in this order)
1. The CP-SAT solver in isolation — feed it a small hand-built synthetic scenario and verify constraints are actually respected (no overlaps, deadlines honored). This is the highest-risk component; test it before building anything on top of it.
2. The baseline algorithm — verify it genuinely produces a worse, uncoordinated schedule (this needs to be real, since it's your comparison proof)
3. API contract tests between Node and the Python service (basic request/response shape)
4. Frontend can be visually/manually verified given time constraints — don't over-invest in frontend test coverage for a hackathon prototype

## When you're unsure
- If a PRD section is ambiguous or you have to make a judgment call on something not fully specified, make the most reasonable choice, implement it, and clearly flag the assumption back to me — don't stall waiting for clarification on small things.
- If a request from me would clearly break build-order discipline (see above) or contradict something explicit in the PRD, say so before proceeding.
- Do not add scope beyond what's in the PRD's 🔴/🟠 tiers unless I explicitly ask for a 🟡 item.

## Current phase
Start here: PRD Section 16, item 1-2 — real corridor data ingestion + synthetic maintenance data generator. Nothing else should be built before this exists and produces sane-looking output.
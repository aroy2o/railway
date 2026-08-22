# Product Requirements Document (v3)
## AI-Assisted Railway Maintenance Block Planning & Decision Support System
**SIH Problem Statement ID: 26027** | Ministry of Railways | Category: Software | Theme: Transportation & Logistics

> **Positioning note:** this system is not "an AI scheduler." It is an **AI-assisted constraint optimization platform for railway maintenance block planning** — the real value is answering *"given limited corridor availability, multiple departments, asset risk, maintenance urgency, train operations, and operational constraints, what is the best maintenance plan — and why?"* Machine learning, optimization, and an LLM explanation layer each do a distinct, honest job (Section 10.1) — nothing is forced into being "ML" just to sound more AI.

---

## 1. Executive Summary

Indian Railways' fixed infrastructure maintenance (Engineering/Track, Traction Distribution, and Signal & Telecom) is currently planned **independently by each department** through the BDMS (Block Demand Management System). This decentralization causes conflicting block requests, underutilized corridor windows, poor multi-department coordination, and reduced asset availability and train punctuality.

This project builds a **centralized, AI-assisted Block Planning & Decision Support system** that:
1. Ingests maintenance/defect data (simulated equivalents of TMS, SMMS, TDMS), anchored to real Indian Railways corridor/timetable data
2. Models the full planning chain — **Task → Asset → Location → Corridor → Time Window → Train Impact → Department → Resource** — not just "task fits in a time slot"
3. **Scores and prioritizes** tasks using asset criticality and predicted failure risk, not a manually-entered severity number alone
4. **Optimizes block allocation** via constraint programming to maximize coordinated, non-conflicting, high-utilization, low-train-impact schedules
5. Supports a realistic **human-in-the-loop approval workflow** with a full audit trail, not a one-shot "AI decides" black box
6. Adds differentiating capabilities — explainability, train-impact scoring, what-if simulation, asset criticality, and (stretch) weather-awareness, disruption-resilient re-optimization, resource/dependency constraints — that go beyond a baseline scheduler
7. Outputs **weekly and monthly** block plans via an interactive Gantt-style dashboard, with an explicit **baseline-vs-AI comparison engine** as the core proof-of-value screen

** build. MERN core + Python optimization/AI microservice.**

---

## 2. Problem Statement (Reframed in Engineering Terms)

Strip the domain jargon and this is a **multi-resource constrained scheduling problem with prioritized, uncertain demand and operational (train-impact) side effects**:

| Railway Term | Engineering Equivalent |
|---|---|
| Block/possession window | A bookable time-slot resource on a corridor section |
| Maintenance task (from TMS/SMMS/TDMS) | A job requiring a resource allocation, with duration, department, urgency, and dependencies |
| Train timetable + goods forecast | Resource availability calendar (blackout windows) *and* a source of operational-impact cost when a block is taken |
| BDMS (current manual system) | Uncoordinated, independent, first-come-first-served resource requests — no global optimizer |
| Defects / overdue maintenance | Priority-weighted, partly predictable backlog tied to specific physical assets of varying criticality |

**Core inefficiency to solve:** three departments independently requesting blocks on the *same corridor* when they could share a single combined window — compounded by no system-level view of which maintenance is most urgent, which assets matter most if they fail, and how much a given block actually disrupts train operations.

### 2.1 The planning chain (network-level view)

Indian Railways doesn't just care whether a block is occupied — it cares what happens to train operations as a result:

```
Task
  → Asset (which physical component)
    → Location / Corridor
      → Time Window
        → Train Impact (trains affected, delay estimate)
          → Department (who executes it)
            → Resource (crew, machine, permission needed to execute it)
```

Every part of this PRD from Section 6 onward is structured around this chain, not just "task fits in a time slot."

---

## 3. Goals & Non-Goals

### Goals
- G1: Centralize maintenance demand from 3 simulated department systems into one queue
- G2: Score/rank tasks by asset criticality and predicted failure risk, not a manually-entered severity number alone
- G3: Generate an optimized, conflict-free block schedule respecting timetable *and* train-impact constraints
- G4: Support both weekly (fine-grained) and monthly (coarse allocation) planning horizons
- G5: Prove measurable improvement over an actually-implemented "independent department requests" baseline algorithm, not just a visual mockup of one
- G6: Provide a visual, judge-friendly Gantt dashboard with a realistic approval/audit workflow
- G7: Ship a focused set of genuinely differentiated capabilities (Section 9) rather than many half-built ones — see Section 15 warning

### Non-Goals (state these explicitly to judges — shows maturity, not weakness)
- NG1: Real-time integration with actual TMS/SMMS/TDMS/COA — architecture will expose integration-ready APIs instead
- NG2: Real-time train GPS/signaling data — timetable sourced from real published data, occupancy simulated at daily/weekly granularity
- NG3: Legal/safety certification of the scheduling output — this is a decision-support tool, not an autonomous safety system
- NG4: Claiming the predictive risk model forecasts *real* railway failures — see Section 9.1's honesty framing

---

## 4. Users & Personas

| Persona | Need |
|---|---|
| **Section Engineer (Engineering Dept)** | Submit track maintenance/defect requests, see when their block is scheduled |
| **TRD Engineer (Traction Distribution)** | Submit disconnection requests, same visibility need |
| **S&T Engineer (Signal & Telecom)** | Submit signal maintenance requests |
| **Section Controller / Block planning officer** | Reviews the AI-generated plan, accepts/modifies/rejects it, asks the system "why," resolves conflicts — the primary decision-maker, not a passive viewer |
| **Divisional Railway Manager (oversight)** | Views monthly rollups, KPI hierarchy, train-impact and cost estimates, audit trail |

---

## 5. Datasets

> **Prototype banner (show this visibly in the app UI):** *"Prototype uses synthetic maintenance data anchored to real railway infrastructure and timetable data."* This prevents any confusion for judges about what's real vs simulated.

### 5.1 Real, public data (use these — do not simulate what already exists)

| Data need | Source | What it gives you |
|---|---|---|
| Station list, codes, zones | `datameet/railways` (GitHub, GeoJSON) | Real station codes (e.g. `BDHL`, `LTT`), zone codes (`NWR`, `CR`, etc.) |
| Corridor sections | Derived from `datameet/railways` train routes | Corridor section = any two **consecutive stations** on a real route — extracted programmatically |
| Train timetable (occupied windows) | `data.gov.in` "Indian Railways Train Time Table", or Kaggle CSV mirror | Real departure/arrival times per station per train → per-corridor "occupied" windows per day |
| Goods train forecast | Same timetable dataset, filtered for freight-tagged services; else approximate ~20-30% of daily slots | Corridor occupancy for goods trains |
| Train priority/type (for 9.6 train-impact scoring) | Same timetable dataset (train class/type field) | Distinguish premium/mail-express vs passenger vs goods, so impact scoring isn't uniform per train |
| Monsoon/flood-prone section flags (stretch, 9.9) | IMD open rainfall data + publicly known flood-prone rail sections | Seasonal risk flag per corridor |

**Sources:**
- data.gov.in train timetable catalog: `https://www.data.gov.in/catalog/indian-railways-train-time-table`
- datameet/railways (stations + routes GeoJSON): `https://github.com/datameet/railways`
- Kaggle mirror of the timetable dataset: `https://www.kaggle.com/datasets/harsh16/indian-railways-time-table-for-trains-available`
- Full railways sector catalog: `https://www.data.gov.in/sector/railways`

### 5.2 Synthetic data (must build — genuinely does not exist publicly)

Maintenance/defect data (TMS/SMMS/TDMS equivalents), asset criticality attributes, resource inventories, and task dependencies are internal to Indian Railways and inaccessible to any external team. Generate all of it **anchored to the real corridor list** from 5.1:

```
For each real corridor section:
  - Assign 1-3 physical assets (track segment, signal/relay unit, OHE section)
      each with:
        assetCriticality inputs: passenger-traffic dependency, alternate-route
          availability (yes/no), safety-importance flag, historical-failure
          frequency (synthetic), trains-affected-count (derived from timetable)
        degradationHistory: simulated time-series health metric

  - For each asset, 0-3 pending maintenance tasks:
        department ~ {Engineering: 50%, S&T: 30%, TRD: 20%}
        severity ~ skewed distribution (Beta, not uniform)
        dateRaised ~ random within last 90 days
        slaDueDate ~ dateRaised + (30/60/90 days by severity)
        estBlockDurationMins ~ department-specific realistic range
            Engineering: 120-240 min | S&T: 60-120 min | TRD: 90-180 min
        defectType ~ realistic vocabulary per department
            Engineering: rail fracture, ballast deficiency, joint wear, track geometry defect
            S&T: relay fault, cable fault, point failure, interlocking snag
            TRD: OHE snag, isolator fault, feeder fault, insulator damage
        requiredResource ~ {crew type, machine (e.g. tower wagon), permission
            type (power isolation, traffic block)} — see 9.8
        dependsOn ~ optional reference to a prerequisite taskId — see 9.7
```

Using real defect vocabulary and a resource/dependency layer instead of flat "Defect A/B/C" rows is what makes the synthetic layer feel railway-authentic rather than generic.

---

## 6. Functional Requirements

### FR1 — Data Ingestion Layer
- FR1.1: CRUD interface to log maintenance/defect requests per department, including required resource and optional dependency reference
- FR1.2: Corridor & timetable data loaded from real datasets (5.1), converted into a structured occupancy + train-impact calendar
- FR1.3: Bulk import via CSV/JSON for synthetic data seeding

### FR2 — Asset Risk & Priority Engine
- FR2.1: Compute an **Asset Criticality Score** per asset from: passenger-traffic dependency, alternate-route availability, safety importance, historical failure frequency, number of trains affected
- FR2.2: Compute a **predicted failure risk** per task from synthetic degradation history (framed honestly — see 9.1)
- FR2.3: Combine severity + asset criticality + predicted risk + SLA urgency into one Priority Score, with configurable weights
- FR2.4: Rank all pending tasks, expose ranked queue with a visible breakdown of why (which factor dominated) via API

### FR3 — Block Optimization Engine
- FR3.1: Given ranked tasks + corridor free-window calendar + resource availability + dependency graph, solve for an assignment of tasks → time slots that:
  - Never double-books a corridor section or a required resource (9.8)
  - Respects task dependency ordering (9.7)
  - Respects minimum/maximum block duration per task type
  - Respects timetable blackout windows
  - **Batches multiple departments' tasks into a shared block on the same corridor/date where feasible**
  - Minimizes estimated train-delay impact (9.6)
  - Maximizes total priority-weighted coverage within available block-hours
  - (Stretch, 9.9) Down-weights scheduling on flagged flood/monsoon-risk corridors during high-risk windows
- FR3.2: Two solve modes: **Weekly** and **Monthly**
- FR3.3: Return unscheduled/deferred tasks explicitly with reason — never silently drop tasks
- FR3.4: Expose **policy sliders** (urgency vs punctuality vs utilization vs risk-avoidance weighting) that the Controller can adjust and regenerate the plan against (see 13.1)
- FR3.5: (Stretch, 9.10) Support incremental re-optimization when an emergency/unplanned block request arrives mid-week

### FR4 — Conflict Detection & Resolution (9.5)
- FR4.1: Detect and explicitly classify conflicts into named types: corridor conflict, train-impact conflict, resource conflict, dependency-ordering conflict
- FR4.2: For each conflict type, apply a defined resolution strategy (merge windows, reject/defer, reassign resource, reorder) and log which strategy was applied

### FR5 — What-If Simulation (9.4)
- FR5.1: Given a candidate task, generate 2+ scheduling options (different time windows/corridors)
- FR5.2: For each option, compute: asset downtime, estimated train-delay impact, batching achieved, utilization
- FR5.3: Recommend the best option with a stated reason; Controller can pick any option, not just the recommendation

### FR6 — Human-in-the-Loop Approval Workflow (9.3)
- FR6.1: Every generated plan follows: **AI Generated → Controller Review → Modify/Accept/Reject → Constraint Re-validation → Final Approval → Published Block Plan**
- FR6.2: Every manual override is logged with: original AI assignment, new assignment, stated reason, re-validation result (constraints still satisfied? train-impact delta?)
- FR6.3: Published plans are versioned; prior versions remain viewable for audit

### FR7 — Visualization & Dashboard
See Section 8 for full page-by-page structure.

### FR8 — Explainability Layer (9.2)
- FR8.1: Every scheduled/deferred/batched task carries a machine-generated, plain-English justification grounded in the solver's own decision log
- FR8.2: Controller can ask free-text questions on the Controller Dashboard ("why wasn't the relay fault fixed this week?") and get a grounded answer, not a free-form LLM guess

### FR9 — Baseline vs AI Comparison Engine (9.11)
- FR9.1: Implement an actual **naive baseline algorithm** (each department schedules its own tasks independently, first-come-first-served, no cross-department visibility) — not just a mocked "before" number
- FR9.2: Run both baseline and optimized engine on the same input data, store both outputs
- FR9.3: Display a metrics table: block hours, utilization %, conflicts, batched blocks, deferred critical tasks, estimated train delay — baseline vs AI, side by side

### FR10 — Auth & Roles
- FR10.1: Role-based login: Dept Engineer / Controller / DRM
- FR10.2: JWT-based auth

---

## 7. Non-Functional Requirements
- Weekly-horizon schedule generation should return in a demo-acceptable time (<10s for ~50-100 tasks)
- Every scheduling decision must be traceable to a reason — this is a first-class feature (FR8), not an afterthought
- Every manual override must be re-validated against constraints before being accepted (FR6.2) — the system should never silently allow an invalid published plan
- Responsive, desktop-first UI (demo will be on a laptop/projector)

---

## 8. Dashboard Structure (by role)

**1. Login / Role selector** — Dept Engineer / Controller / DRM

**2. Dept Engineer Portal**
- Form to log a maintenance/defect request (corridor, asset, defect type, severity, est. duration, required resource, optional dependency)
- List of their own submitted requests + status
- Read-only view of their scheduled blocks once the plan is published

**3. Controller Dashboard (primary demo screen)**
- KPI strip (hierarchy per Section 14)
- Corridor timeline (Gantt, department color-coded, weekly/monthly toggle)
- Priority queue sidebar — ranked tasks with severity + asset criticality + predicted risk breakdown
- Policy sliders (urgency / punctuality / utilization / risk-avoidance) — regenerate plan on change
- "Generate schedule" trigger
- **What-if panel** — select a task, see 2+ scheduling options side by side with impact metrics and an AI recommendation
- Manual override with mandatory reason field, auto re-validation feedback
- **"Ask the Planner" box** — free-text question → grounded NL explanation

**4. Baseline vs AI Comparison View**
- Actual dual-run metrics table (FR9.3), not just a visual mockup
- Utilization/conflict/train-delay deltas called out explicitly — your strongest single screen for judges

**5. Approval & Audit Trail View**
- Full history of AI-generated → modified → approved plans, with every override's reason and re-validation result
- Plan version history

**6. DRM / Oversight View**
- KPI hierarchy rollups: Operations, Maintenance, Planning, Asset (Section 14)
- Monthly trend charts
- Exportable report

**7. Task/Block Detail Drill-down**
- Batched tasks, department mix, plain-English reasoning, asset criticality + risk score breakdown, resource assignment, dependency chain if any

Build order: Controller Dashboard (3) and Baseline vs AI (4) first — these two screens are your actual demo. Everything else supports them.

---

## 9. Differentiators — What Makes This Stand Out

Most SIH teams on this PS will build: ingest data → weighted priority score → basic scheduler → static Gantt chart. That clears the bar but doesn't win. Each item below is chosen because it's (a) genuinely useful to a real Railway official, (b) demoable in a short pitch, and (c) buildable . **Sections 9.1-9.6 are core — build into the main flow. 9.7-9.10 are strong-but-optional; only reach for them if the core is stable with time to spare.**

### 9.1 Predictive risk scoring — honestly framed
Train a simple model (survival analysis or a gradient-boosted classifier) on synthetic degradation history to estimate probability of failure before the next inspection cycle. **Important framing correction:** never claim this predicts *real* railway failures — the training labels are synthetic. Describe it in the app and pitch as: *"Prototype predictive risk model trained on simulated asset degradation patterns, designed to be replaced/retrained using historical railway asset-health data when available."* This is both more honest and more credible — a domain-expert judge who asks "where did your failure labels come from?" gets an answer that holds up.

### 9.2 Explainable scheduling — "Ask the Planner"
Every CP-SAT decision is logged with its contributing factors. An LLM call turns the log into a plain-English justification, exposed as a chat box on the Controller Dashboard. Answers must be grounded strictly in the solver's own decision log — never let the LLM invent numbers. This directly answers the question every judge asks any optimization demo: *"how do I trust what the AI decided?"*

### 9.3 Human-in-the-loop approval workflow with audit trail
AI Generated → Controller Review → Modify/Accept/Reject → Constraint Re-validation → Final Approval → Published Block Plan, with every override logged (original assignment, new assignment, reason, re-validation result, train-impact delta). This is what turns the system from "a scheduling algorithm" into "a decision-support system a real Railway officer would actually be allowed to use," and gives you auditability as a talking point.

### 9.4 What-if simulation
Controller asks "what if I move this from Tuesday to Thursday?" — system generates multiple concrete options with downtime, train-delay impact, batching, and utilization for each, then states a recommendation with a reason. This is one of your strongest live-demo features because it's interactive and visibly intelligent rather than a static output.

### 9.5 Explicit conflict typing and resolution
Don't just "avoid conflicts" inside the solver silently — name and demo the conflict types: **corridor conflict** (two departments, same corridor, overlapping time → merge if feasible), **train-impact conflict** (maintenance window collides with a high-priority train → block rejected/deferred), **resource conflict** (two tasks need the same crew/machine → only one proceeds). Showing these as distinct, named cases with distinct resolutions is far more convincing to judges than a black-box "optimized" label.

### 9.6 Train-Impact-Aware Block Planning
For every candidate block, compute: number and type of trains affected, their priority (mail/express vs passenger vs goods, from real timetable data), and an estimated delay-impact score. This becomes a term in the optimization objective (Section 13), not just a display metric — the system genuinely trades off maintenance urgency against operational disruption, which is the real question Railways is asking in the PS description, not just "is the corridor free."

### 9.7 Task dependency constraints
Some maintenance activities must happen in order (e.g. inspection → repair → testing → block released). Represent this as a dependency graph per asset and add precedence constraints to the CP-SAT model so a later-stage task is never scheduled before its prerequisite. Good technical talking point for judges — shows the model isn't just "pack tasks into slots" but understands real maintenance workflows.

### 9.8 Maintenance resource constraints
Real maintenance requires more than corridor time: personnel, machines (e.g. tower wagon), specialized teams, and disconnection permissions. Add a resource layer so two tasks needing the same crew/machine at overlapping times are flagged as a resource conflict (9.5) and only one can proceed. Makes the optimizer a genuine resource-constrained scheduling system, not just a time-slot packer.

### 9.9 Weather/monsoon-aware scheduling
Tag corridors with a seasonal risk flag from public IMD/flood-prone-section data; optimizer avoids long blocks on high-risk corridors during high-risk windows, or prioritizes pre-monsoon inspection instead. Domain-grounded, low-effort-to-add differentiator.

### 9.10 Disruption-resilient rolling re-optimization
"Simulate an emergency block request" button triggers incremental re-optimization of the remaining week's schedule (re-solve only the affected corridor/window, holding already-executed blocks fixed). Shows the system works in the messy real world, not just on a clean static input.

### 9.11 Baseline vs AI comparison engine (implemented, not mocked)
Actually implement the naive baseline (each department scheduling independently, no cross-visibility) and run it against the same data as the optimizer, then present a real side-by-side metrics table. This is likely your single strongest judging screen — see Section 12.

---

## 10. Tech Stack

### 10.1 How to talk about "AI" honestly
Be precise in the pitch and architecture diagram about which layer does what — this is more credible than claiming everything is "AI":

```
Machine Learning   → predict asset failure risk (9.1)
Optimization (OR)  → find the best feasible schedule (CP-SAT)
LLM                → explain the schedule in plain English (9.2)
Rules/Constraints  → guarantee feasibility (corridor, resource, dependency, train-impact)
```

### 10.2 Core: MERN
| Layer | Tech | Notes |
|---|---|---|
| Frontend | React (Vite), TailwindCSS | Gantt via `react-big-calendar` or custom SVG/D3 timeline |
| Backend (API/orchestration) | Node.js + Express | Auth, CRUD, data ingestion, calls optimization/AI microservice |
| Database | MongoDB | Tasks, assets, corridors, timetable, users, schedules, decision logs, audit logs |
| Auth | JWT + bcrypt | Simple role-based |

**Note on MongoDB vs PostgreSQL:** the domain is genuinely relational (Department → Task → Asset → Corridor → Station → Train → Timetable → Block), which would map cleanly to PostgreSQL. For an SIH prototype timeline, staying on MongoDB (if that's what you're already comfortable with) is completely fine — don't spend build time migrating for theoretical purity. If you have the bandwidth and are equally comfortable in both, PostgreSQL is the more natural long-term fit and worth mentioning in the pitch as a planned production consideration.

### 10.3 Optimization/AI Microservice
| Layer | Tech | Why |
|---|---|---|
| Scheduler | Python + **Google OR-Tools (CP-SAT)** | Industry-standard constraint solver — no equivalent in the Node ecosystem |
| Asset risk / prioritization model (9.1) | Python + scikit-learn (or `lifelines` for survival analysis) | Trained on synthetic degradation data; falls back to a transparent weighted formula if time-constrained |
| Explainability layer (9.2) | LLM API call (e.g. Claude API) fed the solver's structured decision log | Grounded natural-language justification |
| Service framework | FastAPI | Exposes `/prioritize`, `/optimize-schedule`, `/whatif`, `/explain` endpoints |

**One-line justification for judges:** *"We use MERN for the full product experience — data management, auth, dashboards — and a dedicated Python service for the CP-SAT solver, risk model, and explainability layer, because constraint-programming scheduling and survival-analysis modeling need purpose-built libraries that don't exist in JavaScript. This is a standard microservice pattern, not a stack inconsistency."*

### 10.4 Supporting tools
- Visualization: D3.js or Recharts for KPI charts
- Synthetic data generator: Python script anchored to real `datameet/railways` + `data.gov.in` data (Section 5)
- Deployment (demo): Docker Compose (Node + Python + Mongo containers)

---

## 11. System Architecture

```
                 ┌───────────────────────┐
                 │   Railway Data Layer    │
                 │  TMS  SMMS  TDMS  COA   │
                 │  Timetable   Weather    │
                 └───────────┬─────────────┘
                             ↓
                 ┌───────────────────────┐
                 │  Data Normalization     │
                 └───────────┬─────────────┘
                             ↓
                 ┌───────────────────────┐
                 │  Asset Risk Engine      │
                 │  Failure probability    │
                 │  Asset criticality      │
                 │  SLA urgency            │
                 └───────────┬─────────────┘
                             ↓
                 ┌───────────────────────┐
                 │  Priority Engine        │
                 └───────────┬─────────────┘
                             ↓
   ┌─────────────────────────────────────────────┐
   │        CP-SAT Optimization Engine              │
   │  Corridor constraints   Train-impact scoring    │
   │  Resource constraints   Department batching     │
   │  Dependencies            Weather risk            │
   │  Asset criticality        Policy-slider weights  │
   └───────────────────────┬───────────────────────┘
                             ↓
                 ┌───────────────────────┐
                 │  Optimized Plan          │
                 │  + Decision Log           │
                 └───────────┬─────────────┘
                             ↓
              ┌──────────────────────────────┐
              │  Controller Review              │
              │  Accept / Modify / Reject        │
              │  What-if simulation               │
              │  Ask the Planner (reads log)       │
              └────────────┬──────────────────┘
                             ↓
                 ┌───────────────────────┐
                 │  Constraint Re-validation│
                 └───────────┬─────────────┘
                             ↓
                 ┌───────────────────────┐
                 │  Published Block Plan    │
                 │  (versioned, audited)     │
                 └───────────────────────┘
```

### Implementation view (React/Node/Mongo/FastAPI)

```
React Frontend (dashboards, what-if UI, Ask-the-Planner, audit trail)
        │  REST/JSON, JWT auth
Node.js / Express API (auth, CRUD, orchestrates microservice calls,
        stores schedules + decision logs + audit logs)
        │
MongoDB  ←─results──  Python FastAPI microservice
(tasks, assets,                (/prioritize, /optimize,
 corridors, timetable,          /whatif, /explain)
 users, schedules,
 decision_logs, audit_logs)
```

### Data flow
1. Dept engineers submit tasks (with asset, resource, dependency links) → MongoDB
2. Controller triggers "Generate Schedule" → Node fetches tasks + corridor calendar + resources + policy-slider weights → `/prioritize` (asset criticality + risk-scored ranking) → `/optimize` (CP-SAT, all constraint layers) → returns assignment + structured decision log
3. Node stores schedule + decision log; frontend renders Gantt, conflict list, and baseline-vs-AI comparison
4. Controller reviews: uses What-if (`/whatif`) on specific tasks, asks questions via `/explain`, modifies/accepts/rejects — every action re-validated and logged to `audit_logs`
5. Approved plan is published and versioned

---

## 12. Baseline vs AI Comparison Engine

This is your strongest single judging screen — implement it for real, not as a mockup:

**Baseline algorithm:** each department schedules its own tasks independently (first-come-first-served against the shared corridor calendar, no visibility into other departments' requests) — this mirrors the actual current BDMS process described in the PS.

**AI engine:** all tasks pooled → priority engine → CP-SAT global optimization → batching → train-impact minimization.

Run both on the same synthetic dataset and present:

| Metric | Baseline | AI-Optimized |
|---|---|---|
| Block hours used | e.g. 42h | e.g. 31h |
| Utilization | e.g. 63% | e.g. 91% |
| Conflicts | e.g. 17 | e.g. 2 |
| Batched blocks | 0 | e.g. 11 |
| Deferred critical tasks | e.g. 6 | e.g. 1 |
| Estimated train delay | e.g. 184 min | e.g. 71 min |

(Numbers above are illustrative placeholders — populate with your actual run output, never fabricate final figures for the pitch.)

---

## 13. Optimization Model (CP-SAT) — Conceptual Spec

**Decision variables:** For each task *i* and each candidate free window *j* on its corridor, a boolean `assign[i][j]`.

**Constraints:**
- Each scheduled task assigned to exactly one window (or zero, if deferred)
- Sum of task durations assigned to a window ≤ window length
- No overlap between windows on the same corridor
- No overlap on the same required resource across concurrent tasks (9.8)
- Dependency ordering: a task cannot be scheduled before its prerequisite completes (9.7)
- Tasks from different departments on the same corridor/day may share a window if combined duration fits (batching)
- Deadline constraint: task assigned before `slaDueDate` where feasible
- (Stretch, 9.9) Penalize/restrict assignment to flood-prone corridors during flagged high-risk windows

### 13.1 Objective function

```
MAXIMIZE
  α × Maintenance Priority
+ β × Asset Risk Reduction
+ γ × Block Utilization
+ δ × Cross-Department Batching
+ ε × SLA Compliance

MINIMIZE
  λ × Train Delay Impact
+ μ × Unused Block Time
+ ν × Schedule Fragmentation
+ ξ × Weather/Seasonal Risk       (stretch)
+ ρ × Resource Conflicts
```

Expose α, β, γ, δ, ε, λ, μ, ν, ξ, ρ as **policy sliders** on the Controller Dashboard (e.g. "Maintenance urgency," "Train punctuality," "Block utilization," "Risk avoidance") — the Controller can adjust weighting and regenerate the plan live. This is an excellent, concrete demo moment: show the schedule visibly change when a slider moves.

**Two horizons:**
- Monthly = coarse: allocate corridor-days per department cluster (reservation-level)
- Weekly = fine: solve exact slot assignment within monthly reservations

**Incremental re-optimization (9.10, stretch):** re-solve constrained to only the affected corridor and remaining unelapsed time window, holding already-executed blocks fixed.

---

## 14. KPI Hierarchy

Group dashboard KPIs by category rather than one flat list — this makes the DRM/oversight view much stronger:

| Category | KPIs |
|---|---|
| **Operations** | Estimated train delay, affected trains, blocked corridor hours, unused block hours |
| **Maintenance** | Tasks completed, overdue tasks, critical tasks completed, predicted failure risk reduced |
| **Planning** | Block utilization, batching ratio, conflict count (by type, 9.5), schedule stability |
| **Asset** | Asset availability %, downtime, count of high-criticality assets still at risk |

---

## 15. Data Model (MongoDB collections, simplified)

**assets** (new)
```
{ _id, corridorId, assetType: "track"|"signal"|"OHE", 
  criticality: { passengerDependency, alternateRouteAvailable: bool,
    safetyImportance, historicalFailureFreq, trainsAffectedCount },
  criticalityScore (computed), degradationHistory: [{date, healthMetric}] }
```

**tasks**
```
{ _id, department, corridorId, assetId, defectType, severity: 1-5,
  dateRaised, slaDueDate, estBlockDurationMins,
  requiredResourceId, dependsOnTaskId (nullable),
  priorityScore (computed), failureRiskScore (computed, 9.1),
  status: "pending"|"scheduled"|"deferred" }
```

**resources** (new, 9.8)
```
{ _id, type: "crew"|"machine"|"permission", name, corridorScope }
```

**corridors**
```
{ _id, name, zone, section, maxDailyBlockWindows: [{start,end}],
  seasonalRiskFlag: "none"|"monsoon-risk"|"flood-prone" }
```

**timetable**
```
{ _id, corridorId, date, occupiedWindows: [{start,end,trainType,trainPriority}] }
```

**schedules**
```
{ _id, horizon: "weekly"|"monthly", generatedAt, policyWeights: {...},
  blocks: [{ corridorId, start, end, taskIds: [...], departments: [...],
    trainImpact: { trainsAffected, estimatedDelayMinutes } }],
  deferredTasks: [{ taskId, reason }],
  comparisonToBaseline: {...} (12) }
```

**decision_logs**
```
{ _id, scheduleId, taskId, decision: "scheduled"|"deferred"|"batched",
  contributingFactors: [...], plainEnglishExplanation }
```

**audit_logs** (new, 9.3)
```
{ _id, scheduleId, taskId, action: "override"|"approve"|"reject",
  originalAssignment, newAssignment, reason, revalidationResult: {
    constraintsSatisfied: bool, trainImpactDelta }, timestamp, actorRole }
```

**conflicts** (new, 9.5)
```
{ _id, scheduleId, type: "corridor"|"train-impact"|"resource"|"dependency",
  involvedTaskIds: [...], resolutionStrategy, resolved: bool }
```

---

## 16. Milestones — Recommended Priority Order

**🔴 Must build (core loop, judge-verifiable end to end)**
1. Real railway corridor data ingestion
2. Synthetic maintenance/asset data generator
3. Timetable blackout + train-impact calendar
4. Asset criticality + priority engine
5. CP-SAT optimizer (corridor + resource + basic constraints)
6. Multi-department batching
7. Weekly planner
8. Gantt dashboard
9. Baseline algorithm implemented + Baseline vs AI comparison screen (12)
10. Manual override + constraint re-validation

**🟠 Strong differentiators (add once the above works end-to-end)**
11. Predictive asset-risk model (9.1, honestly framed)
12. Ask-the-Planner explainability (9.2)
13. Human-in-the-loop approval workflow + audit trail (9.3)
14. What-if simulation (9.4)
15. Conflict typing and resolution display (9.5)
16. Train-impact-aware scoring in the objective function (9.6)

**🟡 Stretch (only if core + differentiators are solid with time to spare)**
17. Task dependency constraints (9.7)
18. Maintenance resource constraints (9.8)
19. Weather/monsoon-awareness (9.9)
20. Emergency rolling re-optimization (9.10)
21. Monthly planning polish

---

## 17. Demo Script

1. Show the *problem*: baseline algorithm output — departments independently requesting blocks on the same corridor → conflicts/wasted windows (this is a real computed baseline, not a mockup)
2. Show the *asset-aware ranking*: pending tasks ranked by asset criticality + predicted risk, not just reported severity
3. Trigger schedule generation → clean Gantt chart from CP-SAT
4. Highlight a **multi-department batched block** — your core value prop
5. Open the **Baseline vs AI comparison table** — the strongest single screen, real computed numbers
6. Move a **policy slider** live and regenerate — show the plan visibly change
7. Open **What-if simulation** on one task — show two options with train-impact and utilization side by side, and the AI's recommendation
8. Type a live question into **Ask the Planner** — e.g. "why wasn't the relay fault fixed this week?" — grounded, specific answer
9. Show a manual **override**, its logged reason, and the constraint re-validation result
10. (If built) Trigger an emergency block request live and show incremental re-optimization
11. Close with the honest integration story: *"Production version connects via API to real TMS/SMMS/TDMS/COA — architecture is integration-ready; the predictive model is designed to be retrained on real historical asset-health data once available."*

---

## 18. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| No real Railway maintenance data | Real corridor/timetable data + realistic synthetic generator anchored to it; visible "prototype" banner in-app |
| CP-SAT complexity/time overrun | Build and validate solver in isolation FIRST, before any UI work |
| Feature list too large for  timeline | Strict 🔴/🟠/🟡 priority order (Section 16) — never start a 🟡 item before all 🔴 items work end-to-end |
| Judges are domain experts and probe deeply | Learn basic real block-planning/COA/BDMS terminology; lean on any real railway domain knowledge available to you for authentic constraints and terminology |
| LLM explainability hallucinating | Ground every explanation strictly in the solver's own decision log, never let the LLM invent numbers |
| Overclaiming the predictive model | Always describe it as trained on simulated data, explicitly designed to be retrained on real historical data (9.1) |
| Baseline comparison looking fabricated | Actually implement and run the naive baseline algorithm (FR9.1) — never hand-type "before" numbers |

---

## 19. Success Metrics for the Demo
- % improvement in corridor/window utilization vs the *actually-computed* baseline
- Number of cross-department blocks successfully batched
- % of high-criticality / high-predicted-risk tasks scheduled within SLA
- Estimated train-delay-minutes avoided vs baseline
- Solver runtime for weekly horizon (show it's fast/scalable)
- Number of conflict types correctly detected and resolved live
- Number of "Ask the Planner" questions correctly, verifiably answered live in the demo

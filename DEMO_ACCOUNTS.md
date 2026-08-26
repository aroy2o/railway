# Demo accounts (FR10.1)

Four fixed accounts, one per role. No self-registration — these are the only
accounts that will ever exist, and `npm run seed` (re)creates them every time
it runs (`backend/src/scripts/seed.ts`, `seedUsers()`).

Not shown in the login UI itself, per the auth session's design: the login
screen is a plain username/password form, kept honest about what real
role-based auth looks like. This file (and the seed script's own console
output) is where a demo operator looks instead.

| Role | Username | Password | Notes |
|---|---|---|---|
| Dept Engineer | `engineer` | `engineer123` | Fixed to the Engineering department. Can submit maintenance requests (FR1.1) and see only their own. |
| Controller | `controller` | `controller123` | Full read/write on the Controller Dashboard, Comparison, and Approval & Audit. |
| DRM | `drm` | `drm123` | Read-only: Oversight view, and read-only access to Approval & Audit. |
| Super Admin | `admin` | `admin123` | **Not a PRD role** — a demo/dev convenience that bypasses every role gate so a judge or demo operator never gets stuck mid-pitch. See `docs/DECISIONS.md`. Never present this as a PRD-specified feature. |

These are not real secrets — do not reuse them for anything beyond this
prototype.

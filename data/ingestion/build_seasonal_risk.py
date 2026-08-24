"""Build the corridor seasonal-risk classification (task T26, PRD 9.9).

Reads only ``processed/corridors.json`` - no new downloads. Run after
``ingestion.build_corridors``:

    python -m ingestion.build_corridors        # T2: corridors.json
    python -m ingestion.build_seasonal_risk     # T26: corridor_seasonal_risk.json

Output:

    processed/corridor_seasonal_risk.json   per-corridor flag + reason
    processed/SEASONAL_RISK_REPORT.json     coverage stats

**This step does not modify corridors.json.** Same reason as T3 (D-009):
`seasonalRiskFlag` genuinely needs data T2's own sources
(datameet/railways) do not carry, so it is a separate stage, joined onto
`Corridor` at seed time exactly like T3's `occupancySummary` (D-016).

WHAT THIS ACTUALLY CLASSIFIES, AND WHY IT IS NARROW
----------------------------------------------------
PRD Section 5.1 names two real sources for this field: "IMD open rainfall
data" and "publicly known flood-prone rail sections". Both were checked
before writing this module, not assumed available:

* Section-specific flood data exists and is real (e.g. Konkan Railway
  publishes named vulnerable locations - Chiplun, Ratnagiri, Karwar, Udupi,
  Mangaon - with river-bridge flood-warning stations), but NONE of it
  touches the 26 corridors this project's real synthetic-demand corpus
  actually uses. Sourcing it would be honest but useless here.
* IMD rainfall data exists at district/state granularity via data.gov.in,
  but only 8 of those 26 corridors have ANY state metadata at all - a real
  gap in the underlying `datameet/railways` station data (roughly half of
  all 8,990 real stations lack a `state` field), not something this script
  can fill in.

So the classification below is real but coarse: a corridor is flagged
`"monsoon-risk"` only when at least one of its two stations has a KNOWN
state that the Ministry of Jal Shakti names among India's most
flood-affected (see HIGH_FLOOD_RISK_STATES below, sourced). A known state
NOT on that list is honestly `"none"` - checked, not flagged - never
guessed as safe. An UNKNOWN state stays `null`, with a reason, exactly
T16's "no data" pattern for `failureRiskScore`: absence of information is
never scored as a favourable finding.

`"flood-prone"` (the third value PRD Section 15's enum allows, for genuine
section-specific data like the Konkan example above) is never emitted here,
because this project's real corpus never overlaps a corridor precise enough
to earn it. Emitting it anyway would be exactly the kind of overclaim this
codebase's honesty discipline exists to prevent.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from ingestion.build_corridors import CORRIDORS_OUT, _write_json
from ingestion.sources import PROCESSED_DIR

RISK_OUT = PROCESSED_DIR / "corridor_seasonal_risk.json"
REPORT_OUT = PROCESSED_DIR / "SEASONAL_RISK_REPORT.json"

#: India's most flood-affected states, per the Ministry of Jal Shakti's
#: national estimate (cited via the Assam State Disaster Management
#: Authority's own flood-management page, which quotes the Rashtriya Barh
#: Ayog assessment, and a 2015 Lok Sabha reply from the Ministry of Home
#: Affairs summarising the same Jal Shakti data): "India is highly
#: vulnerable to floods in which Assam, Bihar, Odisha, Uttar Pradesh, and
#: West Bengal are largely affected." Assam alone carries 31.05 lakh
#: hectares of flood-prone area - 9.40% of the country's total - and Bihar
#: has all 38 districts affected. A fixed, cited list rather than a scraped
#: live API, for the same reason D-023's slider range is fixed rather than
#: re-derived: it does not need re-verifying every time the corpus changes.
HIGH_FLOOD_RISK_STATES = frozenset(
    {"Assam", "Bihar", "Odisha", "Uttar Pradesh", "West Bengal"}
)

#: IMD's own published "normal" dates for the Southwest Monsoon: onset over
#: Kerala around June 1 (covering the whole country by ~July 8), retreat
#: beginning around September 17, complete withdrawal by October 15. Used
#: by the OPTIMIZER (app/core/weather.py), not here - this script only
#: classifies corridors, never dates - but recorded alongside the source it
#: shares so the two stay traceable to the same citation.
MONSOON_WINDOW_NOTE = (
    "IMD normal Southwest Monsoon dates: onset ~June 1, complete withdrawal "
    "by ~October 15."
)


def classify(states: list[str]) -> tuple[str | None, str]:
    """One corridor's flag and the reason behind it - never guessed.

    Mirrors T16's `failureRiskScore` honesty pattern exactly: no data ->
    `None` with a stated reason, not a default of "no risk".
    """
    if not states:
        return None, "no state metadata for either station (real data gap, not computed)"
    flagged = sorted(set(states) & HIGH_FLOOD_RISK_STATES)
    if flagged:
        return (
            "monsoon-risk",
            f"{'/'.join(flagged)} is named among India's most flood-affected states "
            "by the Ministry of Jal Shakti",
        )
    return "none", f"known state(s) {'/'.join(sorted(states))}, none on the flood-affected list"


def build() -> dict:
    if not CORRIDORS_OUT.exists():
        raise SystemExit("corridors.json missing. Run:  python -m ingestion.build_corridors")

    corridors = json.loads(CORRIDORS_OUT.read_text())["corridors"]

    entries = []
    counts = {"monsoon-risk": 0, "none": 0, "unknown": 0}
    for corridor in corridors:
        flag, reason = classify(corridor["states"])
        counts["unknown" if flag is None else flag] += 1
        entries.append({"_id": corridor["_id"], "seasonalRiskFlag": flag, "reason": reason})

    report = {
        "task": "T26 - corridor seasonal-risk classification (PRD 9.9)",
        "method": (
            "A corridor is 'monsoon-risk' when at least one station's real state is "
            "named among India's most flood-affected by the Ministry of Jal Shakti; "
            "'none' when the state is known and not on that list; null ('unknown') "
            "when neither station has state metadata at all. 'flood-prone' is never "
            "emitted - this project has no section-specific data that would earn it."
        ),
        "highFloodRiskStates": sorted(HIGH_FLOOD_RISK_STATES),
        "monsoonWindow": MONSOON_WINDOW_NOTE,
        "counts": {**counts, "total": len(entries)},
    }

    return {"entries": entries, "report": report}


def _write(result: dict) -> None:
    PROCESSED_DIR.mkdir(parents=True, exist_ok=True)
    _write_json(
        RISK_OUT,
        {
            "source": (
                "Ministry of Jal Shakti flood-affected-states estimate, via Assam "
                "State Disaster Management Authority (Rashtriya Barh Ayog assessment) "
                "and a 2015 Lok Sabha reply from the Ministry of Home Affairs. Joined "
                "against T2's real station `state` field - never against invented "
                "corridor identity."
            ),
            "disclaimer": (
                "SEASONAL RISK FLAGS. Real government flood-risk data joined by real "
                "station state, but coarse: state-level, not section-specific, and "
                "only available where T2's source data carries a station's state at "
                "all (a real gap - see this file's module docstring)."
            ),
            "count": len(result["entries"]),
            "corridorSeasonalRisk": result["entries"],
        },
    )
    _write_json(REPORT_OUT, result["report"])


def main() -> int:
    result = build()
    _write(result)
    for path in (RISK_OUT, REPORT_OUT):
        print(f"Wrote {path.relative_to(PROCESSED_DIR.parent)} ({path.stat().st_size:,} bytes)")
    print("\n--- seasonal risk report ---")
    print(json.dumps(result["report"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

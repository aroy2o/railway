"""Build data/processed/corridor_seasonal_risk.json for the fulldata-ktv-psa
branch - deliberately left unpopulated (`null`) for every corridor.

PRD 9.9 (a stretch/🟡 item, not required) asks for a seasonal risk flag
sourced from IMD rainfall data + publicly known flood-prone sections. The
original pipeline's `build_seasonal_risk` (T26) at least gets as far as a
state-level match against Ministry of Jal Shakti flood data for the corridors
it covers. full_data has no equivalent dataset for the KTV-PSA corridor at
all, so - following this project's own rule of never guessing a value it
does not have - every corridor here gets `seasonalRiskFlag: null` with a
reason, not an invented flag.

    python -m ingestion.build_seasonal_risk_fulldata
"""

from __future__ import annotations

import json
import sys

from ingestion.build_corridors_fulldata import CORRIDORS_OUT
from ingestion.fulldata_sources import PROCESSED_DIR

RISK_OUT = PROCESSED_DIR / "corridor_seasonal_risk.json"

REASON = (
    "full_data has no monsoon/flood-risk dataset for the KTV-PSA corridor - "
    "left null rather than guessed (PRD 9.9 is a stretch item, not required)"
)


def build() -> dict:
    payload = json.loads(CORRIDORS_OUT.read_text())
    entries = [
        {"_id": corridor["_id"], "seasonalRiskFlag": None, "reason": REASON}
        for corridor in payload["corridors"]
    ]

    RISK_OUT.write_text(
        json.dumps(
            {
                "source": "fulldata-ktv-psa branch: not populated, see REASON on each entry",
                "count": len(entries),
                "corridorSeasonalRisk": entries,
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    print(f"Wrote {RISK_OUT} ({len(entries)} corridors, all seasonalRiskFlag=null)")
    return {"outputs": {"corridors": len(entries), "flagged": 0}}


def main() -> int:
    report = build()
    print(json.dumps(report["outputs"], indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

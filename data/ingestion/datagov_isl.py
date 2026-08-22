"""Parse the data.gov.in ISL-wise train timetable CSV.

Used in task T2 for two narrow purposes only:

1. **Cross-validation.** This file records stop order in an explicit ``islno``
   column, so corridor sections derived from it are independent of the id-order
   inference used on datameet's schedules.json. Agreement between two
   unrelated sources is real evidence the extraction is correct.
2. **Real section lengths.** The ``Distance`` column is cumulative kilometres
   from the origin, so the difference between consecutive stops is an actual
   published inter-station distance - far better than a straight-line estimate.

Building the per-corridor occupancy calendar from the arrival/departure columns
is deliberately **not** done here; that is task T3.
"""

from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

#: Column names exactly as they appear in the published header row.
COL_TRAIN = "Train No."
COL_ISLNO = "islno"
COL_STATION = "station Code"
COL_DISTANCE = "Distance"


@dataclass
class IslSection:
    """An undirected section observed in the ISL timetable."""

    code_a: str
    code_b: str
    traversals: int = 0
    #: Published inter-station distance in km, when a consistent one is available.
    distance_km: float | None = None


def load_isl_sections(path: Path) -> tuple[dict[tuple[str, str], IslSection], dict[str, int]]:
    """Derive corridor sections and real inter-station distances from the CSV.

    Stop order comes from ``islno``, which restarts at 1 for each train run. A
    non-increasing islno therefore marks the start of a new run, which is how
    duplicated or multi-leg entries are prevented from chaining a phantom
    section between one run's last stop and the next run's first.
    """
    by_train: dict[str, list[tuple[int, str, float | None]]] = defaultdict(list)

    with path.open(newline="", encoding="utf-8-sig", errors="replace") as handle:
        reader = csv.DictReader(handle)
        missing = {COL_TRAIN, COL_ISLNO, COL_STATION} - set(reader.fieldnames or [])
        if missing:
            raise ValueError(f"{path.name} is missing expected columns: {sorted(missing)}")

        for row in reader:
            train = _clean(row.get(COL_TRAIN)).strip("'")
            code = _clean(row.get(COL_STATION))
            islno = _as_int(row.get(COL_ISLNO))
            if not train or not code or islno < 0:
                continue
            by_train[train].append((islno, code, _as_float(row.get(COL_DISTANCE))))

    sections: dict[tuple[str, str], IslSection] = {}
    #: Distances seen per section; a section is only assigned a distance when
    #: every observation agrees, so a conflicting value is dropped rather than
    #: silently averaged into a number no source actually published.
    distances: dict[tuple[str, str], set[float]] = defaultdict(set)
    stats = {"trains": 0, "runs": 0, "pairs_accepted": 0, "skipped_self_loop": 0}

    for train, stops in by_train.items():
        stats["trains"] += 1
        stops.sort(key=lambda item: item[0])

        runs: list[list[tuple[int, str, float | None]]] = [[stops[0]]]
        for previous, current in zip(stops, stops[1:]):
            if current[0] > previous[0]:
                runs[-1].append(current)
            else:
                runs.append([current])

        for run in runs:
            stats["runs"] += 1
            for (_, origin, dist_a), (_, destination, dist_b) in zip(run, run[1:]):
                if origin == destination:
                    stats["skipped_self_loop"] += 1
                    continue

                key = (origin, destination) if origin < destination else (destination, origin)
                section = sections.setdefault(key, IslSection(code_a=key[0], code_b=key[1]))
                section.traversals += 1
                stats["pairs_accepted"] += 1

                if dist_a is not None and dist_b is not None:
                    delta = round(abs(dist_b - dist_a), 3)
                    # A zero delta means the source repeats the cumulative
                    # figure rather than that two stations share a location.
                    if delta > 0:
                        distances[key].add(delta)

    for key, observed in distances.items():
        if len(observed) == 1:
            sections[key].distance_km = observed.pop()

    return sections, stats


def _clean(value: object) -> str:
    return str(value).strip().upper() if value is not None else ""


def _as_int(value: object) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return -1


def _as_float(value: object) -> float | None:
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None

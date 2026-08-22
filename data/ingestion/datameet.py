"""Parse the datameet/railways datasets into stations and corridor sections.

Implements PRD Section 5.1: station list from `stations.json`, and corridor
sections derived as **consecutive station pairs along real train routes** taken
from `schedules.json`. Corridor sections are not a field in the source data -
they are derived, and the derivation rules below are the whole substance of
this module.

Pure parsing only: no network access, no synthetic values. Every field emitted
either came from the downloaded file or is an explicitly-labelled derivation.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator

EARTH_RADIUS_KM = 6371.0088


@dataclass(frozen=True)
class Station:
    """One station, exactly as published in stations.json."""

    code: str
    name: str
    zone: str | None
    state: str | None
    address: str | None
    lat: float | None
    lon: float | None

    def as_dict(self) -> dict:
        return {
            "code": self.code,
            "name": self.name,
            "zone": self.zone,
            "state": self.state,
            "address": self.address,
            "lat": self.lat,
            "lon": self.lon,
        }


@dataclass
class CorridorSection:
    """An undirected section between two adjacent stations.

    A physical stretch of track between two stations is the same asset in both
    directions, so sections are keyed on the sorted station-code pair. The
    per-direction traversal counts are kept separately because they are real
    observations and are useful later for train-impact scoring (PRD 9.6).
    """

    code_a: str
    code_b: str
    directional_traversals: dict[str, int] = field(default_factory=dict)
    train_numbers: set[str] = field(default_factory=set)

    @property
    def section_id(self) -> str:
        return f"{self.code_a}-{self.code_b}"

    @property
    def total_traversals(self) -> int:
        return sum(self.directional_traversals.values())


def load_stations(path: Path) -> dict[str, Station]:
    """Read stations.json (a GeoJSON FeatureCollection) into a code -> Station map.

    Station codes are upper-cased and stripped, because the schedules file pads
    some codes with trailing spaces; without normalising, the join between the
    two files silently loses rows.
    """
    payload = json.loads(path.read_text())
    features = payload.get("features")
    if not features:
        raise ValueError(f"{path} has no GeoJSON features - is the download complete?")

    stations: dict[str, Station] = {}
    for feature in features:
        properties = feature.get("properties") or {}
        code = _clean(properties.get("code"))
        if not code:
            continue

        coordinates = ((feature.get("geometry") or {}).get("coordinates")) or []
        # GeoJSON is [longitude, latitude] - the reverse of the usual spoken order.
        lon, lat = (coordinates + [None, None])[:2] if len(coordinates) >= 2 else (None, None)

        stations[code] = Station(
            code=code,
            name=(properties.get("name") or "").strip() or code,
            zone=_clean(properties.get("zone")) or None,
            state=(properties.get("state") or "").strip() or None,
            address=(properties.get("address") or "").strip() or None,
            lat=_as_float(lat),
            lon=_as_float(lon),
        )

    return stations


def load_schedule_records(path: Path) -> list[dict]:
    """Read schedules.json - a flat array of train-stop-at-station records."""
    records = json.loads(path.read_text())
    if not isinstance(records, list) or not records:
        raise ValueError(f"{path} did not contain a non-empty array of stop records")
    return records


def split_train_runs(records: Iterable[dict]) -> Iterator[tuple[str, list[dict]]]:
    """Group stop records into ordered runs, yielding (train_number, stops).

    Two properties of the source data drive this, both verified against the
    downloaded file rather than assumed:

    1. **Records are not grouped by train.** They are interleaved throughout the
       array, so grouping by ``train_number`` has to happen before anything else.

    2. **``id`` is the stop sequence.** Within a train, ids run consecutively in
       travel order (5022 of 5208 trains form a single unbroken id block). There
       is no explicit stop-number field, so id order is the ordering signal.

    Runs are split wherever ids are **not** consecutive, for two reasons:

    * Some train numbers carry a full duplicate copy of their stop list under a
      separate id block (e.g. 04857 appears twice, ids 11615-11621 and
      11813-11819). Chaining straight through would invent a corridor between
      the last stop of one copy and the first stop of the next - a section that
      does not physically exist.
    * A smaller gap means an intermediate stop is missing from the dataset, so
      the stations either side of it are *not* adjacent and must not be joined.

    Splitting is the conservative choice in both cases: it can only omit a real
    section, never fabricate one that isn't there.
    """
    by_train: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        number = _clean(record.get("train_number"))
        if number:
            by_train[number].append(record)

    for train_number in sorted(by_train):
        stops = sorted(by_train[train_number], key=lambda r: _as_int(r.get("id")))

        run: list[dict] = [stops[0]]
        for previous, current in zip(stops, stops[1:]):
            if _as_int(current.get("id")) - _as_int(previous.get("id")) == 1:
                run.append(current)
            else:
                yield train_number, run
                run = [current]
        yield train_number, run


def derive_corridor_sections(
    records: Iterable[dict],
    stations: dict[str, Station],
) -> tuple[dict[tuple[str, str], CorridorSection], dict[str, int]]:
    """Derive corridor sections from consecutive station pairs on real routes.

    Implements PRD 5.1's definition: *"Corridor section = any two consecutive
    stations on a real route - extracted programmatically."*

    Returns the sections plus a stats dict recording what was skipped and why,
    so the ingestion report can state coverage honestly instead of quietly
    dropping rows.
    """
    sections: dict[tuple[str, str], CorridorSection] = {}
    stats = {
        "runs": 0,
        "stop_pairs_seen": 0,
        "skipped_self_loop": 0,
        "skipped_unknown_station": 0,
        "pairs_accepted": 0,
    }

    for train_number, run in split_train_runs(records):
        stats["runs"] += 1
        codes = [_clean(stop.get("station_code")) for stop in run]

        for origin, destination in zip(codes, codes[1:]):
            stats["stop_pairs_seen"] += 1

            # A stop repeated back-to-back is a data artefact, not a section.
            if origin == destination:
                stats["skipped_self_loop"] += 1
                continue

            # Never emit a section for a station we cannot describe - a corridor
            # with an unresolvable endpoint is not usable downstream.
            if origin not in stations or destination not in stations:
                stats["skipped_unknown_station"] += 1
                continue

            key = (origin, destination) if origin < destination else (destination, origin)
            section = sections.get(key)
            if section is None:
                section = CorridorSection(code_a=key[0], code_b=key[1])
                sections[key] = section

            direction = f"{origin}->{destination}"
            section.directional_traversals[direction] = (
                section.directional_traversals.get(direction, 0) + 1
            )
            section.train_numbers.add(train_number)
            stats["pairs_accepted"] += 1

    return sections, stats


def great_circle_km(a: Station, b: Station) -> float | None:
    """Straight-line distance between two stations, or None if either lacks coordinates.

    This is **not** track length - it is a derived lower bound, used only where
    the ISL timetable does not supply a real inter-station distance. Callers
    must keep it in a separate field so the two are never confused.
    """
    if None in (a.lat, a.lon, b.lat, b.lon):
        return None

    lat1, lon1, lat2, lon2 = map(math.radians, (a.lat, a.lon, b.lat, b.lon))
    dlat, dlon = lat2 - lat1, lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return round(2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h)), 3)


def _clean(value: object) -> str:
    """Normalise a code/identifier: strip padding, upper-case. Never returns None."""
    return str(value).strip().upper() if value is not None else ""


def _as_int(value: object) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


def _as_float(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

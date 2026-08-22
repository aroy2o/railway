"""Parse trains.json into per-train metadata.

Downloaded in T2, unused until now. Its value is the ``type`` field - the real
Indian Railways train-class code (Raj, Shtb, Drnt, Mail, SF, Exp, Pass, MEMU …) -
which is what makes train-impact scoring (PRD 9.6) reflect the actual mix of
traffic on a corridor instead of treating every train alike.

**No priority score is computed here, deliberately.** Turning a class code into
a weight is a policy decision belonging to the optimizer's objective function
(task T22). This module only surfaces what the file genuinely contains, so that
decision is made once, in the place that owns it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

#: Accommodation-class booleans as published. Useful to T22 as a secondary
#: signal: a train offering first AC / 2A is a premium service regardless of
#: how its `type` code is spelled.
CLASS_FLAGS = (
    "first_ac",
    "second_ac",
    "third_ac",
    "sleeper",
    "chair_car",
    "first_class",
)


@dataclass(frozen=True)
class Train:
    """One train, exactly as published in trains.json."""

    number: str
    name: str
    #: Real IR class code. Left verbatim - never mapped to a priority here.
    type: str | None
    zone: str | None
    from_station_code: str | None
    to_station_code: str | None
    departure: str | None
    arrival: str | None
    duration_minutes: int | None
    distance_km: float | None
    return_train: str | None
    classes: dict[str, bool] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "number": self.number,
            "name": self.name,
            "type": self.type,
            "zone": self.zone,
            "fromStationCode": self.from_station_code,
            "toStationCode": self.to_station_code,
            "departure": self.departure,
            "arrival": self.arrival,
            "durationMinutes": self.duration_minutes,
            "distanceKm": self.distance_km,
            "returnTrain": self.return_train,
            "classes": self.classes,
        }


def load_trains(path: Path) -> dict[str, Train]:
    """Read trains.json (a GeoJSON FeatureCollection) into number -> Train.

    The LineString geometry is ignored: it is the drawn route shape, and the
    authoritative stop sequence already comes from schedules.json (T2, D-006).
    """
    payload = json.loads(path.read_text())
    features = payload.get("features")
    if not features:
        raise ValueError(f"{path} has no GeoJSON features - is the download complete?")

    trains: dict[str, Train] = {}
    for feature in features:
        properties = feature.get("properties") or {}
        number = str(properties.get("number") or "").strip()
        if not number:
            continue

        trains[number] = Train(
            number=number,
            name=(properties.get("name") or "").strip(),
            type=_clean(properties.get("type")),
            zone=_clean(properties.get("zone")),
            from_station_code=_upper(properties.get("from_station_code")),
            to_station_code=_upper(properties.get("to_station_code")),
            departure=_clean(properties.get("departure")),
            arrival=_clean(properties.get("arrival")),
            duration_minutes=_duration_minutes(properties),
            distance_km=_as_float(properties.get("distance")),
            return_train=_clean(properties.get("return_train")),
            classes={flag: bool(properties.get(flag)) for flag in CLASS_FLAGS},
        )

    return trains


def _duration_minutes(properties: dict) -> int | None:
    """Combine the published duration_h / duration_m pair into one figure."""
    hours = _as_int(properties.get("duration_h"))
    minutes = _as_int(properties.get("duration_m"))
    if hours is None and minutes is None:
        return None
    return (hours or 0) * 60 + (minutes or 0)


def _clean(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _upper(value: object) -> str | None:
    text = _clean(value)
    return text.upper() if text else None


def _as_int(value: object) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: object) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None

"""Build the per-corridor occupancy calendar from real arrival/departure times.

Implements task T3 / PRD FR1.2. Turns the 417,080 stop records in
`schedules.json` into, for each corridor section, the clock windows when
scheduled train traffic occupies it - and the complement of those, which is what
the CP-SAT solver actually needs to place a maintenance block.

WHAT IS DATA AND WHAT IS A MODELLING CHOICE
-------------------------------------------
Data: the departure time at one station and the arrival time at the next, for
every train run, exactly as published.

Modelling choices (all flagged inline, and configurable at the top of this
module rather than buried in the logic):

1. **Occupancy = transit window.** A train occupies the section between two
   stations from the moment it departs the first to the moment it arrives at
   the second. Real signalling occupies a *block*, which is not the same thing
   as a station-to-station section, and the published data has no block
   granularity - so this is the closest defensible approximation, not a fact.

2. **One representative 24-hour day.** The source has no day-of-week or
   running-days field, so every train is treated as if it runs daily. This
   deliberately *over*-estimates occupancy, since weekly trains are counted as
   daily. For maintenance planning, erring towards less free time is the safe
   direction.

3. **A clearance margin around each occupancy.** Maintenance cannot begin the
   instant a train clears. The margin is a policy input, not a measurement.

4. **A minimum usable block length.** A three-minute gap between trains is not
   a maintenance opportunity. Free windows shorter than the threshold are not
   reported as block windows.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Iterator, Sequence

from ingestion import datameet

MINUTES_PER_DAY = 24 * 60

#: Beyond this, a "transit" between two adjacent stations is not credible and
#: is treated as a data error rather than an occupancy window. Chosen from the
#: measured distribution: median 7 min, p95 18 min, p99 32 min - so 180 minutes
#: keeps 99.92% of observed transits while discarding the impossible tail
#: (day-delta arithmetic alone produces durations over 24 hours).
MAX_PLAUSIBLE_TRANSIT_MIN = 180

#: Times are published to the minute, and some very short sections yield a
#: zero-minute transit through rounding. A zero-length window is meaningless to
#: the solver, so occupancy is floored at one minute.
MIN_OCCUPANCY_MIN = 1

#: MODELLING CHOICE - safety buffer applied either side of every occupancy
#: before computing free windows. Not measured; a planning policy input.
DEFAULT_CLEARANCE_MARGIN_MIN = 5

#: MODELLING CHOICE - shortest free window worth reporting as a block window.
#: PRD 5.2 puts the shortest department task at 60 minutes (S&T), so a 30-minute
#: floor keeps genuinely marginal windows visible without reporting slivers.
DEFAULT_MIN_BLOCK_WINDOW_MIN = 30


@dataclass(frozen=True)
class Window:
    """A half-open clock interval [start, end) in minutes from midnight."""

    start: int
    end: int

    @property
    def duration(self) -> int:
        return self.end - self.start

    def as_dict(self) -> dict:
        return {
            "start": to_clock(self.start),
            "end": to_clock(self.end),
            "startMin": self.start,
            "endMin": self.end,
            "durationMin": self.duration,
        }


def parse_clock_minutes(value: object) -> int | None:
    """Parse 'HH:MM:SS' into minutes past midnight.

    The source writes a missing time as the string ``"None"`` rather than JSON
    null, so that is treated as absent - not as a parse failure to shout about.
    """
    if value is None:
        return None
    text = str(value).strip().strip("'")
    if text in ("", "None", "null", "NULL"):
        return None
    parts = text.split(":")
    try:
        hours, minutes = int(parts[0]), int(parts[1])
    except (IndexError, ValueError):
        return None
    if not (0 <= hours <= 23 and 0 <= minutes <= 59):
        return None
    return hours * 60 + minutes


def to_clock(minutes: int) -> str:
    """Render minutes-past-midnight as HH:MM (24:00 stays 24:00, not 00:00)."""
    minutes = max(0, min(MINUTES_PER_DAY, minutes))
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def transit_duration(
    departure_min: int,
    arrival_min: int,
    day_from: object = None,
    day_to: object = None,
) -> tuple[int | None, str]:
    """Minutes a train spends between two consecutive stops.

    Returns ``(duration, method)``; duration is None when no plausible value can
    be derived, so the caller drops the window rather than inventing one.

    **Clock-wrap is preferred over the published ``day`` field.** Measured on
    all 376,704 usable stop pairs, the two agree on 99.86% of them - but
    day-delta arithmetic yields 308 negative durations and 196 longer than 24
    hours, both physically impossible between adjacent stations, while
    clock-wrap yields neither. ``day`` is therefore used only as a fallback
    check when the wrapped value is implausibly long.
    """
    wrapped = arrival_min - departure_min
    if wrapped < 0:
        # Crossed midnight: 23:50 -> 00:10 is 20 minutes, not -1420.
        wrapped += MINUTES_PER_DAY

    if wrapped <= MAX_PLAUSIBLE_TRANSIT_MIN:
        return max(wrapped, MIN_OCCUPANCY_MIN), "clock-wrap"

    # Implausibly long. If the day fields imply a shorter same-day hop, trust
    # that instead - this rescues a handful of records where the wrap guessed
    # a midnight crossing that did not happen.
    if isinstance(day_from, int) and isinstance(day_to, int):
        by_day = (day_to - day_from) * MINUTES_PER_DAY + (arrival_min - departure_min)
        if 0 <= by_day <= MAX_PLAUSIBLE_TRANSIT_MIN:
            return max(by_day, MIN_OCCUPANCY_MIN), "day-delta"

    return None, "implausible"


def split_at_midnight(start: int, duration: int) -> list[Window]:
    """Clip an occupancy onto a single 24-hour clock, splitting if it wraps.

    A train departing 23:50 and arriving 00:10 occupies [23:50, 24:00) and
    [00:00, 00:10) of the representative day - two windows, not one invalid
    interval running backwards.
    """
    start %= MINUTES_PER_DAY
    end = start + duration

    if end <= MINUTES_PER_DAY:
        return [Window(start, end)]

    return [
        Window(start, MINUTES_PER_DAY),
        Window(0, min(end - MINUTES_PER_DAY, MINUTES_PER_DAY)),
    ]


def merge_windows(windows: Iterable[Window]) -> list[Window]:
    """Collapse overlapping/touching windows into a minimal disjoint set."""
    ordered = sorted(windows, key=lambda w: (w.start, w.end))
    if not ordered:
        return []

    merged = [ordered[0]]
    for window in ordered[1:]:
        last = merged[-1]
        if window.start <= last.end:  # touching counts as contiguous
            if window.end > last.end:
                merged[-1] = Window(last.start, window.end)
        else:
            merged.append(window)
    return merged


def free_windows(
    occupied: Sequence[Window],
    *,
    clearance_margin_min: int = DEFAULT_CLEARANCE_MARGIN_MIN,
    min_block_window_min: int = DEFAULT_MIN_BLOCK_WINDOW_MIN,
) -> list[Window]:
    """Complement of the occupancy across one 24-hour day.

    This is what PRD Section 15 calls ``maxDailyBlockWindows`` and what the
    CP-SAT model (PRD Section 13) places tasks into. Each occupancy is widened
    by the clearance margin first, then the gaps between them are returned -
    keeping only those long enough to be a real maintenance opportunity.
    """
    padded = merge_windows(
        Window(
            max(0, w.start - clearance_margin_min),
            min(MINUTES_PER_DAY, w.end + clearance_margin_min),
        )
        for w in occupied
    )

    gaps: list[Window] = []
    cursor = 0
    for window in padded:
        if window.start - cursor >= min_block_window_min:
            gaps.append(Window(cursor, window.start))
        cursor = max(cursor, window.end)

    if MINUTES_PER_DAY - cursor >= min_block_window_min:
        gaps.append(Window(cursor, MINUTES_PER_DAY))

    return gaps


def iter_section_transits(
    records: Iterable[dict],
    known_sections: set[tuple[str, str]] | None = None,
    stats: dict[str, int] | None = None,
) -> Iterator[tuple[tuple[str, str], str, Window, str]]:
    """Yield ``(section_key, train_number, window, method)`` for every transit.

    Run splitting is delegated to :func:`datameet.split_train_runs`, so the
    duplicate-stop-list and missing-stop rules established in T2 apply here
    unchanged - a phantom adjacency must not become a phantom occupancy.

    ``stats``, if given, is populated with a full account of every stop pair
    considered and why it was or was not turned into a window. Nothing is
    dropped silently: ``pairs_seen`` always equals the sum of the skip counters
    plus ``pairs_used``.
    """
    counters = stats if stats is not None else {}
    for name in (
        "pairs_seen",
        "pairs_used",
        "skipped_self_loop",
        "skipped_unknown_section",
        "skipped_missing_time",
        "skipped_implausible_transit",
        "windows_emitted",
        "midnight_splits",
    ):
        counters.setdefault(name, 0)

    for train_number, run in datameet.split_train_runs(records):
        for first, second in zip(run, run[1:]):
            counters["pairs_seen"] += 1

            origin = _code(first)
            destination = _code(second)
            if not origin or not destination or origin == destination:
                counters["skipped_self_loop"] += 1
                continue

            key = (origin, destination) if origin < destination else (destination, origin)
            if known_sections is not None and key not in known_sections:
                counters["skipped_unknown_section"] += 1
                continue

            departure = parse_clock_minutes(first.get("departure"))
            arrival = parse_clock_minutes(second.get("arrival"))
            if departure is None or arrival is None:
                # 5.4% of stop records carry no time at all (and no `day`
                # either - they are the same records). They define route order
                # for T2 but cannot define occupancy, so they are skipped here -
                # counted, never hidden.
                counters["skipped_missing_time"] += 1
                continue

            duration, method = transit_duration(
                departure, arrival, first.get("day"), second.get("day")
            )
            if duration is None:
                counters["skipped_implausible_transit"] += 1
                continue

            counters["pairs_used"] += 1
            windows = split_at_midnight(departure, duration)
            counters["windows_emitted"] += len(windows)
            if len(windows) > 1:
                counters["midnight_splits"] += 1

            for window in windows:
                yield key, train_number, window, method


def _code(record: dict) -> str:
    return str(record.get("station_code") or "").strip().upper()

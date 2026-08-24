"""Tests for T26 - corridor seasonal-risk classification (PRD 9.9).

Two-part split, same as T2/T3's own suites:

* **Logic tests** drive `classify()` from hand-built state lists, so the
  three-way honesty split (flagged / checked-and-clear / genuinely unknown)
  is pinned without touching the real 10,149-corridor file.
* **Real-data tests** check the built `corridor_seasonal_risk.json` against
  facts already established about this project's real 26-corridor operative
  corpus (T4) - specifically, that DGU-PNB (Assam) and HGJ-SUNM (Uttar
  Pradesh) are the two real corridors this feature can honestly say anything
  about, because the Ministry of Jal Shakti's list names their real states.

Real-data tests skip when corridors.json has not been built yet, so a fresh
clone still gets a green logic suite.
"""

from __future__ import annotations

import json

import pytest

from ingestion.build_corridors import CORRIDORS_OUT
from ingestion.build_seasonal_risk import (
    HIGH_FLOOD_RISK_STATES,
    RISK_OUT,
    build,
    classify,
)

corridors_required = pytest.mark.skipif(
    not CORRIDORS_OUT.exists(),
    reason="corridors.json not built; run: python -m ingestion.build_corridors",
)


# --------------------------------------------------------------------------- #
# classify() - the honesty split, hand-built                                   #
# --------------------------------------------------------------------------- #

def test_a_named_high_flood_risk_state_is_flagged():
    flag, reason = classify(["Assam"])
    assert flag == "monsoon-risk"
    assert "Assam" in reason


def test_a_known_state_not_on_the_list_is_checked_and_clear():
    flag, reason = classify(["Rajasthan"])
    assert flag == "none"
    assert "Rajasthan" in reason


def test_no_state_metadata_stays_genuinely_unknown_not_guessed_safe():
    """The honesty case this whole module exists for: an empty `states` list
    must never default to `"none"` - that would claim a check that never
    happened."""
    flag, reason = classify([])
    assert flag is None
    assert "no state metadata" in reason


def test_either_endpoint_being_flagged_is_enough():
    """A corridor straddling a flagged and an unflagged state is still
    flagged - the risk is real if either end sits in it."""
    flag, _ = classify(["Madhya Pradesh", "Bihar"])
    assert flag == "monsoon-risk"


def test_flood_prone_is_never_the_output():
    """This module has no section-specific data (only state-level), so the
    third PRD enum value must never come out of `classify` - only "T26 audit
    or a real section-level source would earn that, and neither exists here.
    """
    for states in ([], ["Assam"], ["Rajasthan"], ["Bihar", "Odisha"]):
        flag, _ = classify(states)
        assert flag != "flood-prone"


def test_the_high_risk_state_list_is_exactly_five_named_states():
    """Pinned so an edit to the list is a deliberate, reviewed change, not a
    silent typo - each of these five is independently named by the Ministry
    of Jal Shakti's own estimate as "largely affected"."""
    assert HIGH_FLOOD_RISK_STATES == frozenset(
        {"Assam", "Bihar", "Odisha", "Uttar Pradesh", "West Bengal"}
    )


# --------------------------------------------------------------------------- #
# Real data                                                                    #
# --------------------------------------------------------------------------- #

@corridors_required
def test_the_real_corpus_reproduces_byte_identically():
    """Same discipline as T2/T3: identical input, identical output."""
    first = build()
    second = build()
    assert first == second


@corridors_required
def test_the_two_real_operative_corridors_this_feature_can_speak_to():
    """DGU-PNB (Assam) and HGJ-SUNM (Uttar Pradesh) are the only two of the
    26 real corridors T4 generates demand for whose real station data
    carries a state at all AND that state is on the Jal Shakti list - a
    finding pinned here, not assumed, because it is the entire reason this
    feature is honestly small rather than a flag on every corridor."""
    result = build()
    by_id = {e["_id"]: e for e in result["entries"]}

    assert by_id["DGU-PNB"]["seasonalRiskFlag"] == "monsoon-risk"
    assert by_id["HGJ-SUNM"]["seasonalRiskFlag"] == "monsoon-risk"

    # And the real corridors known NOT to be flagged, for the same real
    # reason (a known state absent from the list) - not coincidentally None.
    for corridor_id, state in [
        ("BSR-JCNR", "Maharashtra"),
        ("JSH-SUJH", "Rajasthan"),
        ("KCI-VLD", "Andhra Pradesh"),
    ]:
        assert by_id[corridor_id]["seasonalRiskFlag"] == "none", corridor_id
        assert state in by_id[corridor_id]["reason"]


@corridors_required
def test_every_corridor_in_the_output_matches_a_real_corridor_id():
    """No corridor id in the risk file that corridors.json does not also
    have - this module reads T2's output, it does not invent identities."""
    real_ids = {c["_id"] for c in json.loads(CORRIDORS_OUT.read_text())["corridors"]}
    result = build()
    assert {e["_id"] for e in result["entries"]} <= real_ids
    assert {e["_id"] for e in result["entries"]} == real_ids


@corridors_required
def test_flood_prone_never_appears_in_the_real_output():
    result = build()
    flags = {e["seasonalRiskFlag"] for e in result["entries"]}
    assert "flood-prone" not in flags


@corridors_required
def test_written_output_matches_what_build_computed():
    """`main()`'s `_write` step must not silently transform anything between
    `build()`'s result and the file on disk."""
    from ingestion.build_seasonal_risk import _write

    result = build()
    _write(result)
    written = json.loads(RISK_OUT.read_text())

    assert written["count"] == len(result["entries"])
    assert written["corridorSeasonalRisk"] == result["entries"]
    assert "disclaimer" in written and "source" in written

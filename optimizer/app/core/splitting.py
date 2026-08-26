"""Task-splitting eligibility rule and the minimum segment floor (T29 Phase 1).

WHAT THIS MODULE DECIDES
-------------------------
PRD 13/FR3 always assumed one task -> one continuous window. T29 Phase 1 lifts
that for tasks whose real-world work genuinely tolerates being paused and
resumed across separate possessions - so a task longer than any single free
window its corridor offers is no longer automatically deferred
(EXCEEDS_LONGEST_WINDOW); it can instead be covered by several non-contiguous
segments that sum to its full `estBlockDurationMins`.

Not every defect type can honestly do that. THIS IS A JUDGEMENT CALL, NOT A
FACT the data settles - there is no PRD section and no real dataset describing
splittability; this is new domain modelling, stated as such rather than
dressed up as derived. Flagged back to the project owner alongside the real
corpus numbers this rule produces, per this task's own brief: a rule this
load-bearing should be inspectable and challengeable, not buried in a boolean.

WHY KEYED ON `defectType`, NOT `department` OR `requiredResourceIds`
----------------------------------------------------------------------
`department` is too coarse - every department (Engineering/S&T/TRD) has both
splittable and non-splittable work, so a department-level rule would either
over- or under-grant splitting for half of it. Resource *type*
(crew/machine/permission - the natural other candidate, since "needs a power
isolation permission" is exactly the kind of fact that should make work
non-splittable) never survives the Node -> optimizer wire contract today:
only opaque resource-id strings cross that boundary, not their type, and
resolving that would need a fresh join Node does not currently do. `defectType`
(PRD 5.2's own real-terminology vocabulary,
`data/generators/config.py::DEFECT_TYPES`) is the only granular, already-real
per-task signal available without inventing a new join - so this rule is
keyed on it, with the permission/resource reasoning folded into the WHY for
each defect type below rather than coded as a literal resource check.

THE RULE, AND THE REASONING BEHIND EACH SIDE
----------------------------------------------
SPLITTABLE - the work is inherently done in discrete, safe-to-pause passes:

* Engineering "track geometry defect" - tamping/lining a chainage is already
  real-world multi-night work; a P.Way gang packs what it can into one
  possession and returns for the rest under the same Traffic Block
  permission, leaving the track in a safe running state between sessions.
* Engineering "ballast deficiency"    - ballast packing/renewal is
  segment-by-segment by nature.
* Engineering "joint wear"            - joint maintenance is done
  joint-by-joint; a partially-completed pass leaves the track safe.
* S&T "cable fault"                   - fault location and cable
  repair/splicing are naturally two-stage, and a spliced-but-not-yet-tested
  cable can be safely left isolated between sessions.
* TRD "OHE snag"                      - general stringing/tensioning
  rectification is commonly phased across multiple Power Block sessions.
* TRD "insulator damage"              - insulators are swapped
  string-by-string/structure-by-structure; each swap leaves the OHE safe.

NOT SPLITTABLE - the work cannot be left in an intermediate state and handed
back to traffic; it must close out in the one possession it starts in:

* Engineering "rail fracture"  - an active safety defect; once
  clamping/welding begins it must reach a safe, closed-out state before the
  block ends and traffic resumes. Leaving a rail mid-repair is not a state
  the line can safely reopen into.
* S&T "relay fault"            - once a relay is pulled from an interlocking
  circuit, the interlocking cannot be returned to service partially
  modified; swap-and-test must complete in one possession.
* S&T "point failure"          - a switch mechanism cannot be left partially
  adjusted and released back into service.
* S&T "interlocking snag"      - same reasoning as relay/point: an
  interlocking cannot go back into traffic mid-reconfiguration.
* TRD "isolator fault"         - the isolator is opened up under Power
  Isolation; it cannot be left indeterminate and re-energised.
* TRD "feeder fault"           - the feeder is physically opened under Power
  Block/Power Isolation; re-energising a half-repaired feeder is not safe,
  so it must close out in one continuous session.

An unrecognised `defectType` (anything outside PRD 5.2's twelve real values)
defaults to NOT splittable - the conservative direction, since wrongly
allowing a split is a safety-shaped mistake and wrongly forbidding one only
costs an opportunity, not a hazard.
"""

from __future__ import annotations

#: Below this, a "segment" is mostly setup/teardown overhead (staging
#: equipment, establishing the lookout/protection arrangement, positioning a
#: machine) rather than real work - not realistic maintenance. Set equal to
#: T3's own free-window floor (D-010: "keeping only gaps of 30 minutes or
#: more") rather than inventing a second number: every window this model
#: ever sees already clears that bar, so a segment floor below it would be
#: meaningless (no window could violate it) and a floor above it would need
#: its own fresh justification. 30 minutes is the justification already made
#: once, reused rather than duplicated.
MIN_SPLIT_SEGMENT_MINUTES = 30

SPLITTABLE_DEFECT_TYPES: frozenset[str] = frozenset(
    {
        "track geometry defect",
        "ballast deficiency",
        "joint wear",
        "cable fault",
        "OHE snag",
        "insulator damage",
    }
)

#: PRD 5.2's full real defect-type vocabulary (`data/generators/config.py`'s
#: `DEFECT_TYPES`), for the coverage assertion below only - not itself
#: consulted at runtime.
_ALL_KNOWN_DEFECT_TYPES: frozenset[str] = frozenset(
    {
        "rail fracture",
        "ballast deficiency",
        "joint wear",
        "track geometry defect",
        "relay fault",
        "cable fault",
        "point failure",
        "interlocking snag",
        "OHE snag",
        "isolator fault",
        "feeder fault",
        "insulator damage",
    }
)

assert SPLITTABLE_DEFECT_TYPES <= _ALL_KNOWN_DEFECT_TYPES, (
    "SPLITTABLE_DEFECT_TYPES contains a value outside PRD 5.2's defect vocabulary"
)


def is_splittable_defect(defect_type: str) -> bool:
    """True if PRD 5.2 work of this defect type may be split across 2+
    non-contiguous windows. See the module docstring for the reasoning
    behind every value, splittable or not - a documented judgement call,
    not a derived fact. An unrecognised value is NOT splittable (the
    conservative default).
    """
    return defect_type in SPLITTABLE_DEFECT_TYPES

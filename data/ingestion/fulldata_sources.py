"""Path constants for the fulldata-ktv-psa branch's ingestion pipeline.

Mirrors the role `ingestion.sources` plays for the datameet/data.gov.in
pipeline, but points at the `full_data/` release package instead - a
standalone, independently-built pipeline covering exactly one real corridor
(KTV-PSA) with real infrastructure/freight/passenger data and a calibrated
LightGBM risk model. See docs/DECISIONS.md and the branch plan for why this
exists as a *separate* pipeline alongside the original one rather than a
replacement of it.

PROVENANCE NOTE: full_data's raw files (`KTV-PSA-Infra.xlsx`, division code
`WAT`, etc.) read as a real railway division's internal operational export,
not a published open dataset like datameet/railways or data.gov.in. This is a
deliberate, flagged deviation from PRD Section 5.1's named sources - fine for
local experimentation, but confirm there is no sharing restriction on this
data before this branch is ever deployed somewhere public.
"""

from __future__ import annotations

from pathlib import Path

DATA_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = DATA_ROOT.parent
FULLDATA_ROOT = REPO_ROOT / "full_data"

FULLDATA_REAL_DIR = FULLDATA_ROOT / "data" / "real"
FULLDATA_SYNTHETIC_DIR = FULLDATA_ROOT / "data" / "synthetic"
FULLDATA_PROCESSED_DIR = FULLDATA_ROOT / "data" / "processed"

ROUTE_KTV_PSA_CSV = FULLDATA_REAL_DIR / "route_ktv_psa.csv"
ROUTE_PSA_KTV_CSV = FULLDATA_REAL_DIR / "route_psa_ktv.csv"
STATIONS_CSV = FULLDATA_REAL_DIR / "stations.csv"
BLOCK_SECTIONS_CSV = FULLDATA_REAL_DIR / "block_sections.csv"
TRAFFIC_PROFILES_CSV = FULLDATA_PROCESSED_DIR / "traffic_profiles.csv"

ASSET_DAYS_CSV = FULLDATA_SYNTHETIC_DIR / "asset_days.csv"
CP_SAT_TASKS_CSV = FULLDATA_PROCESSED_DIR / "cp_sat_tasks_v2.csv"

PROCESSED_DIR = DATA_ROOT / "processed"

SOURCE_CITATION = (
    "full_data/release package (KTV-PSA corridor): real_data/route_ktv_psa.csv, "
    "stations.csv, block_sections.csv; processed/traffic_profiles.csv "
    "(freight+passenger, aggregated); synthetic/asset_days.csv and "
    "processed/cp_sat_tasks_v2.csv (DGP-simulated maintenance layer, "
    "gate-validated: see full_data/release/MANIFEST.md). NOT PRD Section 5.1's "
    "named sources (datameet/railways, data.gov.in) - single-corridor scope, "
    "deliberately accepted deviation for this experimental branch."
)

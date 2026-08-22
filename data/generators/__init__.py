"""Synthetic maintenance data generation (PRD Section 5.2).

EVERYTHING THIS PACKAGE PRODUCES IS SIMULATED. Indian Railways' maintenance,
defect, asset-health and resource data is internal to the organisation and not
publicly available, so it is generated here - anchored to the real corridors and
occupancy calendar built by `data/ingestion`, never invented independently of
them.

The real/synthetic split is the point of the folder separation:
  data/ingestion  -> real, published data (stations, corridors, timetable)
  data/generators -> simulated data (assets, tasks, resources, dependencies)

Every generated record carries `"synthetic": true`, and every output file
carries a disclaimer plus a field-level provenance map, so nothing downstream
can mistake a simulated value for a measured one.
"""

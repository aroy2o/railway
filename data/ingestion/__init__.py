"""Ingestion of real, published railway data (PRD Section 5.1).

Everything in this package reads data that was actually downloaded from a
public source. Nothing here generates, approximates or fills in railway facts -
synthetic data is the separate concern of `data/generators` (PRD 5.2).

Pipeline:
    download.py         fetch raw sources into data/raw/ + write a manifest
    datameet.py         parse datameet/railways: stations, train runs, corridors
    datagov_isl.py      parse the data.gov.in ISL timetable CSV (cross-check)
    build_corridors.py  CLI that writes data/processed/*.json
"""

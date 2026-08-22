"""Download the real source datasets into data/raw/ and record provenance.

Raw files are written byte-for-byte as served and never edited - parsing happens
downstream. Every download is recorded in data/raw/MANIFEST.json with its URL,
size, SHA-256 and fetch time, so a later run can prove which bytes produced a
given processed output.

Usage:
    python -m ingestion.download            # skip files already present
    python -m ingestion.download --force    # re-download everything
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import requests

from ingestion.sources import ALL_SOURCES, RAW_DIR, Source

MANIFEST_PATH = RAW_DIR / "MANIFEST.json"
CHUNK_BYTES = 1 << 20
TIMEOUT_SECONDS = (30, 900)  # (connect, read) - schedules.json is ~82 MB


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(source: Source, *, force: bool = False) -> dict:
    """Fetch one source, returning its manifest entry.

    Raises on any HTTP failure rather than leaving a truncated or empty file in
    place - a half-written dataset that silently parses to fewer corridors is a
    far worse outcome than a loud failure.
    """
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    target = source.raw_path

    if target.exists() and not force:
        print(f"  [skip] {source.filename} already present ({target.stat().st_size:,} bytes)")
    else:
        print(f"  [get ] {source.url}")
        response = requests.get(source.url, stream=True, timeout=TIMEOUT_SECONDS)
        response.raise_for_status()

        # Write to a temporary file first so an interrupted download can never
        # be mistaken for a complete one on the next run.
        staging = target.with_suffix(target.suffix + ".part")
        written = 0
        with staging.open("wb") as handle:
            for chunk in response.iter_content(CHUNK_BYTES):
                handle.write(chunk)
                written += len(chunk)
        if written == 0:
            staging.unlink(missing_ok=True)
            raise RuntimeError(f"{source.url} returned an empty body")
        staging.replace(target)
        print(f"  [ ok ] {source.filename} ({written:,} bytes)")

    entry = {
        "key": source.key,
        "filename": source.filename,
        "url": source.url,
        "homepage": source.homepage,
        "licence": source.licence,
        "description": source.description,
        "bytes": target.stat().st_size,
        "sha256": sha256_of(target),
        "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    if source.extract_member:
        entry["extracted"] = _extract_member(target, source.extract_member)

    return entry


def _extract_member(archive_path: Path, member: str) -> dict:
    """Extract one named file from a downloaded zip, next to the archive."""
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if member not in names:
            raise RuntimeError(f"{archive_path.name} does not contain {member!r}; has {names}")
        archive.extract(member, RAW_DIR)

    extracted = RAW_DIR / member
    print(f"  [ ok ] extracted {member} ({extracted.stat().st_size:,} bytes)")
    return {
        "filename": member,
        "bytes": extracted.stat().st_size,
        "sha256": sha256_of(extracted),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--force", action="store_true", help="re-download even if present")
    args = parser.parse_args(argv)

    entries = []
    for source in ALL_SOURCES:
        print(f"{source.key}:")
        try:
            entries.append(download(source, force=args.force))
        except Exception as exc:  # noqa: BLE001 - report and keep going
            # One unreachable source must not hide the others' provenance. The
            # failure is recorded in the manifest rather than swallowed.
            print(f"  [FAIL] {type(exc).__name__}: {exc}", file=sys.stderr)
            entries.append(
                {
                    "key": source.key,
                    "filename": source.filename,
                    "url": source.url,
                    "error": f"{type(exc).__name__}: {exc}",
                    "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
            )

    MANIFEST_PATH.write_text(json.dumps({"sources": entries}, indent=2) + "\n")
    print(f"\nManifest written: {MANIFEST_PATH}")

    failed = [e for e in entries if "error" in e]
    if failed:
        print(f"{len(failed)} source(s) failed - see manifest.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

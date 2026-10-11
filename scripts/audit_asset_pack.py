"""Verify fingerprint coverage in a pinned asset APK, including SQLite assets.

Only hashes, counts, and diagnostics are written to the public-ready summary.
Optional decoded original data belongs in an ignored local research directory.
No inferred defaults, duplicate-table repairs, or gameplay approximations occur.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path, PurePosixPath
import sqlite3
import tomllib
import zipfile

from sc_lzma import decode, PROPERTIES

PINNED_SHA256 = "3e62afcf73786919be08b0a48f1744d82b618642fed8e8db7d1a76b5b2eb3fd3"


def digest_file(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def safe_relative(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or "\\" in name:
        raise ValueError("Unsafe asset path")
    return path


def audit(path, extract_data=None):
    actual = digest_file(path)
    if actual != PINNED_SHA256:
        raise ValueError("Asset APK does not match the pinned 160402020 input")
    summary = {
        "build_version_code": "160402020",
        "asset_split_sha256": actual,
        "asset_split_bytes": Path(path).stat().st_size,
        "scope": "Signed install-time asset fingerprint only; later downloaded updates are not inspected.",
    }
    with zipfile.ZipFile(path) as archive:
        fingerprint_bytes = archive.read("assets/fingerprint.json")
        fingerprint = json.loads(fingerprint_bytes)
        expected = {item["file"]: item["sha"] for item in fingerprint["files"]}
        if len(expected) != len(fingerprint["files"]):
            raise ValueError("Fingerprint repeats asset paths")
        available = {
            x.filename.removeprefix("assets/"): x
            for x in archive.infolist()
            if x.filename.startswith("assets/") and not x.is_dir()
        }
        matched_zip, mismatched_zip = set(), []
        for name in sorted(set(expected) & set(available)):
            if (
                hashlib.sha1(archive.read(available[name])).hexdigest()
                == expected[name]
            ):
                matched_zip.add(name)
            else:
                mismatched_zip.append(name)
        database = sqlite3.connect(":memory:")
        database.deserialize(archive.read("assets/assets.scdb"))
        database.execute("PRAGMA query_only=ON")
        matched_db, mismatched_db, database_paths = set(), [], set()
        # assetFilename is explicit provenance, not a guessed extension mapping.
        for name, data, fmt in database.execute(
            "SELECT meta.assetFilename, asset.data, asset.format "
            "FROM meta JOIN asset ON meta.path = asset.path"
        ):
            if name not in expected or name in available:
                continue
            database_paths.add(name)
            if data is not None and hashlib.sha1(data).hexdigest() == expected[name]:
                matched_db.add(name)
            else:
                mismatched_db.append(name)
        unresolved = sorted(set(expected) - matched_zip - matched_db)
        summary["fingerprint"] = {
            "version": fingerprint["version"],
            "sha": fingerprint["sha"],
            "file_sha256": hashlib.sha256(fingerprint_bytes).hexdigest(),
            "entries": len(expected),
            "matching_zip_entries": len(matched_zip),
            "matching_scdb_blobs": len(matched_db),
            "unresolved_count": len(unresolved),
            "zip_hash_mismatches": mismatched_zip,
            "scdb_hash_mismatches": mismatched_db,
            "unresolved_by_prefix": dict(Counter(x.split("/")[0] for x in unresolved)),
            "all_entries_hash_verified": not unresolved,
        }
        summary["scdb"] = {
            "bytes": len(archive.read("assets/assets.scdb")),
            "meta_rows": database.execute("SELECT COUNT(*) FROM meta").fetchone()[0],
            "asset_rows": database.execute("SELECT COUNT(*) FROM asset").fetchone()[0],
            "mapping": "meta.assetFilename -> fingerprint.file; meta.path = asset.path; SHA-1(asset.data)",
        }
        database.close()
        logic = {x for x in expected if x.startswith("csv_logic/")}
        summary["csv_logic"] = {
            "fingerprint_entries": len(logic),
            "matching_zip_entries": len(logic & matched_zip),
            "unresolved_count": len(logic - matched_zip - matched_db),
        }
        codecs, parsed_toml, decoded_count, parse_errors, decode_errors = (
            Counter(),
            0,
            0,
            [],
            [],
        )
        for name, entry in available.items():
            if not (
                name.startswith(("csv_logic/", "locations/", "tilemaps/", "level/"))
                or name in ("data_manifest.toml", "build.tag", ".assetdbhash")
            ):
                continue
            raw = archive.read(entry)
            try:
                compressed = raw.startswith(PROPERTIES)
                data = decode(raw) if compressed else raw
                codecs["supercell_lzma" if compressed else "unchanged"] += 1
                decoded_count += 1
                if extract_data:
                    target = Path(extract_data) / safe_relative(name)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                if name.endswith(".toml"):
                    try:
                        tomllib.loads(data.decode("utf-8-sig"))
                        parsed_toml += 1
                    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
                        parse_errors.append(
                            {"asset": name, "error": str(exc), "bytes_preserved": True}
                        )
            except Exception as exc:
                decode_errors.append({"asset": name, "error": str(exc)})
        summary["selected_decoding"] = {
            "files": decoded_count,
            "codecs": dict(codecs),
            "toml_parsed": parsed_toml,
            "parse_diagnostics": parse_errors,
            "decode_errors": decode_errors,
        }
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("asset_apk", type=Path)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument(
        "--extract-data",
        type=Path,
        help="Optional ignored local output directory for original data",
    )
    args = parser.parse_args()
    summary = audit(args.asset_apk, args.extract_data)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    if (
        not summary["fingerprint"]["all_entries_hash_verified"]
        or summary["selected_decoding"]["decode_errors"]
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    main()

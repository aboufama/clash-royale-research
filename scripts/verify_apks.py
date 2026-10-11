"""Verify the extracted APKs with Google's apksigner and the pinned certificate."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

REPO = Path(__file__).resolve().parents[1]


def signer_digests(output):
    pattern = r"^(?:V[\d.]+ )?Signer(?: #\d+)?:? certificate SHA-256 digest:\s*([0-9a-fA-F]{64})\s*$"
    return {
        digest.lower() for digest in re.findall(pattern, output, flags=re.MULTILINE)
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apksigner", type=Path, required=True)
    parser.add_argument(
        "--workspace", type=Path, default=REPO / "work/builds/160402020"
    )
    parser.add_argument(
        "--record", type=Path, default=REPO / "research/builds/160402020.json"
    )
    args = parser.parse_args()
    record = json.loads(args.record.read_text())
    expected = record["signing_certificate_sha256"]
    out = args.workspace / "inspection"
    out.mkdir(parents=True, exist_ok=True)
    for name in record["apks"]:
        apk = args.workspace / "apks" / name
        if (
            hashlib.sha256(apk.read_bytes()).hexdigest()
            != record["apks"][name]["sha256"]
        ):
            raise RuntimeError(f"{name}: bytes do not match the pinned build record")
        command = [
            str(args.apksigner.resolve()),
            "verify",
            "--verbose",
            "--print-certs",
            str((args.workspace / "apks" / name).resolve()),
        ]
        result = subprocess.run(command, text=True, capture_output=True, check=True)
        if signer_digests(result.stdout) != {expected}:
            raise RuntimeError(
                f"{name}: verified, but the expected signing certificate was not reported"
            )
        (out / f"{name}.signature.txt").write_text(result.stdout + result.stderr)
        print(f"{name}: verified; expected signing certificate present")


if __name__ == "__main__":
    main()

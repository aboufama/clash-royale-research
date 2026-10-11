"""Extract a hash-pinned research input; never install or execute the APK."""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import zipfile

REPO = Path(__file__).resolve().parents[1]


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def extract(bundle, workspace, record):
    blob = Path(bundle).read_bytes()
    if sha256(blob) != record["bundle"]["sha256"]:
        raise ValueError("Bundle SHA-256 does not match the pinned build record")
    workspace = Path(workspace)
    result = {"build": record["version"], "bundle_sha256": sha256(blob), "files": {}}
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        for name in ("base.apk", "split_config.arm64_v8a.apk"):
            data = archive.read(name)
            if sha256(data) != record["apks"][name]["sha256"]:
                raise ValueError(f"Unexpected digest for {name}")
            target = workspace / "apks" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            result["files"][f"apks/{name}"] = sha256(data)
            if name == "split_config.arm64_v8a.apk":
                with zipfile.ZipFile(io.BytesIO(data)) as split:
                    for member in split.infolist():
                        path = PurePosixPath(member.filename)
                        if (
                            len(path.parts) != 3
                            or path.parts[:2] != ("lib", "arm64-v8a")
                            or path.suffix != ".so"
                        ):
                            continue
                        library = split.read(member)
                        target = workspace / "native" / path.name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(library)
                        result["files"][f"native/{path.name}"] = sha256(library)
    output = workspace / "inspection"
    output.mkdir(parents=True, exist_ok=True)
    (output / "preparation.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", type=Path)
    parser.add_argument(
        "--workspace", type=Path, default=REPO / "work/builds/160402020"
    )
    parser.add_argument(
        "--record", type=Path, default=REPO / "research/builds/160402020.json"
    )
    args = parser.parse_args()
    result = extract(args.bundle, args.workspace, json.loads(args.record.read_text()))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

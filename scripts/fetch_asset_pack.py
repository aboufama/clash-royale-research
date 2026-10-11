"""Fetch only the pinned stored asset APK using HTTP byte ranges.

Obtain a fresh download-link URL from the recorded public APKFab release page.
CDN links expire, so none is embedded or saved in the output report. This tool
rejects full-body fallback responses, unexpected member size, hash changes,
and an incorrect APK signer. It does not install or execute the game.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import subprocess
import urllib.request
import zipfile
import zlib

MEMBER = "install_time_asset_pack.apk"
EXPECTED_BYTES = 913096301
EXPECTED_SHA256 = "3e62afcf73786919be08b0a48f1744d82b618642fed8e8db7d1a76b5b2eb3fd3"
EXPECTED_SIGNER = "59ea9ded5f79298a50103d254497ca71ca80332492c749375044879b8f099357"
SOURCE_PAGE = "https://apkfab.com/clash-royale/com.supercell.clashroyale/download?sha1=a2168a5311707371c3126463ded78917413d8336"
TAIL_BYTES = 65557


def range_response(url, range_value, total=None, etag=None):
    request = urllib.request.Request(
        url,
        headers={
            "Range": range_value,
            "Accept-Encoding": "identity",
            "User-Agent": "ClashRoyaleResearch/1.0",
        },
    )
    response = urllib.request.urlopen(request, timeout=45)
    match = re.fullmatch(
        r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", "")
    )
    if response.status != 206 or not match:
        response.close()
        raise ValueError("Server did not return a valid HTTP 206 byte range")
    first, last, size = map(int, match.groups())
    if first > last or last >= size or (total is not None and size != total):
        response.close()
        raise ValueError("Inconsistent remote archive length")
    if etag is not None and response.headers.get("ETag") != etag:
        response.close()
        raise ValueError("Remote archive ETag changed")
    expected = (
        (max(0, size - int(range_value[7:])), size - 1)
        if range_value.startswith("bytes=-")
        else tuple(map(int, range_value[6:].split("-")))
    )
    if (first, last) != expected:
        response.close()
        raise ValueError("Server returned the wrong byte range")
    return response, first, last, size


def small_range(url, start, size, total, etag):
    response, first, last, _ = range_response(
        url, f"bytes={start}-{start + size - 1}", total, etag
    )
    with response:
        data = response.read(size + 1)
    if len(data) != size:
        raise ValueError("Short or oversized metadata response")
    return data


def stored_member(tail, total):
    """Read the small outer ZIP directory, correcting its truncated prefix."""
    with zipfile.ZipFile(io.BytesIO(tail)) as archive:
        matches = [entry for entry in archive.infolist() if entry.filename == MEMBER]
        if len(matches) != 1:
            raise ValueError("Expected exactly one install-time asset split")
        entry = matches[0]
        if entry.compress_type != zipfile.ZIP_STORED or entry.flag_bits & 1:
            raise ValueError("Asset split must be stored unencrypted in the outer XAPK")
        if entry.file_size != EXPECTED_BYTES or entry.compress_size != EXPECTED_BYTES:
            raise ValueError("Asset split size differs from the pinned build")
        return entry, entry.header_offset + total - len(tail)


def signer_digests(output):
    pattern = r"^(?:V[\d.]+ )?Signer(?: #\d+)?:? certificate SHA-256 digest:\s*([0-9a-fA-F]{64})\s*$"
    return {x.lower() for x in re.findall(pattern, output, re.MULTILINE)}


def verify(target, apksigner):
    if target.stat().st_size != EXPECTED_BYTES:
        raise ValueError("Acquired asset split length is incorrect")
    with target.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != EXPECTED_SHA256:
        raise ValueError("Acquired asset split SHA-256 is incorrect")
    result = subprocess.run(
        [
            str(apksigner.resolve()),
            "verify",
            "--verbose",
            "--print-certs",
            str(target.resolve()),
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    if signer_digests(result.stdout) != {EXPECTED_SIGNER}:
        raise ValueError("Expected exactly the pinned Supercell APK signer")
    target.with_suffix(".signature.txt").write_text(
        result.stdout + result.stderr, encoding="utf-8"
    )
    result = {
        "source_page": SOURCE_PAGE,
        "member": MEMBER,
        "build_version_code": "160402020",
        "bytes": EXPECTED_BYTES,
        "sha256": digest,
        "signer_sha256": EXPECTED_SIGNER,
        "signature_verified": True,
        "download_method": "HTTP ranges for one stored outer ZIP member",
    }
    target.with_suffix(".acquisition.json").write_text(
        json.dumps(result, indent=2) + "\n", encoding="utf-8"
    )
    return result


def acquire(url, target, apksigner):
    target = Path(target)
    if target.exists():
        return verify(target, apksigner)
    response, _, _, total = range_response(url, f"bytes=-{TAIL_BYTES}")
    etag = response.headers.get("ETag")
    with response:
        tail = response.read(TAIL_BYTES + 1)
    if len(tail) != min(TAIL_BYTES, total):
        raise ValueError("Unexpected ZIP tail length")
    entry, offset = stored_member(tail, total)
    header = small_range(url, offset, 30, total, etag)
    parts = struct.unpack("<4s5H3I2H", header)
    if parts[0] != b"PK\x03\x04" or parts[3] != 0 or parts[2] & 1:
        raise ValueError("Unexpected stored-member local header")
    name_size, extra_size = parts[-2:]
    name = small_range(url, offset + 30, name_size, total, etag).decode("utf-8")
    if name != MEMBER:
        raise ValueError("ZIP local and central names disagree")
    start = offset + 30 + name_size + extra_size
    response, _, _, _ = range_response(
        url, f"bytes={start}-{start + EXPECTED_BYTES - 1}", total, etag
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".partial")
    count, crc = 0, 0
    digest = hashlib.sha256()
    with response, partial.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > EXPECTED_BYTES:
                raise ValueError("Oversized asset split response")
            output.write(chunk)
            digest.update(chunk)
            crc = zlib.crc32(chunk, crc)
    if (
        count != EXPECTED_BYTES
        or crc != entry.CRC
        or digest.hexdigest() != EXPECTED_SHA256
    ):
        raise ValueError(
            "Downloaded split failed length, ZIP CRC, or pinned SHA-256 validation"
        )
    partial.rename(target)
    return verify(target, apksigner)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--xapk-url", help="Freshly observed public XAPK download link")
    source.add_argument(
        "--url-file",
        type=Path,
        help="Local file holding that link; never commit temporary CDN URLs",
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--apksigner", type=Path, required=True)
    args = parser.parse_args()
    url = args.xapk_url or args.url_file.read_text(encoding="utf-8").strip()
    if not url.startswith("https://"):
        parser.error("The observed download URL must use HTTPS")
    print(json.dumps(acquire(url, args.output, args.apksigner), indent=2))


if __name__ == "__main__":
    main()

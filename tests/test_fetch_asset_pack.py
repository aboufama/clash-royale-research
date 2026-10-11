import io
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import fetch_asset_pack as fetch


def response(status, content_range, etag='"fixed"'):
    result = io.BytesIO(b"abcdef")
    result.status = status
    result.headers = {"Content-Range": content_range, "ETag": etag}
    return result


class RangeAcquisitionTests(unittest.TestCase):
    def test_wrong_range_full_body_and_changed_object_are_rejected(self):
        variants = [
            (200, "bytes 2-7/10", '"fixed"'),
            (206, "bytes 3-8/10", '"fixed"'),
            (206, "bytes 2-7/11", '"fixed"'),
            (206, "bytes 2-7/10", '"changed"'),
        ]
        for status, value, etag in variants:
            with self.subTest(status=status, value=value, etag=etag):
                with patch.object(
                    fetch.urllib.request,
                    "urlopen",
                    return_value=response(status, value, etag),
                ):
                    with self.assertRaises(ValueError):
                        fetch.range_response(
                            "https://example.invalid/file", "bytes=2-7", 10, '"fixed"'
                        )

    def test_exact_range_and_suffix_range(self):
        with patch.object(
            fetch.urllib.request, "urlopen", return_value=response(206, "bytes 2-7/10")
        ):
            result, first, last, total = fetch.range_response(
                "https://example.invalid/file", "bytes=2-7", 10, '"fixed"'
            )
            self.assertEqual((first, last, total), (2, 7, 10))
            result.close()
        with patch.object(
            fetch.urllib.request, "urlopen", return_value=response(206, "bytes 4-9/10")
        ):
            result, first, last, total = fetch.range_response(
                "https://example.invalid/file", "bytes=-6"
            )
            self.assertEqual((first, last, total), (4, 9, 10))
            result.close()

    def test_signer_match_ignores_source_stamp(self):
        self.assertEqual(
            fetch.signer_digests(
                f"Source Stamp Signer: certificate SHA-256 digest: {fetch.EXPECTED_SIGNER}\n"
            ),
            set(),
        )
        self.assertEqual(
            fetch.signer_digests(
                f"V3.0 Signer: certificate SHA-256 digest: {fetch.EXPECTED_SIGNER}\n"
            ),
            {fetch.EXPECTED_SIGNER},
        )

    def test_truncated_zip_prefix_offset_and_compression_guard(self):
        for compression in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            data = io.BytesIO()
            with zipfile.ZipFile(data, "w") as archive:
                archive.writestr("prefix", bytes(3000))
                archive.writestr(fetch.MEMBER, b"example", compress_type=compression)
            blob = data.getvalue()
            with zipfile.ZipFile(io.BytesIO(blob)) as archive:
                expected_offset = archive.getinfo(fetch.MEMBER).header_offset
            with patch.object(fetch, "EXPECTED_BYTES", 7):
                if compression == zipfile.ZIP_STORED:
                    entry, offset = fetch.stored_member(blob[-1000:], len(blob))
                    self.assertEqual(offset, expected_offset)
                else:
                    with self.assertRaises(ValueError):
                        fetch.stored_member(blob[-1000:], len(blob))


if __name__ == "__main__":
    unittest.main()

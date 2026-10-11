"""Original UTF-8 assets must not leak into the public source tree."""

from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from audit_asset_pack import extraction_target, private_extraction_root


class AssetOutputPathsTests(unittest.TestCase):
    def test_public_paths_and_traversal_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for target in (root, root / "research", root / "work/../scripts"):
                with self.subTest(target=target), self.assertRaises(ValueError):
                    private_extraction_root(target, root)
            destination = private_extraction_root(root / "work/decoded", root)
            for name in ("../README.md", "/README.md", "sub/../../README.md", "sub\\x"):
                with self.subTest(name=name), self.assertRaises(ValueError):
                    extraction_target(destination, name)
            self.assertEqual(
                extraction_target(destination, "csv_logic/example.toml"),
                destination / "csv_logic/example.toml",
            )

    def test_symlink_cannot_redirect_original_bytes_to_public_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            destination = root / "work/decoded"
            destination.mkdir(parents=True)
            public = root / "research"
            public.mkdir()
            (destination / "csv_logic").symlink_to(public, target_is_directory=True)
            with self.assertRaises(ValueError):
                extraction_target(destination.resolve(), "csv_logic/example.toml")
            (root / "work/redirect").symlink_to(public, target_is_directory=True)
            with self.assertRaises(ValueError):
                private_extraction_root(root / "work/redirect", root)

    def test_work_root_cannot_be_redirected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            public = root / "research"
            public.mkdir()
            (root / "work").symlink_to(public, target_is_directory=True)
            with self.assertRaises(ValueError):
                private_extraction_root(root / "work/decoded", root)


if __name__ == "__main__":
    unittest.main()

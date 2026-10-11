import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "public_tree", Path(__file__).resolve().parents[1] / "scripts/check_public_tree.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublicTreeTests(unittest.TestCase):
    def test_rejects_ignored_inputs_even_if_force_added(self):
        for name in [
            "work/result.json",
            "research/game.so",
            "downloads/game.apk",
            ".env.local",
        ]:
            with self.subTest(name=name):
                self.assertIsNotNone(module.problem(name, b"example"))

    def test_rejects_binary_disguised_as_text(self):
        self.assertIsNotNone(module.problem("research/evidence.json", b"abc\0def"))
        self.assertIsNotNone(module.problem("research/evidence.txt", bytes([255])))

    def test_game_files_allow_binaries_up_to_github_limit(self):
        self.assertIsNone(module.problem("game-files/apk/game.apkm", b"\0" * 2_000_000))
        self.assertIsNone(module.problem("game-files/asset-pack/assets/sc/ui.sc", b"\xff\0"))
        self.assertIsNotNone(module.problem("game-files/big.bin", b"\0" * 100_000_001))
        # Only the top-level game-files directory is exempt.
        self.assertIsNotNone(module.problem("research/game-files/game.apk", b"example"))

    def test_accepts_small_public_evidence(self):
        self.assertIsNone(
            module.problem("research/evidence/example.json", b'{"returned":false}')
        )


if __name__ == "__main__":
    unittest.main()

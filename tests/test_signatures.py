import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "verify_apks", Path(__file__).resolve().parents[1] / "scripts/verify_apks.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SignerParsingTests(unittest.TestCase):
    def test_source_stamp_cannot_substitute_for_apk_signer(self):
        digest = "a" * 64
        self.assertEqual(
            module.signer_digests(
                f"Source Stamp Signer: certificate SHA-256 digest: {digest}\n"
            ),
            set(),
        )

    def test_recognizes_verified_signer_formats(self):
        digest = "b" * 64
        for label in ["V3.0 Signer:", "Signer #1"]:
            with self.subTest(label=label):
                self.assertEqual(
                    module.signer_digests(
                        f"{label} certificate SHA-256 digest: {digest}\n"
                    ),
                    {digest},
                )

    def test_preserves_multiple_signers_for_exact_match(self):
        output = "\n".join(
            f"Signer #{i} certificate SHA-256 digest: {str(i)*64}" for i in [1, 2]
        )
        self.assertEqual(module.signer_digests(output), {"1" * 64, "2" * 64})


if __name__ == "__main__":
    unittest.main()

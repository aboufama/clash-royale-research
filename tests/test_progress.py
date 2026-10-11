"""Test committed-tree enforcement with temporary real Git repositories."""

import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("progress", ROOT / "scripts/progress.py")
progress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(progress)
BASELINE = json.loads((ROOT / "research/status.json").read_text(encoding="utf-8"))
ZERO = "0" * 40


class ChartTests(unittest.TestCase):
    def test_generated_chart_is_valid_and_escapes_table_content(self):
        data = copy.deepcopy(BASELINE)
        data["milestones"][0]["evidence"] = ["one | two <three>"]
        chart = progress.render(data)
        self.assertIn("one &#124; two &lt;three&gt;", chart)
        progress.check_text(json.dumps(data), "Before\n" + chart + "\nAfter")

    def test_stale_chart_fails(self):
        chart = progress.render(BASELINE).replace("APK provenance", "Old provenance")
        with self.assertRaisesRegex(progress.ProgressError, "stale"):
            progress.check_text(json.dumps(BASELINE), chart)

    def test_missing_duplicate_and_reversed_markers_fail(self):
        for text in [
            "",
            progress.START,
            progress.END + progress.START,
            progress.START + progress.START + progress.END,
        ]:
            with self.subTest(text=text), self.assertRaises(progress.ProgressError):
                progress.chart_bounds(text)

    def test_unsupported_percentage_and_evidence_free_claims_fail(self):
        variants = []
        data = copy.deepcopy(BASELINE)
        data["overall_percent"] = 50
        variants.append(data)
        data = copy.deepcopy(BASELINE)
        data["milestones"][0]["evidence"] = []
        variants.append(data)
        data = copy.deepcopy(BASELINE)
        data["milestones"][5]["status"] = "verified"
        variants.append(data)
        for data in variants:
            with self.subTest(data=data), self.assertRaises(progress.ProgressError):
                progress.validate(data)

    def test_missing_or_duplicate_milestones_fail(self):
        for duplicate in (True, False):
            data = copy.deepcopy(BASELINE)
            if duplicate:
                data["milestones"][-1] = data["milestones"][0]
            else:
                data["milestones"].pop()
            with self.assertRaises(progress.ProgressError):
                progress.validate(data)

    def test_review_date_and_sequence_are_strict(self):
        for field, value in [
            ("sequence", True),
            ("sequence", 0),
            ("reviewed_at", "2026-02-30T00:00:00Z"),
            ("reviewed_at", "2026-10-11"),
        ]:
            data = copy.deepcopy(BASELINE)
            data["review"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(
                progress.ProgressError
            ):
                progress.validate(data)


class PushTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Progress Test")
        self.git("config", "user.email", "progress-test@example.invalid")
        # Make tests independent of developer signing and custom hook settings.
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", str(self.root / "no-hooks"))
        self.data = copy.deepcopy(BASELINE)
        (self.root / "research").mkdir()
        self.write_chart()
        self.first = self.commit("initial")

    def git(self, *args):
        result = subprocess.run(
            ["git", "-C", str(self.root), *args],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip()

    def write_chart(self):
        (self.root / "research/status.json").write_text(
            json.dumps(self.data, indent=2) + "\n", encoding="utf-8"
        )
        (self.root / "README.md").write_text(
            "# Example\n\n" + progress.render(self.data) + "\n", encoding="utf-8"
        )

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def review(self):
        self.data["review"]["sequence"] += 1
        self.data["review"][
            "summary"
        ] = "Reviewed evidence; no additional gameplay recovered."
        self.write_chart()

    def test_first_push_validates_committed_chart(self):
        self.assertTrue(
            progress.check_range(self.root, ZERO, self.first, "refs/heads/main")
        )
        (self.root / "README.md").write_text("uncommitted unrelated content\n")
        self.assertTrue(
            progress.check_range(self.root, ZERO, self.first, "refs/heads/main")
        )

    def test_first_push_rejects_committed_stale_chart(self):
        (self.root / "README.md").write_text(
            progress.START + "\nstale\n" + progress.END
        )
        stale = self.commit("stale chart")
        self.write_chart()  # A repaired, uncommitted chart must not mask the error.
        with self.assertRaisesRegex(progress.ProgressError, "stale"):
            progress.check_range(self.root, ZERO, stale, "refs/heads/main")

    def test_incremental_review_passes(self):
        self.review()
        after = self.commit("review")
        self.assertTrue(
            progress.check_range(self.root, self.first, after, "refs/heads/main")
        )

    def test_uncommitted_review_does_not_satisfy_push(self):
        (self.root / "change.txt").write_text("research change\n")
        after = self.commit("research without review")
        self.review()
        with self.assertRaisesRegex(
            progress.ProgressError, "missing committed changes"
        ):
            progress.check_range(self.root, self.first, after, "refs/heads/main")

    def test_both_files_changing_without_chart_change_fails(self):
        (self.root / "research/status.json").write_text(
            json.dumps(self.data, indent=4) + "\n"
        )
        readme = self.root / "README.md"
        readme.write_text(readme.read_text() + "\nUnrelated prose.\n")
        after = self.commit("cosmetic changes")
        with self.assertRaisesRegex(progress.ProgressError, "chart itself must change"):
            progress.check_range(self.root, self.first, after, "refs/heads/main")

    def test_chart_change_without_new_review_fails(self):
        self.data["milestones"][0]["evidence"].append("Existing signatures rechecked.")
        self.write_chart()
        after = self.commit("evidence change without review")
        with self.assertRaisesRegex(progress.ProgressError, "sequence must increase"):
            progress.check_range(self.root, self.first, after, "refs/heads/main")

    def test_tags_and_branch_deletions_are_skipped(self):
        fake = "f" * 40
        self.assertFalse(
            progress.check_range(self.root, self.first, ZERO, "refs/heads/main")
        )
        self.assertFalse(progress.check_range(self.root, ZERO, fake, "refs/tags/v1"))
        self.assertEqual(
            progress.check_push(
                self.root,
                f"(delete) {ZERO} refs/heads/main {fake}\nrefs/tags/v1 {fake} refs/tags/v1 {ZERO}\n",
            ),
            0,
        )

    def test_multiple_push_refs_cannot_hide_a_stale_branch(self):
        self.review()
        after = self.commit("review")
        (self.root / "change.txt").write_text("new change\n")
        stale = self.commit("unreviewed change")
        rows = f"refs/heads/main {after} refs/heads/main {self.first}\nrefs/heads/other {stale} refs/heads/other {after}\n"
        with self.assertRaisesRegex(
            progress.ProgressError, "missing committed changes"
        ):
            progress.check_push(self.root, rows)

    def test_github_push_event_initial_and_incremental(self):
        event_path = self.root / "event.json"

        def check(before, after):
            event_path.write_text(
                json.dumps({"before": before, "after": after, "ref": "refs/heads/main"})
            )
            return subprocess.run(
                [
                    sys.executable,
                    str(ROOT / "scripts/progress.py"),
                    "--root",
                    str(self.root),
                    "check-push",
                    "--event",
                    str(event_path),
                ],
                capture_output=True,
                text=True,
            )

        self.assertEqual(check(ZERO, self.first).returncode, 0)
        self.review()
        after = self.commit("review")
        self.assertEqual(check(self.first, after).returncode, 0)
        (self.root / "change.txt").write_text("new change\n")
        stale = self.commit("missing review")
        result = check(after, stale)
        self.assertEqual(result.returncode, 1)
        self.assertIn("missing committed changes", result.stderr)

    def test_render_review_preserves_surrounding_prose(self):
        readme = self.root / "README.md"
        readme.write_text("Intro\n" + progress.render(self.data) + "\nOutro\n")
        result = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/progress.py"),
                "--root",
                str(self.root),
                "render",
                "--review",
                "Evidence reviewed; current limits retained.",
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        actual = readme.read_text()
        self.assertTrue(actual.startswith("Intro\n"))
        self.assertTrue(actual.endswith("\nOutro\n"))
        updated = progress.check_text(
            (self.root / "research/status.json").read_text(), actual
        )
        self.assertEqual(
            updated["review"]["sequence"], self.data["review"]["sequence"] + 1
        )


if __name__ == "__main__":
    unittest.main()

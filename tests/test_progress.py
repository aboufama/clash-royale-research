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
SCHEMA_2_ADDITIONS = {"asset_pack", "runtime_integrity", "towers"}


def legacy_status(data):
    """Construct the pre-migration shape without depending on validator constants."""
    result = copy.deepcopy(data)
    result["schema_version"] = 1
    result["milestones"] = [
        item for item in result["milestones"] if item["id"] not in SCHEMA_2_ADDITIONS
    ]
    return result


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
        next(item for item in data["milestones"] if item["id"] == "movement")[
            "status"
        ] = "verified"
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

    def test_schema_2_requires_all_new_milestones(self):
        for milestone in sorted(SCHEMA_2_ADDITIONS):
            data = copy.deepcopy(BASELINE)
            data["milestones"] = [
                item for item in data["milestones"] if item["id"] != milestone
            ]
            with self.subTest(milestone=milestone), self.assertRaisesRegex(
                progress.ProgressError, "schema 2 milestones"
            ):
                progress.validate(data)

    def test_schema_versions_cannot_be_guessed_or_coerced(self):
        for version in (0, 3, "2", True):
            data = copy.deepcopy(BASELINE)
            data["schema_version"] = version
            with self.subTest(version=version), self.assertRaisesRegex(
                progress.ProgressError, "schema_version"
            ):
                progress.validate(data)
        data = legacy_status(BASELINE)
        data["schema_version"] = 2
        with self.assertRaises(progress.ProgressError):
            progress.validate(data)

    def test_schema_1_does_not_accept_unversioned_new_rows(self):
        data = copy.deepcopy(BASELINE)
        data["schema_version"] = 1
        with self.assertRaisesRegex(progress.ProgressError, "schema 1 milestones"):
            progress.validate(data)

    def test_new_milestones_separate_recovery_from_exact_behavior(self):
        chart = progress.render(BASELINE)
        self.assertIn("| Pinned install-time assets |", chart)
        self.assertIn("| Runtime region checksums |", chart)
        self.assertIn("| Tower interactions |", chart)
        self.assertIn("| Byte-identical battle equivalence |", chart)
        self.assertIn("Recovery is not proof of byte-identical battle behavior.", chart)
        data = copy.deepcopy(BASELINE)
        next(item for item in data["milestones"] if item["id"] == "towers")[
            "status"
        ] = "verified"
        with self.assertRaisesRegex(progress.ProgressError, "invalid status for towers"):
            progress.validate(data)

    def test_historical_schema_1_rendering_is_byte_stable(self):
        # Frozen historical labels, order and wrapper text. A new formatter must
        # not retroactively declare the remote schema-1 chart stale.
        rows = [
            ("apk_provenance", "APK provenance and signatures", "verified", "Verified"),
            ("java", "Java startup and JNI declarations", "partial", "Partial"),
            ("native_exports", "Native entry points", "recovered", "Recovered"),
            ("loader_config", "Loader configuration", "recovered", "Recovered"),
            ("support_runtime", "Supporting native runtime", "partial", "Partial"),
            ("movement", "Troop movement", "not_recovered", "Not recovered"),
            ("targeting", "Target acquisition", "not_recovered", "Not recovered"),
            ("collision", "Collision and avoidance", "not_recovered", "Not recovered"),
            ("combat", "Combat interactions", "not_recovered", "Not recovered"),
            ("equivalence", "Behavioral equivalence", "not_validated", "Not validated"),
        ]
        data = {
            "schema_version": 1,
            "build": {"package": "com.supercell.clashroyale", "version": "160402020"},
            "review": {"sequence": 2, "reviewed_at": "2026-10-11T05:36:42Z", "summary": "Historical review."},
            "milestones": [
                {"id": key, "status": state, "evidence": ["Historical evidence."]}
                for key, _title, state, _label in rows
            ],
        }
        expected = "\n".join([
            "<!-- decompile-status:start -->", "",
            "Android build **160402020**. Recovery is not proof of behavioral equivalence.", "",
            "| Milestone | Status | Evidence / limit |",
            "| --- | --- | --- |",
            *[f"| {title} | {label} | Historical evidence. |" for _key, title, _state, label in rows],
            "", "Review **2** · **2026-10-11T05:36:42Z** · Historical review.", "",
            "No overall completion percentage is claimed. Status labels describe the evidence available for this build.",
            "", "<!-- decompile-status:end -->",
        ])
        self.assertEqual(progress.render(data), expected)
        progress.check_text(json.dumps(data), expected)


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

    def test_push_migrates_schema_1_to_2_with_review(self):
        current = copy.deepcopy(self.data)
        self.data = legacy_status(current)
        self.write_chart()
        before = self.commit("historical schema 1")
        # Confirm a legacy committed chart is accepted independently of any
        # present working-tree schema, then migrate and review in a new commit.
        self.assertEqual(progress.check_revision(self.root, before)["schema_version"], 1)
        self.data = current
        self.review()
        after = self.commit("schema 2 and new explicit milestones")
        self.assertTrue(progress.check_range(self.root, before, after, "refs/heads/main"))

    def test_schema_migration_without_review_is_rejected(self):
        current = copy.deepcopy(self.data)
        self.data = legacy_status(current)
        self.write_chart()
        before = self.commit("historical schema 1")
        self.data = current
        self.write_chart()
        after = self.commit("schema migration without review")
        with self.assertRaisesRegex(progress.ProgressError, "sequence must increase"):
            progress.check_range(self.root, before, after, "refs/heads/main")

    def test_schema_downgrade_cannot_hide_milestones_even_with_review(self):
        self.data = legacy_status(self.data)
        self.review()
        after = self.commit("attempted reviewed downgrade")
        with self.assertRaisesRegex(progress.ProgressError, "schema downgrade is forbidden"):
            progress.check_range(self.root, self.first, after, "refs/heads/main")

    def test_first_push_of_historical_chart_remains_readable(self):
        self.data = legacy_status(self.data)
        self.write_chart()
        legacy = self.commit("historical branch")
        self.assertTrue(progress.check_range(self.root, ZERO, legacy, "refs/heads/archive"))

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

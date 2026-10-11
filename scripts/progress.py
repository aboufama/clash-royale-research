#!/usr/bin/env python3
"""Render an evidence-based status chart and enforce review on each branch push.

No dependencies beyond Python 3.9+. `check-push` validates the *committed* tree
for every pushed branch; editing the working copy alone cannot satisfy it.
The first push of a branch validates its chart without requiring a prior diff.
Tags and branch deletions do not publish a new research tree and are skipped.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys

START = "<!-- decompile-status:start -->"
END = "<!-- decompile-status:end -->"
STATUS_PATH = "research/status.json"
README_PATH = "README.md"
ZERO = re.compile(r"0{40}|0{64}")
OBJECT_ID = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")
LABELS = {
    "verified": "Verified",
    "recovered": "Recovered",
    "partial": "Partial",
    "not_recovered": "Not recovered",
    "not_validated": "Not validated",
}
# Recovery and behavioral equivalence are intentionally separate milestones.
MILESTONES = {
    "apk_provenance": ("APK provenance and signatures", {"partial", "verified"}),
    "java": ("Java startup and JNI declarations", {"partial", "recovered"}),
    "native_exports": (
        "Native entry points",
        {"not_recovered", "partial", "recovered"},
    ),
    "loader_config": (
        "Loader configuration",
        {"not_recovered", "partial", "recovered"},
    ),
    "support_runtime": (
        "Supporting native runtime",
        {"not_recovered", "partial", "recovered"},
    ),
    "movement": ("Troop movement", {"not_recovered", "partial", "recovered"}),
    "targeting": ("Target acquisition", {"not_recovered", "partial", "recovered"}),
    "collision": ("Collision and avoidance", {"not_recovered", "partial", "recovered"}),
    "combat": ("Combat interactions", {"not_recovered", "partial", "recovered"}),
    "equivalence": ("Behavioral equivalence", {"not_validated", "partial", "verified"}),
}


class ProgressError(Exception):
    """Actionable validation failure suitable for a hook or CI log."""


def fields(value: object, expected: set[str], location: str) -> dict:
    if not isinstance(value, dict) or set(value) != expected:
        raise ProgressError(
            f"{location} must contain exactly: {', '.join(sorted(expected))}"
        )
    return value


def line(value: object, location: str) -> str:
    if (
        not isinstance(value, str)
        or not value.strip()
        or any(c in value for c in "\r\n")
    ):
        raise ProgressError(f"{location} must be a nonempty single line")
    return value


def validate(data: object) -> dict:
    data = fields(data, {"schema_version", "build", "review", "milestones"}, "status")
    if type(data["schema_version"]) is not int or data["schema_version"] != 1:
        raise ProgressError("schema_version must be 1")
    build = fields(data["build"], {"package", "version"}, "build")
    if build["package"] != "com.supercell.clashroyale":
        raise ProgressError("build.package must be com.supercell.clashroyale")
    if not isinstance(build["version"], str) or not build["version"].isdigit():
        raise ProgressError("build.version must be a numeric string")
    review = fields(data["review"], {"sequence", "reviewed_at", "summary"}, "review")
    if type(review["sequence"]) is not int or review["sequence"] < 1:
        raise ProgressError("review.sequence must be a positive integer")
    reviewed_at = line(review["reviewed_at"], "review.reviewed_at")
    try:
        parsed = datetime.strptime(reviewed_at, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError as exc:
        raise ProgressError(
            "review.reviewed_at must be an actual UTC timestamp, YYYY-MM-DDTHH:MM:SSZ"
        ) from exc
    if parsed.strftime("%Y-%m-%dT%H:%M:%SZ") != reviewed_at:
        raise ProgressError("review.reviewed_at must use zero-padded UTC format")
    line(review["summary"], "review.summary")
    milestones = data["milestones"]
    if not isinstance(milestones, list) or len(milestones) != len(MILESTONES):
        raise ProgressError("milestones must list every defined milestone exactly once")
    found = set()
    for item in milestones:
        item = fields(item, {"id", "status", "evidence"}, "milestone")
        key = line(item["id"], "milestone.id")
        if key not in MILESTONES or key in found:
            raise ProgressError(f"unknown or duplicate milestone: {key}")
        found.add(key)
        state = item["status"]
        if not isinstance(state, str) or state not in MILESTONES[key][1]:
            raise ProgressError(f"invalid status for {key}: {state!r}")
        evidence = item["evidence"]
        if not isinstance(evidence, list) or not evidence:
            raise ProgressError(f"{key} requires evidence or an explicit limitation")
        for note in evidence:
            line(note, f"{key}.evidence")
    return data


def read_status(text: str) -> dict:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ProgressError(f"invalid status JSON: {exc}") from exc
    return validate(data)


def cell(text: str) -> str:
    # Keep evidence literal so external filenames cannot alter the table.
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("|", "&#124;")
    )


def render(data: dict) -> str:
    validate(data)
    rows = [
        START,
        "",
        f"Android build **{data['build']['version']}**. Recovery is not proof of behavioral equivalence.",
        "",
        "| Milestone | Status | Evidence / limit |",
        "| --- | --- | --- |",
    ]
    by_id = {item["id"]: item for item in data["milestones"]}
    for key, (title, _) in MILESTONES.items():
        item = by_id[key]
        rows.append(
            f"| {title} | {LABELS[item['status']]} | {'; '.join(cell(x) for x in item['evidence'])} |"
        )
    review = data["review"]
    rows += [
        "",
        f"Review **{review['sequence']}** · **{review['reviewed_at']}** · {cell(review['summary'])}",
        "",
        "No overall completion percentage is claimed. Status labels describe the evidence available for this build.",
        "",
        END,
    ]
    return "\n".join(rows)


def chart_bounds(readme: str) -> tuple[int, int]:
    if readme.count(START) != 1 or readme.count(END) != 1:
        raise ProgressError(
            "README.md must contain exactly one status start marker and one end marker"
        )
    first, last = readme.index(START), readme.index(END)
    if first >= last:
        raise ProgressError("README status markers are out of order")
    return first, last + len(END)


def check_text(status_text: str, readme: str) -> dict:
    data = read_status(status_text)
    first, last = chart_bounds(readme)
    if readme[first:last] != render(data):
        raise ProgressError(
            "README chart is stale; run python3 scripts/progress.py render and commit both files"
        )
    return data


def git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(root), *args], text=True, capture_output=True, check=False
    )
    if result.returncode:
        raise ProgressError(f"git {' '.join(args)} failed: {result.stderr.strip()}")
    return result.stdout


def check_revision(root: Path, revision: str) -> dict:
    return check_text(
        git(root, "show", f"{revision}:{STATUS_PATH}"),
        git(root, "show", f"{revision}:{README_PATH}"),
    )


def check_range(root: Path, before: str, after: str, ref: str) -> bool:
    """Return whether this update publishes a branch; validate committed data."""
    if not OBJECT_ID.fullmatch(before) or not OBJECT_ID.fullmatch(after):
        raise ProgressError("push object IDs must be full hexadecimal Git object IDs")
    if not ref.startswith("refs/heads/") or ZERO.fullmatch(after):
        return False
    after_data = check_revision(root, after)
    if ZERO.fullmatch(before):
        return True
    changed = set(
        git(
            root, "diff", "--name-only", before, after, "--", README_PATH, STATUS_PATH
        ).splitlines()
    )
    missing = {README_PATH, STATUS_PATH} - changed
    if missing:
        raise ProgressError(
            f"{ref}: every branch push must update/review the chart; missing committed changes to {', '.join(sorted(missing))}. Run python3 scripts/progress.py render --review 'Describe the evidence reviewed', then commit both files."
        )
    # A changed unrelated README paragraph cannot stand in for chart review.
    before_readme = git(root, "show", f"{before}:{README_PATH}")
    before_first, before_last = chart_bounds(before_readme)
    if before_readme[before_first:before_last] == render(after_data):
        raise ProgressError(
            f"{ref}: the generated chart itself must change on every push"
        )
    before_data = read_status(git(root, "show", f"{before}:{STATUS_PATH}"))
    if after_data["review"]["sequence"] <= before_data["review"]["sequence"]:
        raise ProgressError(
            f"{ref}: review.sequence must increase on every push; use render --review"
        )
    return True


def check_push(root: Path, stdin: str) -> int:
    count = 0
    for number, row in enumerate(stdin.splitlines(), start=1):
        parts = row.split()
        if len(parts) != 4:
            raise ProgressError(f"malformed pre-push input at line {number}")
        _local_ref, local_sha, remote_ref, remote_sha = parts
        count += check_range(root, remote_sha, local_sha, remote_ref)
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    commands = parser.add_subparsers(dest="command", required=True)
    render_parser = commands.add_parser(
        "render", help="regenerate only the marked README section"
    )
    render_parser.add_argument(
        "--review",
        metavar="SUMMARY",
        help="record a new honest review (increment sequence and UTC timestamp)",
    )
    commands.add_parser(
        "check", help="validate the working-tree chart without changing it"
    )
    push_parser = commands.add_parser(
        "check-push",
        help="validate committed pushed trees and require a chart review per branch push",
    )
    push_parser.add_argument(
        "--event",
        type=Path,
        help="GitHub push-event JSON; otherwise read Git pre-push stdin",
    )
    args = parser.parse_args(argv)
    try:
        root = args.root.resolve()
        if args.command == "check-push":
            if args.event:
                event = json.loads(args.event.read_text(encoding="utf-8"))
                count = int(
                    check_range(root, event["before"], event["after"], event["ref"])
                )
            else:
                count = check_push(root, sys.stdin.read())
            print(f"Progress check passed for {count} pushed branch(es).")
        else:
            status_path, readme_path = root / STATUS_PATH, root / README_PATH
            status_text = status_path.read_text(encoding="utf-8")
            readme = readme_path.read_text(encoding="utf-8")
            if args.command == "check":
                check_text(status_text, readme)
                print("Progress chart matches research/status.json.")
            else:
                data = read_status(status_text)
                first, last = chart_bounds(readme)
                if args.review is not None:
                    line(args.review, "review summary")
                    data["review"]["sequence"] += 1
                    data["review"]["reviewed_at"] = datetime.now(timezone.utc).strftime(
                        "%Y-%m-%dT%H:%M:%SZ"
                    )
                    data["review"]["summary"] = args.review
                updated = readme[:first] + render(data) + readme[last:]
                if args.review is not None:
                    status_path.write_text(
                        json.dumps(data, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8",
                    )
                readme_path.write_text(updated, encoding="utf-8")
                print("Updated README progress chart.")
    except (ProgressError, OSError, KeyError, json.JSONDecodeError) as exc:
        print(f"Progress check failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

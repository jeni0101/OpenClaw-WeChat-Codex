#!/usr/bin/env python3
"""Fail when tracked files contain common credentials or deployment identifiers."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|AGE-SECRET-KEY-", re.I),
    "GitHub token": re.compile(r"gh[pousr]_[A-Za-z0-9_]{20,}"),
    "cloud secret id": re.compile(r"AKID[A-Za-z0-9]{12,}"),
    "OpenAI API key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}"),
    "real age recipient": re.compile(r"\bage1[023456789acdefghjklmnpqrstuvwxyz]{40,}"),
    "hardcoded WeChat account": re.compile(r"\b[0-9a-f]{10,}-im-bot\b", re.I),
    "numeric COS owner": re.compile(r"(?:uid/|wechat-clawbot-)\d{6,}"),
}
FORBIDDEN_PREFIXES = ("data/", "recovery/", ".storage/", "node_modules/", "dist/")


def tracked_files() -> list[str]:
    output = subprocess.check_output(
        ["git", "-C", str(ROOT), "ls-files", "-z"],
    )
    return [value.decode() for value in output.split(b"\0") if value]


def main() -> int:
    failures: list[str] = []
    for relative in tracked_files():
        # This file intentionally contains detector signatures as source text.
        if relative == "scripts/secret-scan.py":
            continue
        if relative.startswith(FORBIDDEN_PREFIXES):
            failures.append(f"tracked runtime path: {relative}")
            continue
        path = ROOT / relative
        try:
            content = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for name, pattern in PATTERNS.items():
            if pattern.search(content):
                failures.append(f"{relative}: {name}")
    if failures:
        print("Secret scan failed:")
        for failure in sorted(set(failures)):
            print(f"- {failure}")
        return 1
    print("Secret scan passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

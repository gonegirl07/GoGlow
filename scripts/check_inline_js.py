#!/usr/bin/env python3
"""Syntax-check inline JavaScript in HTML files with Node.js."""
from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from pathlib import Path


SCRIPT_TAG = re.compile(r"<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)</script\s*>", re.IGNORECASE)


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: check_inline_js.py <html-file> [<html-file> ...]", file=sys.stderr)
        return 2

    failed = False
    for name in sys.argv[1:]:
        path = Path(name)
        source = path.read_text(encoding="utf-8")
        blocks = SCRIPT_TAG.findall(source)
        if not blocks:
            print(f"{path}: no inline script blocks found")
            continue
        for index, block in enumerate(blocks, start=1):
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".js") as handle:
                handle.write(block)
                handle.flush()
                result = subprocess.run(
                    ["node", "--check", handle.name],
                    text=True,
                    capture_output=True,
                    check=False,
                )
            if result.returncode:
                failed = True
                print(f"{path}: inline script #{index} has a syntax error", file=sys.stderr)
                if result.stdout:
                    print(result.stdout, file=sys.stderr, end="")
                if result.stderr:
                    print(result.stderr, file=sys.stderr, end="")
            else:
                print(f"{path}: inline script #{index} syntax OK")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

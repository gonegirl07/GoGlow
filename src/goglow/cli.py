"""Command-line interface for the GoGlow MVP."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
from typing import Any
from .exporter import to_markdown
from .planner import SUPPORTED_ACTIVITIES, create_project
from .validator import validate_project

def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"Cannot read {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON in {path}:{exc.lineno}:{exc.colno}: {exc.msg}") from exc

def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="goglow", description="Plan and validate AI character video scenes; no model calls are made.")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="create an editable starter scene plan")
    init.add_argument("--activity", required=True, choices=SUPPORTED_ACTIVITIES)
    init.add_argument("--duration", type=int, default=36, help="target total seconds (default: 36)")
    init.add_argument("--scenes", type=int, default=4, help="number of planned scenes (default: 4)")
    init.add_argument("--character", default="Main Character")
    init.add_argument("--brief", default="")
    init.add_argument("--out", type=Path, required=True, help="output JSON path")
    validate = sub.add_parser("validate", help="validate project fields, scene durations, and states")
    validate.add_argument("project", type=Path)
    export = sub.add_parser("export", help="export a project to Markdown")
    export.add_argument("project", type=Path)
    export.add_argument("--out", type=Path, required=True)
    export.add_argument("--format", choices=("markdown",), default="markdown")
    return parser

def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "init":
            project = create_project(args.activity, args.duration, args.character, args.brief, scene_count=args.scenes)
            errors = validate_project(project)
            if errors:
                print("\n".join(errors), file=sys.stderr)
                return 2
            _write_text(args.out, json.dumps(project, ensure_ascii=False, indent=2) + "\n")
            print(f"Created starter plan: {args.out}")
            print(f"{len(project['scenes'])} scenes / {sum(s['duration_seconds'] for s in project['scenes'])} seconds")
            print("Template only: no image/video model was called.")
            return 0
        if args.command == "validate":
            project = _read_json(args.project)
            errors = validate_project(project)
            if errors:
                print("INVALID")
                for error in errors:
                    print(f"- {error}")
                return 1
            total = sum(scene["duration_seconds"] for scene in project["scenes"])
            print(f"VALID: {len(project['scenes'])} scenes, {total:g}s total, activity={project['activity']}, aspect={project['aspect_ratio']}")
            return 0
        if args.command == "export":
            project = _read_json(args.project)
            errors = validate_project(project)
            if errors:
                print("Cannot export invalid project:", file=sys.stderr)
                for error in errors:
                    print(f"- {error}", file=sys.stderr)
                return 1
            _write_text(args.out, to_markdown(project))
            print(f"Exported Markdown: {args.out}")
            return 0
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 2

if __name__ == "__main__":
    raise SystemExit(main())

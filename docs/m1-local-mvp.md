# M1 — Local planner and validator

## Scope
The first executable milestone creates editable starter scene plans, validates required fields and total duration, and exports a Markdown production packet. It uses only Python's standard library and makes no calls to image/video models.

## Requirements
- Python 3.10+
- No runtime dependencies

## Install

```bash
python -m venv .venv
# Linux/macOS:
source .venv/bin/activate
# Windows PowerShell:
# .venv\\Scripts\\Activate.ps1
python -m pip install -e .
```

## Quick start

```bash
goglow init --activity cycling --duration 36 --scenes 4 --character "AI Character A" --brief "Park path, morning light" --out projects/cycling-36s.json
goglow validate projects/cycling-36s.json
goglow export projects/cycling-36s.json --out exports/cycling-36s.md
```

Without installing the package, run from the repository root with `PYTHONPATH=src python -m goglow.cli ...`.

## Supported activities
`cycling`, `yoga`, `dance`, `fashion`, and `other`.

## Deliberate limitations
- Scene text is a deterministic starter template, not an LLM-generated final prompt.
- No Flow automation, image/video generation, asset upload, visual inspection, or automatic QC is implemented.
- The validator checks structural and duration consistency; it cannot determine whether generated motion looks correct.
- Review model labels and generation limits in the live product UI.

# GoGlow

**AI Character Video Director & multi-model production pipeline**

GoGlow helps plan, prompt, track, and quality-review short-form AI character videos. The first target workflow is Google Flow; the core is provider-agnostic so additional models and coding agents can contribute.

## Goals
- Produce vertical **9:16** videos with a target duration above 30 seconds (default planning target: **36 seconds**).
- Preserve character identity, wardrobe, props, screen direction, and scene-to-scene continuity.
- Support dance, cycling, yoga, fashion, and extensible future activities.
- Create scene-specific prompts and reference-image briefs.
- Track actual generation and review states without pretending a model was called or a video was inspected.

## Status
The initial **M1 local planner and validator** is implemented. It creates editable starter plans, checks scene structure and total duration, and exports Markdown. It uses Python's standard library and does not call image/video models.

The model names “Omni 1.1 Flash” and “Nano Banana Pro 2.1” are project-owner working labels. Confirm exact labels and controls in the live Flow selector before relying on them.

## Quick start
Requires Python 3.10+.

```bash
python -m venv .venv
# Linux/macOS
source .venv/bin/activate
# Windows PowerShell: .venv\\Scripts\\Activate.ps1
python -m pip install -e .

goglow init --activity cycling --duration 36 --scenes 4 --character "AI Character A" --brief "Park path, morning light" --out projects/cycling-36s.json
goglow validate projects/cycling-36s.json
goglow export projects/cycling-36s.json --out exports/cycling-36s.md
```

Supported activities: `cycling`, `yoga`, `dance`, `fashion`, and `other`.

See [M1 local MVP guide](docs/m1-local-mvp.md) and the [36-second cycling example](examples/cycling-36s.json).

## Repository map
- `AGENTS.md` — rules for coding agents
- `docs/` — architecture, workflow, model verification, M1 setup
- `specs/` — JSON Schemas for character profiles, scene plans, and QC reports
- `src/goglow/` — planner, validator, Markdown exporter, CLI
- `prompts/` — director and activity prompt templates
- `adapters/` — integration policy and provider notes
- `tests/` — unit tests and activity acceptance cases

## Core rule
**A planned action is not a generated result. A generated result is not a passed QC check.** No Flow automation, image/video generation, media inspection, or automatic visual QC is implemented in M1.

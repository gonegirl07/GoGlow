# GoGlow

**AI Character Video Director & multi-model production pipeline**

GoGlow helps plan, prompt, track, and quality-review short-form AI character videos. The first target workflow is Google Flow; the core is provider-agnostic so additional models and coding agents can contribute.

## Try the browser prototype (no installation)

Open app/index.html in a modern browser. You can also download that file from GitHub and open it locally. It does not require Python, Node.js, an API key, or a server.

The prototype can:
- Set the character name, activity, target duration, supported aspect ratio (9:16), and project brief.
- Preview character reference images locally in the current browser session.
- Generate editable starter prompts and scene cards for cycling, yoga, dance, fashion, and other activities.
- Save project data in browser local storage and export JSON or Markdown.

**Prototype limitations:** no Google Flow integration, no image/video generation, no automated visual QC, and no image data included in exports. Reference images are only previewed locally; prompts still need human review. The browser prototype supports manual media URI entry and structured human-QC reports, blocks unsupported workflow transitions, and blocks export when required fields or duration totals are invalid. A media URI is a declaration, not proof that the clip exists or plays; QC is not automatic. Browser-local saving is not a substitute for exporting backups.

## Status

The **M1 local planner and validator** is implemented in Python, and a **zero-install browser prototype** is available in app/index.html. The Python planner checks scene structure and total duration and exports Markdown. Neither implementation calls image/video models.

The model names “Omni 1.1 Flash” and “Nano Banana Pro 2.1” are project-owner working labels. Confirm exact labels and controls in the live Flow selector before relying on them.

## Python CLI (optional)

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

Supported activities: cycling, yoga, dance, fashion, and other.

See [M1 local MVP guide](docs/m1-local-mvp.md) and the [36-second cycling example](examples/cycling-36s.json).

## Repository map
- AGENTS.md — rules for coding agents
- app/index.html — zero-install browser prototype
- docs/ — architecture, workflow, model verification, M1 setup
- specs/ — JSON Schemas for character profiles, scene plans, and QC reports
- src/goglow/ — planner, validator, Markdown exporter, CLI
- prompts/ — director and activity prompt templates
- adapters/ — integration policy and provider notes
- tests/ — unit tests and activity acceptance cases

## Core rule
**A planned action is not a generated result. A generated result is not a passed QC check.** No Flow automation, image/video generation, media inspection, or automatic visual QC is implemented yet.


### Google Flow planning fields

The browser prototype can record per-scene 8s/10s Flow clip settings, pose and face reference identifiers for Ingredients, separate 360p test and 720p final URIs, subtitles/breathing cues, movement benefits, and edit/watermark notes. It also records pre-publication approval and whether an AI label is required. These fields are planning metadata only: GoGlow does not connect to Flow, upload reference images, generate clips, remove watermarks, or assemble/edit video. Verify model names and credit estimates directly in Flow.

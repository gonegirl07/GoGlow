# GoGlow

**AI Character Video Director & multi-model production pipeline**

GoGlow helps plan, prompt, track, and quality-review short-form AI character videos. The first target workflow is Google Flow; the core is provider-agnostic so additional models and coding agents can contribute.

## Goals

- Produce vertical **9:16** videos with a target duration above 30 seconds (default planning target: **36 seconds**).
- Preserve character identity, wardrobe, props, screen direction, and scene-to-scene continuity.
- Support dance, cycling, yoga, fashion, and extensible future activities.
- Create scene-specific prompts and reference-image briefs.
- Track actual generation and review states without pretending a model was called or a video was inspected.
- Keep capability claims evidence-based and distinguish manual steps from verified automation.

## Status

This is a specification-first scaffold. It does **not** yet call Google Flow, Nano Banana, or a video-generation model through an API.

“Omni 1.1 Flash” and “Nano Banana Pro 2.1” are working labels supplied by the project owner. Confirm exact labels and options in the live Flow selector before relying on them.

## Repository map

- `AGENTS.md` — instructions and safety rules for coding agents
- `docs/` — architecture, workflow, capability verification, decisions
- `specs/` — JSON Schemas for character profiles, scene plans, QC reports
- `prompts/` — director and activity-specific prompt templates
- `adapters/` — verified-integration policy and provider notes
- `tests/` — reproducible test cases for cycling, yoga, dance, fashion
- `CHANGELOG.md` — project changes

## Start here

1. Read [AGENTS.md](AGENTS.md) before contributing.
2. Read [architecture](docs/architecture.md), [workflow](docs/workflow.md), and [model capability policy](docs/model-capabilities.md).
3. Review the schemas in `specs/`.
4. Use prompt templates in `prompts/` as starting points, not guarantees of model behavior.
5. Record exact prompts, settings, observed output, defects, and review outcomes in test cases.

## Core rule

**A planned action is not a generated result. A generated result is not a passed QC check.** Each state transition must be supported by an actual action or review.

## Next milestone

Build a small local planner/validator that can read a project brief, create a structured scene plan, validate required fields and total scene duration, and export prompts as Markdown/JSON before considering model integrations.

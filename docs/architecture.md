# Architecture

GoGlow is a production-planning and QC layer, not a claim of direct access to generation models.

## Modules
1. Project settings: aspect ratio, target runtime, activity, setting, wardrobe, output intent.
2. Character registry: identity anchors, wardrobe variants, reference asset roles.
3. Scene planner: duration, start/end state, one primary action, motion, camera, environment.
4. Prompt builder: deterministic assembly from structured fields and activity rules.
5. Continuity ledger: state carried across adjacent scenes.
6. Production tracker: truthful status transitions.
7. QC assistant: review checklist and targeted revision brief. Automatic vision review requires an actual media-input/vision interface.
8. Export: Markdown/JSON production packet and assembly notes.
9. Provider adapters: only after interfaces and capabilities are verified.

## Data flow
Brief + Character + Activity → Scene Plan → Prompt/Reference Brief → manual or verified generation → media attached → QC review → approved export.

## Principles
- Model-agnostic core.
- Evidence-backed adapters with verification date, source, limitations, and tests.
- Reproducible experiments: exact prompt, model label, settings, references, observed defects.
- Each scene has an explicit initial state, one dominant action, and a clear end state.
- No silent status changes.

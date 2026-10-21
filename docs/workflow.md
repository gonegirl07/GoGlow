# Production workflow

## Default preset
- Aspect ratio: 9:16
- Planned runtime: 36 seconds
- Activities: dance, cycling, yoga, fashion; extensible
- Model labels: record exact labels visible in the current UI
- Output: scene plan, prompts, reference briefs, continuity ledger, QC checklist, assembly plan

## Steps
1. Set up the character and identity anchors using user-provided references.
2. Set activity, environment, wardrobe, mood, target runtime, and aspect ratio.
3. Break runtime into coherent scenes. Each scene needs one dominant action, start pose, direction/timing, camera plan, and end pose.
4. Build a prompt per scene and image briefs only where useful.
5. Label reference roles: identity, wardrobe, pose, first frame, last frame, scene, or prop.
6. Generate through the current Flow UI manually unless a supported integration has been implemented and tested.
7. Review actual output for identity, anatomy, action, physics, continuity, camera, artifacts, format, and duration.
8. Write a narrow revision prompt for observed defects.
9. Assemble approved clips and verify total runtime, trims, gaps, overlaps, and transitions.

## State machine
PLANNED → PROMPT_READY → WAITING_FOR_GENERATION → GENERATED → QC_REVIEW → APPROVED.
Failures may transition to NEEDS_REVISION → PROMPT_REVISED → WAITING_FOR_GENERATION. Use BLOCKED when a required asset, capability, or decision is missing. Leaving BLOCKED is restricted to PLANNED or PROMPT_READY and invalidates all previous media/QC evidence. Deleting a media URI from GENERATED or QC_REVIEW returns the scene to WAITING_FOR_GENERATION. Target duration must be at least 30 seconds; unsupported values are rejected, not silently clamped.

A copied prompt is not a generated result. A checklist is not a QC pass.

## Evidence gates

- Each scene records `status_history`; every adjacent pair must be a permitted transition in `src/goglow/validator.py`.
- `GENERATED`, `QC_REVIEW`, and `APPROVED` require a non-empty `media_uri`. This is a manual declaration only; it does not prove that a file exists or is playable.
- `APPROVED` additionally requires a structured `qc_report` with `review_status: PASS`, human reviewer, review timestamp, and checks. A URI alone can never satisfy the approval gate.
- The browser prototype now supports manual media declaration and structured human-QC reports. It offers `GENERATED` only after a media URI is entered, `QC_REVIEW` only with media declared, `APPROVED` only after a matching QC `PASS` report with reviewer/time and all checks marked `PASS`, and `NEEDS_REVISION` only after a `FAIL` report with a revision prompt.
- Even a structurally valid QC report is user-supplied evidence, not automatic video verification. GoGlow M1 does not prove URI accessibility or that a reviewer actually watched the clip.

## QC mapping (canonical source)

The mapping from QC report results (`PASS`, `REVIEW`, `FAIL`,
`NOT_REVIEWED` in `specs/qc-report.schema.json`) to the workflow
states above is defined in `docs/media-qc-protocol.md`, Section 2.3.
That section is the canonical mapping for media review; this workflow
document does not restate it, so the two cannot drift apart.

## Duration
Scene durations must sum to the target runtime. This is a planning constraint, not a guarantee that one model request supports the full runtime.


## Google Flow scene settings

Each scene can record the selected Flow clip length (8 or 10 seconds), separate pose and face/identity references for the Ingredients workflow, and separate 360p test and 720p final media URIs. Choose the relevant URI when performing QC so the saved report remains bound to the exact clip under review. Subtitle/breathing cues, movement-benefit copy, music direction, hard-cut preference, watermark review, pre-publication approval, and AI-label requirements are planning records only; GoGlow does not operate Flow or perform video editing.

Credit estimates shown in the UI (about 6 for 360p/8s and 15 for 720p/10s) are user-provided estimates, not verified provider pricing. Confirm actual cost and model availability in Flow.

Clip durations are allocated as exact 8-second or 10-second Flow requests. For example, 36 seconds across four scenes becomes 8+8+10+10; 30 seconds across three scenes becomes 10+10+10. If a target/count combination cannot be represented by 8s/10s clips, the planner rejects it with an actionable error rather than silently generating 9-second scenes.

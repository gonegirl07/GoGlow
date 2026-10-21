# GoGlow Multi-Agent Work Plan

## Purpose

Use multiple AI assistants in parallel without merging conflicting assumptions or unreviewed code. The repository owner coordinates external assistants; ChatGPT acts as integration lead in this workflow.

## Current baseline

- Python planner, validator, Markdown exporter, CLI and automated tests exist.
- `app/index.html` is a zero-install browser prototype.
- The app is a planner, not a Google Flow integration. It does not generate videos or perform visual QC.
- Treat model names, model capabilities, Flow UI behavior, and image-reference behavior as unverified unless accompanied by current evidence.

## Work ownership (avoid overlapping edits)

| Assistant | Primary role | Assigned deliverable | Do not change |
|---|---|---|---|
| ChatGPT | Tech lead / integrator | Architecture, integration, shared schemas, implementation coordination, final review | Do not claim a feature is tested unless it was tested |
| Gemini | UI/UX designer | `docs/ui-ux-spec.md`: user journeys, screen states, form fields, empty/error/loading states, responsive layout and acceptance criteria | Do not edit `app/index.html`, Python code, or shared schemas in the design phase |
| Grok | Independent QA / adversarial reviewer | `docs/qa-acceptance.md`: edge cases, acceptance tests and review checklist for cycling/yoga/dance/fashion | Do not rewrite implementation; report reproducible findings and severity |
| Muse.ai | Media workflow / QC protocol reviewer | `docs/media-qc-protocol.md`: a human-review protocol for generated clips and continuity across scenes; clearly state what media access/features were actually available | Do not claim to inspect clips unless clips were actually supplied and accessible; do not edit application code |

These roles are based on the requested workflow, not a claim that any service is already connected to this repository. If Muse.ai cannot inspect or reason about supplied clips in the user's current setup, ask it to produce a protocol and rubric only.

## Task boundaries

1. Each assistant works on its own named document or isolated branch.
2. Do not have two assistants edit the same file concurrently.
3. Never give an assistant secrets, cookies, session tokens, or account access.
4. Prefer a pull request from a separate branch. If an assistant cannot create a branch/PR, ask for a unified diff or complete file and its test instructions; the integration lead reviews it before applying.
5. Never let an assistant directly overwrite `main` without review.
6. A report is not evidence of a passing test. Include commands, inputs, expected output, actual output, and logs where possible.
7. For Flow/model claims, include a dated source, screenshot, or repeatable observation. Label unknowns as unknown.

## Copy-paste assignment: Gemini

You are GoGlow's UI/UX design contributor. Read `README.md`, `AGENTS.md`, `docs/architecture.md`, and the existing `app/index.html` before proposing changes.

Create only `docs/ui-ux-spec.md`. Do not edit application code or shared schemas. Design a practical UI for a local-first AI-character video planning tool. It must cover:
- project list / create / reopen;
- character profiles and multiple reference images, with asset privacy and identity anchors;
- activity, target duration (>30 seconds), aspect ratio (9:16 default), brief, wardrobe, location and camera;
- scene cards with start state, one primary action, end state, direction/speed, body mechanics, camera and editable prompt;
- continuity between adjacent scenes;
- status distinctions between planned, prompt-ready, attempted, generated, reviewed and approved;
- export JSON/Markdown;
- loading, empty, validation-error, unsaved-change and mobile states;
- keyboard/accessibility basics and concrete acceptance criteria.

Do not invent direct Google Flow automation. Mark integrations as future work unless supported by verified evidence. Return the document and a short rationale; do not claim browser testing unless you performed it.

## Copy-paste assignment: Grok

You are GoGlow's independent adversarial QA reviewer. Read `AGENTS.md`, `README.md`, `docs/architecture.md`, `src/goglow/planner.py`, `src/goglow/validator.py`, `src/goglow/exporter.py`, `tests/test_planner.py`, and `app/index.html`.

Create only `docs/qa-acceptance.md`. Do not edit implementation. Look for concrete failures and missing tests around:
- cycling direction, speed, pedaling, hand/foot contact, road/lane consistency and scene transitions;
- yoga anatomy, balance, support points and pose transitions;
- dance rhythm, footing and unrequested direction changes;
- fashion identity, wardrobe and accessories;
- duration allocation and sum, invalid/non-finite values, missing fields, duplicate IDs, malformed JSON;
- unsafe status transitions and false claims of generation/QC;
- browser prototype persistence, exports, user edits, reference-image privacy and error handling.

For each finding give severity (P0-P3), affected file/behavior, minimal reproduction, expected vs actual behavior (only if observed), proposed test and suggested fix. Clearly distinguish observed defects from hypothetical risks. Do not claim execution unless you actually executed the relevant code.

## Copy-paste assignment: Muse.ai

You are GoGlow's media workflow and QC protocol contributor. Read `AGENTS.md`, `README.md`, `docs/architecture.md`, and `docs/workflow.md`.

Create only `docs/media-qc-protocol.md`. Focus on a human-usable, repeatable review procedure for AI-generated character clips and sequences. Include:
- per-clip review checklist for identity, wardrobe, anatomy, object contact, movement physics, screen direction, camera, background and artifacts;
- activity-specific criteria for cycling, yoga, dance and fashion;
- scene-to-scene continuity ledger and how to record a defect with timestamp;
- severity levels and pass/revise/reject decision rules;
- a compact issue-report template linking prompt, reference IDs, model label/settings and observed defect;
- clear limits: separate observed evidence from inference, and never mark a clip reviewed unless the clip was accessible and actually reviewed.

First state which video/media input capabilities you actually have in this session. If you cannot access supplied media or inspect video, do not simulate inspection; provide the protocol and rubric only. Do not edit app code.

## Integration and review gate

For every contribution:
1. Check the diff for scope, secrets, invented capability claims, and overlap with other work.
2. Verify links, JSON examples, schema consistency and terminology.
3. For code, run the documented tests and inspect CI. If unable to run them, say so.
4. Ask a different assistant to review the contribution without letting it rewrite the same files.
5. Resolve blocking findings before merging.
6. Record merge commit, tests run, unresolved findings, and manual steps in the PR description or changelog.

## Review matrix

| Artifact owner | Reviewer | Review focus |
|---|---|---|
| Gemini UI spec | Grok | Missing states, ambiguous acceptance criteria, unsafe/false integration assumptions |
| Grok QA spec | ChatGPT | Reproducibility, priority, alignment with actual code |
| Muse media-QC protocol | Gemini | Usability and clarity for a human operator |
| ChatGPT implementation | Grok + Gemini | Logic/edge cases plus UI/UX fit |

Do not ask an assistant to rubber-stamp its own output. A review should produce findings, not only a general approval.

## Suggested order

1. In parallel: Gemini writes UI spec, Grok writes QA acceptance spec, Muse.ai writes media-QC protocol.
2. Collect each result as a separate file or PR; do not merge yet.
3. Cross-review the documents using the matrix above.
4. ChatGPT reconciles overlaps, updates the roadmap, then implements the highest-priority changes.
5. Run CI and manually exercise the browser prototype before calling the milestone complete.

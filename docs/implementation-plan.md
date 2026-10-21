# GoGlow M1 integration and implementation plan

This plan integrates the three agent deliverables without treating a specification as an implemented or tested feature.

## Sources of truth

- `docs/qa-acceptance.md` (Grok): software QA findings and priority. P0 is the status/evidence gate; P2 covers browser/Python consistency, duration export validation, and negative tests.
- `docs/media-qc-protocol.md` (Muse): human review protocol for actual clips, media defect severity (`BLOCKER`, `MAJOR`, `MINOR`, `NOTE`), QC report outcomes, and the canonical mapping in Section 2.3.
- `docs/ui-ux-spec.md` (Gemini): intended UI behavior, manual declaration versus verified media, strict duration export blocking, and acceptance criteria.
- `docs/workflow.md`, `specs/scene-plan.schema.json`, and `specs/qc-report.schema.json`: workflow and data contracts.

Software QA severity (`P0`–`P3`) is not the media defect severity scale. A declared `media_uri` is a user-supplied reference, not proof that a file exists or is playable. GoGlow does not perform automatic video verification or visual QC.

## Delivery sequence

### Phase 1 — P0: prevent unsupported status claims

- Add an explicit `status_history` to scenes and validate each transition against the documented workflow.
- Require non-empty `media_uri` for `GENERATED`, `QC_REVIEW`, and `APPROVED`.
- Require a structured QC report with `PASS`, checks, reviewer, and review timestamp before `APPROVED`.
- Add browser media declaration and structured human-QC entry; gate workflow transitions and approval on matching evidence.
- Add regression tests for fabricated URI without QC evidence, failed QC report, skipped transitions, and valid approval evidence.

**Limit:** Evidence fields are still declarations supplied by a person or file. They reduce accidental false claims but cannot prove a URI is accessible or that a human actually watched a clip. That requires media access and a tested verification workflow.

### Phase 2 — P2: align browser and Python data contracts

- Lock the browser prototype to the currently supported `9:16` aspect ratio.
- Block JSON and Markdown exports when scene durations do not equal the target; no override.
- Check required fields, duplicate scene IDs, and QC checklist presence before browser export.
- Serialize status history and activity-specific QC checklist in browser-generated plans.
- Align the scene schema with fields already emitted by the browser prototype, including project metadata and the reference-image note; do not export image bytes.

### Phase 3 — P2/P3: verification and hardening

- Run the Python test suite and CI across supported Python versions.
- Validate representative browser JSON against the scene-plan schema and Python validator.
- Manually exercise the browser prototype: duration mismatch/repair, invalid statuses, export buttons, localStorage restore failure, and reference-image privacy.
- Add malformed-input tests and activity-constraint lint warnings (warnings only; keyword checks cannot establish physical correctness).

### Phase 4 — later work, not part of this patch

- Add an explicit clip-access/playback verification workflow; current media URIs are manual declarations only.
- Improve activity-specific defect entry, timestamped defect reports, and assembled-sequence QC.
- Consider visual QC or Google Flow integration only after the media-input/provider interface and its capabilities can be tested.
- Add project import, stronger persistence, continuity editing, and UI polish after the P0/P2 acceptance gates are reliable.

## Acceptance gate for this patch

- [ ] A direct `PLANNED → APPROVED` history is rejected.
- [ ] `APPROVED` with only a fabricated/non-empty URI is rejected.
- [ ] `APPROVED` requires a PASS QC report, reviewer, timestamp, and checks.
- [ ] The browser does not offer unsupported generation/QC/approval status transitions.
- [ ] The browser blocks exports on duration mismatch and required-field errors.
- [ ] Scene schema describes the project fields and evidence fields that the implementations emit.
- [ ] Automated CI passes; browser manual checks are reported separately and never claimed unless run.

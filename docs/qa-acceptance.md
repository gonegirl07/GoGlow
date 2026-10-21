# GoGlow QA Acceptance Spec

Independent adversarial review of the M1 local planner, validator, exporter, and browser prototype.

**Review method:** Static code review of the files listed in the multi-agent work plan assignment. No tests were executed and no browser was opened in this session. Findings labeled "observed" come from reading the source. Findings labeled "hypothetical risk" are risks that the current code does not prevent but that were not observed to fail in a running system.

**Scope boundary:** This document does not rewrite implementation. It reports findings, severity, minimal reproduction (from code), proposed tests, and suggested fixes.

## Severity scale

- **P0** — Blocks correct planning or can produce a false claim of generation/QC that would mislead a human operator.
- **P1** — High likelihood of incorrect plans, broken continuity, or silent invalid states reaching export.
- **P2** — Usable but incomplete checks, inconsistent constraints between Python and browser, or missing negative tests.
- **P3** — Polish, documentation, or low-probability edge cases.

## Summary of coverage

Existing tests in `tests/test_planner.py` cover:

- Default 36 s duration sum and validation success.
- Uneven duration distribution.
- Rejection of duration < 31 and unknown activity.
- Duplicate scene IDs.
- Duration total mismatch.
- `GENERATED` status without `media_uri`.
- Malformed activity/status types.
- Non-finite duration.
- Markdown export contains prompt and disclaimer.

The planner and browser prototype supply strong activity-specific starter text for cycling, yoga, dance, and fashion. The gaps are mainly in validation depth, status-machine enforcement, and consistency between the Python CLI and the browser prototype.

## Findings

### 1. Browser prototype allows aspect ratios other than 9:16; Python validator rejects them

- **Severity:** P2
- **Type:** Observed (code)
- **Affected:** `app/index.html` (ratio `<select>`), `src/goglow/validator.py` (hard-coded check), `docs/workflow.md`
- **Minimal reproduction (static):**
  1. In the browser prototype set aspect ratio to `16:9` or `1:1`.
  2. Build a plan and export JSON.
  3. Run `goglow validate` on the exported file.
- **Expected:** Either the browser is constrained to 9:16 (matching the validator and documented default) or the validator accepts the values the browser can emit, with a clear warning that non-9:16 is untested for the current Flow target.
- **Actual (from code):** Browser emits other ratios; validator returns `aspect_ratio must be '9:16'`.
- **Proposed test:** Export a project with each non-9:16 ratio from the browser (or construct the JSON) and assert the validator error. Also assert that a 9:16 project validates.
- **Suggested fix:** Remove the non-9:16 options from the browser select for M1, or relax the validator and document the deviation.

### 2. Status machine allows unsafe transitions and false generation/QC claims

- **Severity:** P1
- **Type:** Observed (code)
- **Affected:** `src/goglow/validator.py` (`VALID_STATUSES` and media_uri check), `app/index.html` (status `<select>`), `docs/workflow.md` state machine
- **Minimal reproduction (static):**
  1. Create a project with `create_project`.
  2. Set `scenes[0].status = "APPROVED"` and `scenes[0].media_uri = "file:///fake.mp4"` (or any non-empty string).
  3. Call `validate_project`.
  4. In the browser, select status `GENERATED` or `APPROVED` on a scene that has no media.
- **Expected:** Status transitions follow the documented machine (`PLANNED → PROMPT_READY → …`). `GENERATED`, `QC_REVIEW`, and `APPROVED` require actual media that was reviewed. A prompt or a fabricated URI is not sufficient.
- **Actual (from code):** Validator only requires the presence of a `media_uri` key for those three statuses; any string passes. No ordering check exists. Browser UI offers `GENERATED` and `APPROVED` with no media field.
- **Proposed test:**
  - Project with status `APPROVED` and no `media_uri` → error.
  - Project with status `APPROVED` and a non-empty `media_uri` but no prior `GENERATED`/`QC_REVIEW` evidence → currently passes (document as gap).
  - Browser does not offer generation/QC statuses without an explicit media attachment step.
- **Suggested fix:** Add a transition table in the validator (or a separate `check_status_transitions` function). Require a non-empty `media_uri` *and* a `media_reviewed: true` flag (or equivalent) before `QC_REVIEW`/`APPROVED`. Remove or disable generation/QC options in the browser until a media attachment UI exists. Align the browser select with the full `VALID_STATUSES` set (or document the subset).

### 3. Duration sum is validated only after export; browser allows silent mismatch

- **Severity:** P2
- **Type:** Observed (code)
- **Affected:** `app/index.html` (editable duration inputs, no live sum check), `src/goglow/validator.py`
- **Minimal reproduction (static):**
  1. Build a 36 s / 4-scene plan in the browser.
  2. Change the first scene duration to 20 and leave the others at 9.
  3. Export JSON (no error shown).
  4. Run `goglow validate`.
- **Expected:** UI shows a running total and a clear warning when the sum diverges from the target, or blocks export until the sum matches.
- **Actual (from code):** Stats line shows the sum, but no validation message or block. Validator correctly rejects the mismatch.
- **Proposed test:** Construct a project whose scene durations sum to target ± 0.001 and assert pass/fail. In a browser test (manual or automated) confirm the lack of blocking feedback.
- **Suggested fix:** After any duration edit, compare the sum to `target_duration_seconds` and surface a warning. Optionally disable the JSON/Markdown export buttons while the sum is wrong.

### 4. Activity-specific physical constraints are present in starter text but not enforced

- **Severity:** P2
- **Type:** Hypothetical risk (code supplies the text; no validation of its presence after user edit)
- **Affected:** `src/goglow/planner.py` (`_ACTIVITY_BEATS`, `_qc_for`), `app/index.html` (`beats` object), user-editable fields
- **Minimal reproduction (static):** Create a cycling plan, then clear or rewrite `body_mechanics` / `prompt` so that "pedaling", "hand contact", or "same lane" disappears. Validator still accepts the project.
- **Expected:** For the four target activities the critical physical constraints remain visible or are re-injected on prompt refresh; a human reviewer is warned when they are removed.
- **Actual (from code):** Starter text is good (cycling mentions pedaling, hand/foot contact, lane consistency; yoga mentions support points and balance; dance mentions rhythm and footing; fashion mentions wardrobe and accessories). After edit there is no check.
- **Proposed tests (examples):**
  - Cycling: after `create_project("cycling")`, assert each scene prompt or `body_mechanics` contains at least one of "pedal", "handlebar", "lane", "direction".
  - Yoga: assert presence of "support", "balance", or "pose".
  - Dance: assert "foot", "rhythm", or "facing".
  - Fashion: assert "outfit", "accessory", or "wardrobe".
  - Negative: a project that has had those phrases deleted still validates (document the gap).
- **Suggested fix:** Keep the current starter approach. Add optional "constraint presence" warnings (not hard errors) in the validator or a separate lint step. In the browser, offer a "restore activity constraints" button that re-applies the relevant beat text.

### 5. Missing negative tests for malformed JSON, non-finite target duration, and empty required strings

- **Severity:** P2
- **Type:** Observed gap in test suite
- **Affected:** `tests/test_planner.py`, `src/goglow/validator.py`
- **Minimal reproduction:** The existing tests cover NaN duration and list-typed activity/status. They do not cover:
  - `target_duration_seconds` as float, bool, or NaN.
  - Completely missing `scenes` key or empty scenes array.
  - Scene with empty-string `start_state` / `prompt`.
  - Duplicate IDs that are whitespace-only or non-string.
  - Root that is not a dict.
- **Expected:** Validator returns specific errors for each case; tests lock the behavior.
- **Actual:** Validator logic handles most of these (from reading the code), but they are not asserted.
- **Proposed test:** Add parametrized cases for the list above and assert the exact error substring.
- **Suggested fix:** Extend `test_planner.py` (or add `test_validator.py`).

### 6. Browser prototype reference-image privacy is correctly limited (positive finding)

- **Severity:** n/a (no defect)
- **Type:** Observed (code)
- **Affected:** `app/index.html`
- **Behavior:** File inputs create object URLs for in-session preview only. `localStorage` save and JSON/Markdown exports contain only a note (`"Preview only; image data not included in export."`). Object URLs are revoked on new file selection. Restore from localStorage does not attempt to re-create previews.
- **Expected / Actual:** Matches the privacy requirement in the assignment and README. No image bytes leave the browser session.
- **Proposed test (manual):** Select images, save, export JSON, reload the page. Confirm previews are gone and the JSON contains no base64 or blob data.

### 7. Browser error handling and persistence edge cases

- **Severity:** P3
- **Type:** Observed (code) / low risk
- **Affected:** `app/index.html`
- **Details:**
  - `localStorage` write is wrapped in try/catch and falls back to a status message (good).
  - Clipboard write has a catch (good).
  - Duration and scene-count inputs are clamped with `Math.max`/`Math.min` (good).
  - No handling for a corrupt `localStorage` value beyond the outer try/catch that silently skips restore.
  - "New project" confirms but does not force an export; a user can lose unsaved edits (acceptable for a prototype, should be documented).
- **Proposed test:** Manual: fill localStorage with invalid JSON, reload, confirm no crash. Fill a plan, click New without exporting, confirm data is cleared.
- **Suggested fix:** Show a non-blocking warning when restore fails. Optional: auto-export reminder when the user clicks New with unsaved changes.

## Activity-specific acceptance checklist (for human reviewers and future tests)

These are the concrete checks the assignment asked for. The current starter text already addresses most of them; the checklist is for post-generation QC (when media exists) and for regression tests of the planner.

### Cycling
- Direction and screen motion consistent across adjacent scenes (no unrequested reverse or side-slide).
- Speed and cadence plausible; no instantaneous teleport.
- Continuous pedaling; feet stay on pedals.
- Hands stay on handlebars.
- Road/lane identity preserved; no abrupt lane changes.
- Background motion agrees with travel direction and camera tracking.

### Yoga
- Anatomy plausible (joint angles, no extra limbs).
- Balance and support points match the named pose.
- Slow, deliberate transitions; no morphing between poses.
- Full body and mat remain in frame.
- Left/right limb placement intentional and consistent.

### Dance
- Footwork and weight transfer readable and match an implied beat.
- No unrequested spins, jumps, or facing flips.
- Feet do not slide.
- Stage position and facing continuous between scenes.

### Fashion
- Character identity stable.
- Wardrobe cut, color, and accessories unchanged unless explicitly requested.
- Framing shows the required garment details.
- No fabric melting, clipping, or unexplained accessory appearance/disappearance.

## Recommended next tests (priority order)

1. Status + media_uri negative cases (P1).
2. Aspect-ratio consistency between browser export and validator (P2).
3. Duration-sum UI feedback or export guard (P2).
4. Activity-constraint presence assertions on fresh plans (P2).
5. Additional malformed-JSON cases (P2).
6. Manual browser privacy and persistence smoke test (P3).

## Notes on execution

This review did not run `python -m pytest`, did not open `app/index.html` in a browser, and did not generate or inspect any media. All statements about runtime behavior are inferred from the source. The integration lead should execute the existing test suite and a manual browser pass before treating any item as closed.

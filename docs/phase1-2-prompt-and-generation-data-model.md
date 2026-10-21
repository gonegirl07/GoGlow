## Mandatory English-only prompt output

- Every prompt composed for Google Flow must be English-only, including the project brief when included, activity/start/action/end/body-mechanics defaults, wardrobe/location/environment, and reference instructions.
- The UI may remain Vietnamese. The validator applies to prompt text, not UI labels or explanatory messages.
- The prompt runtime enforces ASCII-only Flow prompt payloads (ASCII tabs and line breaks are permitted); it rejects accented letters, combining marks, fullwidth characters, and emoji. ASCII-only validation cannot identify Vietnamese words written without diacritics, so source fields still require human review. Apply, copy-to-Flow, Markdown export, and JSON export are blocked when a prompt/preview contains those characters. Export also validates the project brief because it is injected into composed prompts.
- Do not silently translate or delete user content. Show the offending source field and character positions and ask the user to rewrite the source field in English.
- All built-in action templates and the default project brief/environment must be English.

# Phase 1–2 data model: prompt rules and generation ledger

## Status and scope

The schema/seed section records the accepted data contract. Phase 1 is implemented in the browser prompt library. Phase 2 runtime logging is being implemented in a separate PR and remains manual: GoGlow does not call Google Flow or infer provider credit usage.

## Design principles

1. **Append-only attempts:** every generation attempt is a new record. Never overwrite a failed attempt with a retry.
2. **Evidence before confidence:** store the observed result, QC checklist, prompt, configuration, and evidence source. A rule's `confirmed` label means owner/tester accepted it for its explicit scope; it is not a universal success guarantee.
3. **No invented data:** unknown credit charge, provider error code, timestamps, or prompt text stay unknown/null. Never infer that Flow charged or refunded credits.
4. **Prompt reproducibility:** retain exact prompt text and rule IDs/version used for every attempt. Hashes are optional until computed by the implementation.
5. **Narrow applicability:** rules can scope activity, pose, character, model label, aspect ratio, duration, and resolution. Do not apply a Warrior II hold rule to a dynamic transition by default.
6. **Human QC remains authoritative:** automated workflow state or a successful generation response is not visual QC.
7. **Provider-neutral records:** `provider` identifies Flow/API/other, but no unsupported provider integration is implied.
8. **Privacy/security:** no cookies, API keys, session tokens, or credentials in prompts, logs, fixtures, or evidence.

## Files

- `specs/prompt-rule.schema.json`: versioned reusable rules, scope, positive/avoid instructions, provenance, and evidence.
- `specs/generation-attempt.schema.json`: one record per attempt, including configuration, exact prompt, rules used, result/failure, credit evidence, media reference, and human QC.
- `examples/prompt-rules.seed.json`: first seed rule and its supporting/counterexample evidence.
- `examples/generation-attempts.seed.json`: two earlier failures plus the successful stable-hold attempt.
- `specs/prompt-library.schema.json` and `examples/prompt-library.seed.json`: reusable fixed prompt block, evidence-labeled do/don't rules, motion risk catalog, warning policy, and generation log sample.

## First seed rule

`yoga.warrior-ii.stable-hold-breathe@1` is marked `confirmed` because the project owner reports a real Flow clip passing QC 7/7. It is deliberately scoped to Yoga / Warrior II / Mai / Omni 1.1 Flash / 9:16 / 360p / 8 seconds with `warrior-still-v4` and `mai-face` references.

The successful prompt is stored verbatim. Two preceding failure records preserve the known failure pattern (knee-bend/transition strategy, rear-foot slide reported around 20–40 px, hand/fingertip crop). The exact earlier prompts and per-attempt timings were not provided; the seed explicitly says so rather than inventing them. Their credit charges are unknown.

The Flow URL is an edit/project URL supplied by the user. It is not represented as a verified direct-download URI or a local media file.

## Implementation plan after design approval

### Phase 1 implementation PR — Prompt rule library
- Load and validate rule records.
- Compose applicable rules deterministically with explicit ordering and conflict warnings.
- Show source rule IDs/version and allow preview before applying to a scene.
- Keep rule status/provenance visible; no silent auto-promotion from candidate to confirmed.
- Test the stable-hold rule and its narrow scope; prove dynamic Warrior II transitions do not inherit it accidentally.

### Phase 2 implementation PR — Generation ledger
- Provide a per-scene manual ledger panel backed by a project-level append-only ledger for recording each completed/failed Flow attempt; it does not start a generation.
- Append an attempt record with a unique ID and attempt number; let the user choose whether it is a new attempt or a retry, and set `retry_of` only for an explicitly selected retry.
- Capture exact prompt, model/resolution/duration/aspect ratio, reference IDs, rule IDs, result/failure details, media URI, and a snapshot of QC known at log time.
- Credit estimate and actual charge are separate fields. Actual amount, charge status, and evidence source remain unknown unless the user records observed evidence.
- Include attempt history in JSON and Markdown project exports. The browser's saved project keeps records in the current browser profile; users should export JSON for backup.
- Alternative prompt suggestions remain drafts and are not silently applied.

## Acceptance criteria for this design PR

- Both JSON Schemas parse as JSON and describe required fields and enums.
- Seed JSON parses and each record includes provenance/limitations for missing source details.
- Successful prompt matches the user-provided prompt exactly.
- Success record contains the user-reported 7/7, 0 px rear-foot slide, hands in frame, visible breathing, model/resolution/duration/aspect ratio and both reference IDs.
- Two failures are represented separately; no invented exact prompt, generation timestamp, credit amount, direct media URL, or provider error code.
- No runtime behavior is changed by this PR.

## X guidance and Mai test findings incorporated

The prompt library seed incorporates the owner's supplied X summary and Mai Flow tests:
- Fixed prompt sections: identity, explicit covered outfit, room, camera/framing, real-time quality, safety; then action, immobility locks, ending state, avoid constraints.
- Confirmed stable-hold rule: start already in pose; Warrior II evidence is scoped to the reported Omni 1.1 Flash / 9:16 / 360p / 8s test and its two Ingredients.
- Reported motion examples: Mountain arm sweep and Tree overhead prayer (360p passes); seated breathing with hands kept in lap; slow chest-up head turn.
- Candidate/risky items remain warnings, not universal claims: weight-shifting transitions, neck side bend, ambiguous shoulder-roll/shrug wording, time-coded phases for static poses, platform names.
- Matching `blockIfMatch` terms produce warnings only in this seed; they do not hard-block a prompt. Prompt-length threshold is provisional (1200 characters), warning-only, and must be tuned from recorded attempts.
- The successful Warrior II log uses an estimated 6 credits as an owner estimate only; actual charge remains unknown. The two failed clips have unknown credit amounts.

These are seed records, not runtime behavior. The implementation PR must prove deterministic rule composition, scope checks, preview-before-apply, and warnings without silently deleting or rewriting the user's prompt.


## Phase 1 runtime PR — current implementation

The first runtime slice is implemented in app/prompt-library.js and the scene panel in app/index.html.

- The runtime adapter exposes deterministic analysis/composition and a version (1.0); it does not call Google Flow or perform network requests.
- The scene panel displays matched rule IDs/statuses and non-blocking warnings, including candidate warnings for time-coded static poses, shoulder-roll/shrug wording, platform branding, and prompt length.
- Prompt composition creates a separate preview. The current scene prompt is unchanged until the user explicitly clicks “Áp dụng preview vào prompt”.
- Outfit and room/environment fallback text is filled before preview; duplicate sentences are removed. The project brief is not injected into the English prompt, and the Yoga defaults use concise English static-hold instructions rather than a weight-shifting transition.
- Candidate rules do not auto-append. The real-time candidate can only be included through an unchecked opt-in in the preview UI. Confirmed stable-hold text is available only when the narrow Warrior II scope matches: character Mai, Yoga, Warrior II, Omni 1.1 Flash, 9:16, 8 seconds, and both named reference identifiers.
- Applying a preview clears the current/360p/720p media URIs and old QC report so the old clip cannot be approved against a changed prompt. APPROVED, GENERATED, and QC_REVIEW return to WAITING_FOR_GENERATION; NEEDS_REVISION becomes PROMPT_REVISED.
- A preview records a snapshot of its source fields/settings; changing a scene field, project setting, or rule option clears the stale preview immediately and requires regeneration.
- Applied rule IDs and warning rule IDs are shown separately; each list is deduplicated. Only rules actually appended to the preview appear under applied rules.
- Re-applying the library to an already composed prompt reuses the original source prompt rather than nesting the previous composed output under “Existing prompt details”.
- The preview panel is advisory and never blocks generation/export. Human review of the actual Flow clip remains required.

### Follow-ups retained from tester round 7

- Keep the DevTools QC-state hardening and optional favicon cleanup in the backlog; neither is part of the prompt-library runtime.
- Keep generation result and QC result separate in the future ledger UI (result.status=succeeded can coexist with qc.status=fail).
- Standardize unknown-credit vocabulary in the ledger/motion evidence before implementing the Phase 2 UI.
- Do not treat a seed rule or a single 7/7 clip as a universal guarantee.

### Phase 1 tester acceptance

1. Run the Python suite on 3.10, 3.11, and 3.12.
2. Open app/index.html in real Chrome; confirm the prompt library panel appears for each scene and candidate warnings are visible when their trigger phrases are present.
3. Confirm creating a preview does not change the original prompt; only the explicit Apply action changes it.
4. Confirm no candidate rule is added unless explicitly selected before preview; candidate defaults are unchecked.
5. Confirm wardrobe/environment placeholders are filled and duplicate lines are removed.
6. Confirm the stable-hold rule is not appended unless the exact narrow Warrior II scope matches.
7. Confirm applying a preview clears old media URIs and QC evidence; APPROVED/GENERATED/QC_REVIEW return to WAITING_FOR_GENERATION and NEEDS_REVISION returns to PROMPT_REVISED.
11. Confirm stale previews cannot be applied if a change bypasses immediate invalidation; create a new preview first.
9. Confirm warnings are non-blocking and the existing QC/export/state-machine regressions still pass.
13. Add Vietnamese text/diacritics to brief, action, environment, and an existing prompt; confirm Apply, copy, and both exports are blocked with a clear warning. Confirm English-only defaults pass.
14. Confirm no browser console/page errors and no request is made to Google Flow.

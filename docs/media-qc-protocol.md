# GoGlow Media QC Protocol

## 0. Media capabilities in this authoring session — read first

This document is a **protocol and rubric only**. It is not a QC report for any clip.

- **Authoring session:** 2026-10-21, written by Muse (Meow) as the media workflow / QC
  protocol contributor assigned in `docs/multi-agent-work-plan.md`.
- **Clips reviewed in this session:** none. No GoGlow clip was supplied to, or
  inspected by, the author of this document in this session.
- **Media access actually available to the author in this session:** text
  documents, repository files, and images/files a user uploads in chat.
  No Google Flow video, no generated clip file, and no frame-by-frame video
  playback was supplied or relied on for this document.
- **What this means for every later review:** do not copy a PASS, a
  QC-passed mark, or an approval from this document onto a real clip.
  A clip is only reviewed when it is accessible to the reviewer, actually
  watched, and recorded with its own `media_uri`, timestamps, and reviewer
  name and date. If a reviewer cannot access the media, the correct status
  is `NOT_REVIEWED`, not a guess.
- **No automatic vision QC is claimed here.** GoGlow's architecture notes
  that automatic vision review requires an actual media-input/vision
  interface. Until such an interface is implemented and tested, QC in
  GoGlow is human review using this protocol.

If you are using this protocol with an assistant, start your review by
repeating this section for that session: what media was supplied, in what
format, what you could actually see, and what you could not see. If that
list is empty, stop at `NOT_REVIEWED`.

## 1. Purpose and scope

GoGlow plans AI character videos, then a human (or a human with an
assistant) generates clips — currently manually through the Google Flow UI,
because no Flow integration is implemented — and reviews them before
assembly. This protocol makes that review repeatable, comparable across
scenes, and honest about its limits.

It covers:

- one clip at a time, then the assembled sequence;
- identity, wardrobe, anatomy, object contact, movement physics, screen
  direction, camera, background, artifacts, duration, and format;
- activity-specific checks for cycling, yoga, dance, and fashion;
- continuity between adjacent scenes;
- severity, pass / revise / reject decisions, and a compact issue report.

It does **not** cover:

- generating video, calling Flow, or any model API;
- automatic visual inspection;
- editing application code or shared schemas — this document is the only
  deliverable for the media-QC contributor, per the multi-agent work plan;
- publishing, paid generation, or account changes — those require separate
  human confirmation (see `AGENTS.md`, rule 9).

A planned action is not a generated result. A generated result is not a
passed QC check. A checklist is not a QC pass.

## 2. Terms and status mapping

Use the project's existing terms. Do not invent a new status vocabulary
in a QC report.

### 2.1 Project workflow states (`docs/workflow.md`)

- `PLANNED` → `PROMPT_READY` → `WAITING_FOR_GENERATION` → `GENERATED` →
  `QC_REVIEW` → `APPROVED`
- On failure: `GENERATED` → `QC_REVIEW` → `NEEDS_REVISION` →
  `PROMPT_REVISED` → `WAITING_FOR_GENERATION`
- `BLOCKED` when a required asset, capability, or decision is missing.

### 2.2 QC report statuses (`specs/qc-report.schema.json`)

A QC report for one scene uses:

- `review_status`: `PASS`, `REVIEW`, `FAIL`, `NOT_REVIEWED`
- per-check `status`: `PASS`, `REVIEW`, `FAIL`, `NOT_CHECKED`
- per-check `category`: `identity`, `anatomy`, `action`, `physics`,
  `continuity`, `camera`, `artifacts`, `duration`, `format`, `other`

### 2.3 How the two vocabularies map

| QC report result | Project workflow action |
|---|---|
| `PASS`, no unresolved BLOCKER/MAJOR defects (Section 6) | Eligible for human sign-off to `APPROVED`. QC PASS alone is not approval to publish. |
| `REVIEW` | Stay in `QC_REVIEW`. Resolve the open checks before deciding. |
| `FAIL` with a MAJOR defect | Move to `NEEDS_REVISION`, write a narrow revision prompt, regenerate that scene only. |
| `FAIL` with a BLOCKER defect | Reject that clip. Do not assemble it. Regenerate or re-plan; do not patch the report to pass. |
| `NOT_REVIEWED` | Stay in `GENERATED` / `QC_REVIEW` with no decision. Do not assemble, do not approve. |

**Canonical mapping note:** this Section 2.3 is the canonical mapping
from QC report results to project workflow states for media review.
`docs/workflow.md` links to this section rather than restating the
mapping, so the two documents cannot drift apart. If the mapping
changes, change it here first and update the link target in
`docs/workflow.md` if the section number moves.

**Severity naming note (GPT review, 2026-10-21):** media defect
levels in this document are `BLOCKER` / `MAJOR` / `MINOR` / `NOTE`.
They are deliberately different from the QA severity scale in
`docs/qa-acceptance.md`, which uses different labels for
software/product risks (for example, a QA finding about a false
generation/QC claim). Do not compare a media `BLOCKER` with a QA
severity label, and do not force one meaning across the two domains.
Earlier drafts of this protocol used P-style labels for media defects;
those labels were renamed after GPT review to remove the collision.

**Wardrobe note for the integration lead:** the QC schema has no
`wardrobe` category. In this protocol, wardrobe checks are recorded as
`identity` when they affect character identity, and as `other` with
`notes` starting `wardrobe:` when they are purely garment detail. Do not
change the schema in this document; if a dedicated category is wanted,
that is a schema decision for the integration lead.

## 3. Before you press play: review preparation

For each scene, gather these items **before** watching. Missing items
do not all have the same consequence — distinguish the two cases below
(GPT review clarification, 2026-10-21). Do not treat every missing
metadata field as proof that the clip itself is unreviewable.

### 3.0 Two different kinds of missing item

- **(a) Clip access missing — review is blocked.** If you cannot open,
  play, or otherwise access the clip itself (no `media_uri`, a link you
  cannot open, a corrupt or truncated file, or an account/format
  barrier), mark the review `BLOCKED` in the tracker and
  `NOT_REVIEWED` in the report, name the blocker, and stop. No other
  category can be judged without the clip.
- **(b) Evidence for a specific check missing — that check is open,
  the clip is not automatically unreviewable.** If the clip plays but,
  for example, the exact prompt used, a reference role, or the model
  label as displayed is not recorded, you can still judge identity,
  anatomy, action, and other observable categories from the clip.
  Record the affected check as `NOT_CHECKED`, the overall report as
  `REVIEW` (not `NOT_REVIEWED`, and not `PASS` — see Section 6, rule 3),
  and list exactly which evidence is missing and which check it blocks.
  Only if the missing evidence makes every critical category
  unjudgeable does the report stay without a decision, and even then
  the reason must be written per category, not assumed from one
  missing field.

Gather the items below before watching, and record any gap using
case (a) or case (b) above.

1. **Scene plan:** `scene_id`, planned duration, start state, one primary
   action, end state, motion direction / speed / timing, body mechanics,
   camera, environment, `continuity_in`, `continuity_out`, prompt,
   `negative_constraints`, and the scene's own QC checklist.
2. **Prompt actually used:** the exact prompt text sent to Flow, not a
   paraphrase. If the prompt was edited in the Flow UI, record the edited
   version.
3. **References actually used:** `reference_ids` and, for each one, its
   role: `identity`, `wardrobe`, `pose`, `first frame`, `last frame`,
   `scene`, or `prop`. Never claim a reference was used if it was not
   attached. If no reference was used, write `none`.
4. **Generation record:** model label **as displayed in the Flow UI at
   generation time**, date checked, mode/settings actually selected,
   aspect ratio and duration controls actually used, first-frame /
   last-frame / extension behaviour actually used (or `none`), and the
   output location. Do not copy working labels such as “Omni 1.1 Flash”
   or “Nano Banana Pro 2.1” from older notes without checking the live
   selector — those are unverified working labels in
   `docs/model-capabilities.md`.
5. **Media record:** `media_uri` (file path, Flow project/clip identifier,
   or download location), actual duration, actual aspect ratio, and the
   clip's own identifier. Planned duration is not actual duration.
6. **Previous scene, for sequence review:** the previous scene's
   `continuity_out` and its approved clip, if any. A scene cannot be
   continuity-checked in isolation.

## 4. Per-clip review procedure

Work in this order. Do not skip to a decision.

### Step 1 — Watch the whole clip once, at normal speed

Watch from start to end without pausing to judge. Note only timestamps
that feel wrong. Do not write a verdict yet.

### Step 2 — Re-watch flagged segments

Re-watch each flagged timestamp, plus the first 2 seconds and the last
2 seconds of the clip, even if nothing was flagged there. Most
identity, contact, and end-state failures live at the boundaries.

### Step 3 — Work through the checklist in Section 5, in order

For every category, record one of `PASS`, `REVIEW`, `FAIL`, or
`NOT_CHECKED`, plus a short note. A note must say **what was seen**,
not why you think the model did it. Example of a good note:

> `00:04–00:06, left foot leaves pedal while wheel keeps turning;`
> `hands stay on handlebars throughout.`

Example of a note to avoid:

> `The model probably misunderstood the prompt.` — that is inference,
> not evidence. Record the observation, keep the inference out, or label
> it explicitly as `inference:`.

If a category cannot be judged from the clip supplied (for example the
resolution is too low to judge wardrobe detail), record `NOT_CHECKED`
and say why. `NOT_CHECKED` on a critical category blocks a `PASS`
(see Section 6).

### Step 4 — Record every defect with a timestamp

Use the format in Section 7. A defect without a timestamp, a scene id,
and a `media_uri` is not a usable defect report.

### Step 5 — Decide, using Section 6 only

Do not upgrade a decision because a clip “mostly works” or because
regeneration is expensive. If a BLOCKER or MAJOR defect is present, the decision
follows the defect, not the effort already spent.

### Step 6 — Write a narrow revision prompt, if revising

One revision prompt addresses the observed defects for **one scene**,
preserves everything that passed, and changes only what failed. Do not
rewrite the whole scene prompt from scratch unless the scene itself is
being re-planned. After regeneration, file a **new** QC report for the
new `media_uri`. Never overwrite the old report to make it pass.

### Step 7 — Sequence review (after every scene in the sequence is reviewed)

Watch the approved or candidate clips in order, back to back:

- Does the end state of scene N match the start state of scene N+1?
- Does travel direction, facing, wardrobe, prop, lighting, and camera
  distance/height carry across the cut, or jump without a planned reason?
- Do transitions, trims, gaps, and overlaps produce the target runtime?
  Verify actual clip durations, not planned durations, and sum them.
- Is the total runtime still the target (default 36 seconds, always
  above 30 seconds for this project), or does it need a re-plan?

A sequence can only be marked ready for assembly when every scene in
it has a `PASS` report (or a documented, human-signed exception for a
MINOR-only note) and the sequence check above is recorded.

## 5. Per-clip checklist

Tick each item as PASS / REVIEW / FAIL / NOT_CHECKED. The scene's own
QC checklist from the plan is the starting point; the items below are
the minimum for every clip, and activity items in Section 5.11 are
additional, not replacements.

### 5.1 Identity (`identity`)

- [ ] Face, hair, skin tone, and overall character read as the same
  person as the identity reference, throughout the clip.
- [ ] No face morphing, swapping, or drift between the first and last
  frames.
- [ ] Identity is judged against the reference actually used, not
  against a memory of the character.

### 5.2 Wardrobe (`identity` / `other`, see Section 2.3)

- [ ] Outfit, colours, and distinctive garments match the wardrobe
  reference and the scene plan.
- [ ] No unplanned wardrobe change, colour shift, or garment
  disappearance mid-clip.
- [ ] Accessories present in the plan are present, and no unplanned
  accessory appears and persists.

### 5.3 Anatomy (`anatomy`)

- [ ] Limb count, hands, feet, and joints are plausible throughout.
- [ ] No extra, missing, fused, or detached limbs, hands, or feet.
- [ ] Head, torso, and limb proportions stay stable; no sudden
  stretching or shrinking.

### 5.4 Object contact (`anatomy` / `action` — record the primary category, note the other)

- [ ] Hands, feet, and body keep the contact points the scene requires
  (for example handlebars and pedals for cycling, mat/floor and support
  points for yoga, floor for dance).
- [ ] Contact is lost only if the plan explicitly requires it, and
  returns in a physically plausible way.
- [ ] Held or worn objects keep consistent geometry and do not pass
  through hands, body, or other objects without a planned reason.

### 5.5 Movement physics (`physics`)

- [ ] Speed, acceleration, and deceleration look plausible for the
  action; no sudden speed jumps, reversals, or freezes unless planned.
- [ ] Repeated motion (pedalling, stepping, arm swing) has a consistent
  cadence and matches the direction of travel.
- [ ] Gravity, balance, and momentum look plausible; the character does
  not float, slide without moving limbs, or hover without support.

### 5.6 Screen direction and action (`action`)

- [ ] The one primary action in the scene plan is the dominant action
  actually performed.
- [ ] Travel / facing direction matches the plan and the road, stage,
  or path direction in the frame.
- [ ] No unplanned direction reversal, lane change, turn, or second
  dominant action takes over the scene.

### 5.7 Camera (`camera`)

- [ ] Camera type, distance, height, and angle match the plan
  (for example side-tracking at a constant distance and height).
- [ ] Camera motion is smooth; no unplanned shake, zoom, cut, or
  angle jump inside a scene.
- [ ] Background movement is consistent with the camera movement
  (for example a tracking shot moves the background relative to the
  subject in the expected way).

### 5.8 Background and environment

- [ ] Location, time of day, and lighting match the plan and stay
  consistent inside the clip.
- [ ] Background objects do not warp, appear/disappear, or change
  identity without a planned reason.
- [ ] No background element contradicts the scene (for example crossing
  traffic on a path the plan says has none).

### 5.9 Artifacts (`artifacts`)

- [ ] No persistent flicker, morphing, smearing, or texture crawling
  on the character, wardrobe, or main prop.
- [ ] No readable-text artifacts, warped logos, or distorted faces in
  the background that draw attention away from the scene.
- [ ] Brief, single-frame glitches are still recorded with a timestamp;
  they are not ignored because they are short.

### 5.10 Duration and format (`duration`, `format`)

- [ ] Actual clip duration is recorded and compared with the planned
  scene duration. A mismatch is a defect, even if the clip “looks fine”.
- [ ] Aspect ratio is the planned ratio (default 9:16) and the clip is
  not stretched, cropped, or letterboxed in a way the plan did not allow.
- [ ] The clip file actually plays end to end; a truncated or corrupt
  file is `FAIL` for `format`, not `REVIEW`.

### 5.11 Activity-specific criteria

Apply the block for the scene's activity, in addition to Sections
5.1–5.10.

#### Cycling

- Travel direction and road direction agree for the whole clip.
- Wheel rotation matches forward speed and direction; wheels do not
  spin backwards, stop while moving, or slide sideways.
- Pedalling is continuous and cadence is steady unless the plan says
  otherwise; hands stay on handlebars, feet stay on pedals.
- Rider stays in the intended lane; bicycle geometry (frame, wheels,
  handlebars) stays stable.
- Landmarks and background pass at a speed consistent with the tracking
  camera; no landmark jumps or repeats that break travel continuity.

#### Yoga

- Balance and support points are plausible: hands, feet, and any mat
  or prop contact the plan requires are actually in contact.
- Joint angles and posture transitions are anatomically plausible;
  no hyperextended, reversed, or detached joints.
- Pose changes happen through a visible, continuous transition, not
  a sudden pose swap.
- Breathing or hold timing, if the plan specifies it, is observable
  as a held pose, not as a freeze or a cut.

#### Dance

- Footing is clear: feet land, push off, and return in a rhythm that
  matches the movement described in the prompt; no sliding feet
  unless the move requires it.
- Direction changes, turns, and facing happen only when the plan
  requires them; no unrequested turn or facing flip.
- Arms, torso, and head move as one coordinated body, not as
  independently drifting parts.
- Repeated moves keep the same step pattern and spatial pattern
  across repetitions inside the clip.

#### Fashion

- Identity and wardrobe together stay consistent: the same person in
  the same outfit, with the same accessories, unless a planned change
  is the point of the scene.
- Garment fit, drape, and movement look plausible for the fabric and
  the action; no garment morphing into a different garment.
- Close or detail shots, if planned, actually show the intended
  garment detail without warping it.
- Walk, turn, and pose follow the plan; no unplanned outfit or
  accessory swap at a turn or cut.

#### Other activities

If the activity is `other`, write the activity-specific checks into
the scene plan before generation, using the same pattern: one dominant
action, contact points, direction, and what “plausible” means for that
action. Do not review an `other` scene with only the generic checklist
and call it complete.

## 6. Severity and decision rules

### 6.1 Severity levels

| Level | Meaning | Examples |
|---|---|---|
| BLOCKER — Blocking | The clip cannot be used in this sequence. | Wrong person, major anatomy break, travel in the wrong direction, clip truncated or corrupt. |
| MAJOR — Must revise | The clip is recognisably the scene, but a planned, observable requirement fails. | Hand leaves handlebar for a sustained period, wardrobe changes mid-clip, continuity break with the previous scene, actual duration far from planned duration. |
| MINOR — Minor | A small, local defect that does not break identity, action, or continuity. | Brief background warp away from the subject, minor lighting flicker that does not change the scene, a small prop detail that is off but not persistent. |
| NOTE — Note only | Cosmetic, or a suggestion for a future take. It does not block this take. | Slightly different background detail that still matches the plan, a framing preference for the next project. |

Severity is about impact on this sequence, not about how hard the
defect was to notice. When in doubt, choose the higher severity and
say why.

These levels describe a media defect only. They are not the QA
severity scale in `docs/qa-acceptance.md`, which describes
software/product risks. A media `BLOCKER` and a QA severity label
must not be compared, averaged, or treated as the same priority.

### 6.2 Decision rules — apply in order

1. **Any BLOCKER defect → `FAIL`, reject the clip.** Do not assemble it.
   Record the defect, then re-plan or regenerate.
2. **Any unresolved MAJOR defect → `FAIL`, revise.** Write a narrow
   revision prompt (Section 4, Step 6) and regenerate that scene only.
3. **Any critical category `NOT_CHECKED` → `REVIEW`, not `PASS`.**
   Critical categories are identity, anatomy, action, and continuity
   for the scene's primary action. You cannot pass what you did not check.
4. **Only MINOR defects, all critical categories checked → `PASS` with
   notes.** List the MINOR notes in the report so the assembler sees them.
5. **Only NOTE notes → `PASS` with notes.**
6. **No media, no access, or no report → `NOT_REVIEWED`.** No decision,
   no assembly, no approval.
7. **A revised clip is a new review.** The new `media_uri` gets a new
   report. The old report stays as history; it is not edited to pass.

Human sign-off is still required to move a `PASS` report to
`APPROVED` in the project tracker, and separately for any paid
generation, publishing, or account-changing step.

## 7. Continuity ledger and defect recording

### 7.1 Continuity ledger

Maintain one ledger row per scene boundary. The ledger is the
sequence-level evidence that scenes fit together; it is not optional
for a multi-scene video.

| Field | What to record |
|---|---|
| `from_scene_id` / `to_scene_id` | The two scenes on either side of the cut. |
| `from_continuity_out` | The end state the previous plan promised. |
| `to_continuity_in` | The start state the next plan requires. |
| `observed_from` | What the previous clip actually ends with. |
| `observed_to` | What the next clip actually starts with. |
| `match` | `MATCH`, `MISMATCH`, or `NOT_CHECKED`, per item (position, direction, wardrobe, prop, lighting, camera). |
| `defect_id` | Link to the defect report in Section 7.2, if any. |

Check, at minimum: position on the path/stage, travel/facing direction,
wardrobe and accessories, main prop and its geometry, lighting and
time of day, and camera distance/height/angle. A mismatch on any one
item is a continuity defect, with the severity from Section 6.

### 7.2 How to record a defect

Use clip-relative time. If the clip is 9 seconds long, a defect at
4 seconds is `00:04`, not “about halfway”. For a range, use
`00:04–00:06`. For a first-frame or last-frame defect, write
`first frame` or `last frame` in addition to the timestamp.

Every defect record needs:

- `defect_id` — stable within the project, for example `CYCLING-36S-S01-D01`;
- `scene_id`, `project_id`, `media_uri`;
- `timestamp` — clip-relative, as above;
- `observed` — what was seen, in plain language, with no inferred cause;
- `expected` — what the plan / prompt required at that moment;
- `category` — one of the QC schema categories;
- `severity` — BLOCKER / MAJOR / MINOR / NOTE, with a one-line reason;
- `evidence` — file name, frame description, or screenshot reference,
  if available; write `none supplied` if there is none, do not invent one;
- `decision` — `REJECT`, `REVISE`, or `NOTE`;
- `revision_prompt` — only for `REVISE`, narrow and tied to this defect.

### 7.3 Compact issue-report template

Copy this template for each defect. Keep it to one defect per report;
do not bundle unrelated defects into one revision prompt.

```markdown
## Issue report: <defect_id>

- Project: <project_id>
- Scene: <scene_id> — planned <N>s, actual <N>s, aspect <9:16 or actual>
- Clip: <media_uri>
- Timestamp: <00:04–00:06 / first frame / last frame>
- Prompt used: <exact prompt text, or a link to the prompt version>
- References used: <reference_ids with roles, or none>
- Model label as displayed: <label as displayed in Flow at generation time>
- Settings used: <aspect / duration controls / first-last frame / extension, or none>
- Observed: <what was seen>
- Expected: <what the plan required>
- Category: <identity | anatomy | action | physics | continuity | camera | artifacts | duration | format | other>
- Severity: <BLOCKER | MAJOR | MINOR | NOTE> — <one-line reason>
- Decision: <REJECT | REVISE | NOTE>
- Revision prompt (if REVISE): <narrow prompt, preserving what passed>
- Reviewed by: <name>
- Reviewed at: <ISO date-time>
- Evidence: <screenshot / frame reference, or none supplied>
```

A matching JSON QC report should follow `specs/qc-report.schema.json`:
`scene_id`, `review_status`, `checks[]` with `category`, `status`,
`notes`, and optional `evidence`, plus `defects[]`,
`revision_prompt`, `reviewed_by`, `reviewed_at`, and `media_uri`.
If the JSON and this markdown disagree, the JSON is the record to fix
before assembly, not the markdown to ignore.

### 7.4 Illustrative template only — not a real review

The example below shows the shape of a report. It is **not** a review
of any clip, because no clip was reviewed in the authoring session
for this document.

```markdown
## Issue report: EXAMPLE-ONLY-D01

- Project: demo-cycling-36s
- Scene: scene-01 — planned 9s, actual NOT RECORDED
- Clip: NOT SUPPLIED
- Timestamp: NOT APPLICABLE
- Prompt used: see examples/cycling-36s.json, scene-01
- References used: none recorded
- Model label as displayed: NOT RECORDED
- Settings used: NOT RECORDED
- Observed: NOT REVIEWED — no media was supplied in this session
- Expected: see scene plan
- Category: other
- Severity: — (no decision can be made without media)
- Decision: NOT_REVIEWED
- Reviewed by: —
- Reviewed at: —
- Evidence: none supplied
```

## 8. Limits, honesty rules, and what this protocol does not do

1. **Separate observation from inference.** Write what was seen first.
   If you add an explanation, label it `inference:` and do not let it
   change the severity on its own.
2. **Separate planned from actual.** Planned duration, planned prompt,
   and planned wardrobe are not evidence that the clip matches them.
   Record actual duration, actual prompt used, and actual wardrobe seen.
3. **Separate a prompt from a result.** Copying a prompt into Flow,
   or exporting a plan from GoGlow, is not generation. Generation is
   recorded only when a clip with a `media_uri` exists.
4. **Separate a checklist from a pass.** Completing this document's
   checklist does not pass a clip; only the decision rules in
   Section 6, applied to observed evidence, do.
5. **Do not claim Flow, model, or reference behaviour you did not
   observe.** Model labels, duration limits, reference roles,
   first/last-frame behaviour, and extension behaviour are unverified
   until they are documented with a dated source or a repeatable
   observation in the live Flow UI. Record the date you checked them.
6. **Do not store secrets.** Never put API keys, cookies, session
   tokens, or account credentials in a QC report, a prompt, an issue,
   or a commit.
7. **Do not review what you cannot access.** If a clip is behind an
   account, a link you cannot open, or a format you cannot play, the
   status is `NOT_REVIEWED` and the blocker is named. Ask the project
   owner for an accessible copy; do not simulate a review from a
   description alone.
8. **Human sign-off remains separate.** A `PASS` QC report makes a clip
   eligible for approval. It does not approve publishing, and it does
   not authorise paid regeneration.

## 9. For the integration lead (GPT review notes)

This document is intentionally limited to its assigned scope, with
one minimal exception requested by GPT review (see below):

- **Changed in the original contribution:** only
  `docs/media-qc-protocol.md`. No application code and no shared
  schema were edited.
- **Changed in the GPT-review revision:** the same protocol file,
  plus a minimal pointer in `docs/workflow.md` that designates
  Section 2.3 of this protocol as the canonical QC-to-workflow
  mapping and links to it. That pointer does not change the workflow
  state machine itself. It is included only because GPT review
  required a workflow source of truth, and the integrator may revert
  that pointer and own the workflow edit instead if preferred.
  No other file was edited.
- **Not tested as code:** there is no code change to test, and no clip
  was reviewed, so no test command is claimed for this document.
  A reviewer can check it by reading it against `AGENTS.md`,
  `README.md`, `docs/architecture.md`, `docs/workflow.md`,
  `specs/qc-report.schema.json`, and `docs/multi-agent-work-plan.md`.
- **GPT review items, and how they were reconciled (2026-10-21):**
  - *Severity collision with Grok QA:* resolved by renaming media
    levels from P-style labels to `BLOCKER` / `MAJOR` / `MINOR` /
    `NOTE` throughout this document, including the template and
    example, and stating explicitly that they are not comparable
    to the QA severity scale in `docs/qa-acceptance.md`.
  - *Workflow source of truth:* resolved by designating Section 2.3
    as canonical (above) and adding the link in `docs/workflow.md`.
  - *Missing evidence vs clip access:* resolved in Section 3.0 —
    missing clip access gives `NOT_REVIEWED` / `BLOCKED`, while
    missing evidence for a specific check gives `NOT_CHECKED` /
    `REVIEW` for that check, not an automatic `NOT_REVIEWED`.
  - *Wardrobe category:* GPT review recommended keeping the schema
    unchanged for M1, so the `identity` / `other` mapping with a
    `wardrobe:` note prefix in Section 2.3 is kept.
- **Manual steps that remain:** generation in the Flow UI, human
  clip review using this protocol, sequence review, and human
  sign-off before assembly or publishing.

---

*Status of this document itself: protocol only, no clips reviewed,
no media inspected in the authoring session. See Section 0.*

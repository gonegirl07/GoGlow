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

## Google Flow pilot: per-job variants

The CDP pilot runner accepts a `variants` field from 1 to 3 in the scene/job JSON (default: `1`). With `variants: 3`, it submits three separate Create actions using the same job ID, prompt, and verified reference images; each result is downloaded as `<scene_id>__v1.mp4`, `<scene_id>__v2.mp4`, and `<scene_id>__v3.mp4`. Each attempt gets its own ledger record with `job_id`, `variant_index`, and `variant_count`. Variant execution requires `--wait`, and the runner refuses multi-variant execution when Flow does not expose a per-clip credit estimate. Before the first Create, it displays the per-clip estimate and total estimated credits and asks for one explicit confirmation for the whole set. It never automatically retries an ambiguous Create.

For a seated/sitting/kneeling shot, the runner appends an English ASCII framing helper by default: keep a wide margin on both sides of the knees. Set `"framing_helper": false` to opt out or `true` to force it for another shot. The helper only adjusts prompt text; visual QC remains a human task.

Example job: [flow-pilot-variants.example.json](examples/flow-pilot-variants.example.json). First run `--dry-run --wait` and inspect the settings, prompt, references, total estimate, and cleanup before any explicitly approved `--execute --wait`. Import the resulting JSONL ledger into the browser prototype's **QC cấp dự án** panel to record each attempt's QC and watermark/sparkle status, then choose the best variant with a written reason. The selection and reason are recorded on all ledger attempts sharing the same `job_id`. This tool does not remove AI watermarks.

### Flow runner command example

Always include `--wait` with an approved `--execute`; multi-variant execution is rejected without it. Run the dry-run first and inspect the account, project, references, prompt, credit estimate, and cleanup. Only run the execute command after that review and a separate explicit approval.

```bash
node scripts/flow-pilot.mjs --dry-run --wait --tab 2 --scene local/mai-job-v15u.json \
  --selectors local/flow-selectors.json --account-label "pink" \
  --expected-project "2c77da50-fb9e-4cc2-bf50-8ce67649c32e"

# Only after reviewing a passing dry-run and explicitly approving generation:
node scripts/flow-pilot.mjs --execute --wait --wait-timeout-ms 600000 --tab 2 \
  --scene local/mai-job-v15u.json --selectors local/flow-selectors.json \
  --account-label "pink" --expected-project "2c77da50-fb9e-4cc2-bf50-8ce67649c32e" \
  --download-dir local/flow-downloads --ledger-output local/flow-generation-ledger.jsonl
```

A Flow policy refusal is a failed attempt, not a completed clip. Do not automatically retry or change references/prompts to evade the refusal; any later attempt needs a human-reviewed, policy-compliant revision and fresh approval.

For a multi-step confirmation, stdin must contain **both** exact confirmation lines in order. For example, the one-variant policy-review scene below requires the account confirmation and then the one-video confirmation; piping only the second line stops at account confirmation:

```bash
# First edit examples/mai-job-v15v-policy-review.example.json:
# replace both REPLACE_WITH paths with the actual reference paths used by your local job.
node scripts/flow-pilot.mjs --dry-run --wait --tab 2 \
  --scene examples/mai-job-v15v-policy-review.example.json \
  --selectors local/flow-selectors.json --account-label "pink" \
  --expected-project "2c77da50-fb9e-4cc2-bf50-8ce67649c32e"

# Only after reviewing the passing dry-run and explicitly deciding to submit:
printf 'CONFIRM ACCOUNT pink HAS CREDIT\\nCREATE ONE VIDEO FOR mai-seated-breath-v15v-policy-review\\n' | \
node scripts/flow-pilot.mjs --execute --wait --wait-timeout-ms 600000 --tab 2 \
  --scene examples/mai-job-v15v-policy-review.example.json \
  --selectors local/flow-selectors.json --account-label "pink" \
  --expected-project "2c77da50-fb9e-4cc2-bf50-8ce67649c32e" \
  --download-dir local/flow-downloads --ledger-output local/flow-generation-ledger.jsonl
```

The example uses one face reference, `face_description_mode: "reference_only"`, and `reference_language_mode: "neutral_reference"`; it deliberately avoids detailed facial-feature instructions and identity-lock phrasing. This is a human-reviewed alternative prompt, **not a way to bypass policy**. A policy refusal still means stop and review the content/reference eligibility rather than retrying automatically.


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

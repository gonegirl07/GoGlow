# Per-Scene Reference Images and Character Description

GoGlow does not store Character Profiles, character IDs, or reusable character descriptions. Each scene/job supplies its own reference images and English character description. This keeps the runner usable for any character without hidden defaults or persistent identity data.

## Scene/job contract

Required fields:
- `scene_id`: unique scene identifier for this job.
- `reference_images`: one to three distinct local paths to PNG, JPG, JPEG, or WEBP images. Absolute paths are supported; relative paths resolve from the scene JSON directory.
- `character_description`: required ASCII English description of the person shown in the reference images.
- `prompt`: required ASCII English description of the scene, action, wardrobe, and scene-specific constraints.
- `model` and `resolution`: currently restricted to `Omni 1.1 Flash` and `360p`; `duration` is restricted to `8s`.

The runner combines the character description and scene prompt and adds an instruction to preserve identity from the attached images. All text sent to Flow must pass an ASCII-only check. Character-specific constraints (for example, wardrobe coverage or body proportions) belong in the current job's description/prompt, not in saved tool state.

## Ingredients upload and dry-run

The runner validates all local paths before touching Flow. It requires the Ingredients reference panel to be empty, uploads exactly the listed files, and verifies that the visible attached-item count matches the list length. Ambiguous selectors, failed uploads, or count mismatches stop the run before filling the prompt or reaching READY-TO-CREATE.

The three reference-upload selectors in `local/flow-selectors.json` must be inspected and set against the actual Flow UI:
- `ingredient_add_button`: unique visible button that opens the add-reference flow.
- `ingredient_file_input`: unique `input[type=file]` used for Ingredients.
- `ingredient_reference_items`: selector matching only attached reference thumbnails/items.

A dry-run screenshot and console output are required to confirm the expected images are visibly attached before any real generation. A correct count alone cannot establish image identity if the wrong files were selected; inspect the thumbnails and names visually. Do not use `--execute` until the real-browser dry-run passes. Dry-run never clicks Create.

## Mai test

Use one to three actual image files from `/workspace/mai-fitness/refs/`. Replace the example path and description with actual values in a private scene JSON or in the example file for local testing. Describe Mai only from the approved reference images; put clothing and scene-specific rules in the job prompt. Do not commit private images or machine-specific job files.

Example:
```bash
node scripts/flow-pilot.mjs --dry-run --tab 4 \
  --scene examples/flow-pilot-scene.example.json \
  --selectors local/flow-selectors.json \
  --account-label "my Flow account" \
  --expected-email "you@example.com" \
  --expected-project "project-uuid"
``

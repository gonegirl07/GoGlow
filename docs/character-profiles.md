# Per-scene Reference Images and Character Description

GoGlow does not store or select reusable Character Profiles. Every scene/job carries its own inputs, so the same runner works for any person or character.

## Scene fields

- `reference_images`: one to three local image paths (PNG, JPG, JPEG, or WEBP). Absolute paths are supported. Relative paths resolve from the directory containing the scene JSON.
- `character_description`: required ASCII English description of the person in the supplied reference images.
- `prompt`: required ASCII English description of the requested action, setting, clothing, and any scene-specific constraints.

The runner combines `character_description` and `prompt` into one ASCII-only prompt. It does not invent, remember, or persist character traits between jobs.

## Ingredients upload contract

Before filling the prompt, the runner requires an empty Ingredients reference panel, opens the configured add-reference flow, uploads exactly the paths in `reference_images`, and verifies the visible attached-item count equals the input count. A selector ambiguity, upload error, or count mismatch stops the run before READY-TO-CREATE. The dry-run screenshot should be inspected to confirm the visible images are the intended files.

The current Google Flow reference-upload DOM selectors are not yet validated. Inspect the real Flow UI and replace the three `REPLACE_WITH_EXACT...` values in the local selector file:
- `ingredient_add_button`: unique visible button that opens the add-reference flow
- `ingredient_file_input`: unique `input[type=file]` used for Ingredients
- `ingredient_reference_items`: selector matching only the attached reference thumbnails/items

Do not run `--execute` until a real-browser dry-run confirms the correct images and count before READY-TO-CREATE. Dry-run never clicks Create.

## Mai test

1. Choose one to three actual image files from `/workspace/mai-fitness/refs/`.
2. Replace the placeholder path and character description in `examples/flow-pilot-scene.example.json` or make a private scene JSON.
3. Put Mai's appearance, outfit, and constraints in that scene's English description and prompt. There is no saved Mai profile.
4. Run dry-run using the local selector config and inspect the screenshot and console report.

Example:
```bash
node scripts/flow-pilot.mjs --dry-run --tab 4 \
  --scene examples/flow-pilot-scene.example.json \
  --selectors local/flow-selectors.json \
  --account-label "my Flow account" \
  --expected-email "you@example.com" \
  --expected-project "project-uuid"
``

All reference paths and character descriptions belong to the current job only. Never commit private reference images or machine-specific scene files.

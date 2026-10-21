# Character Profiles for Google Flow

Character profiles are local operator data. Keep real profile files under `local/characters/`; that directory is ignored by Git and must not be committed. A scene selects one profile using `character_id`, and the runner requires `--character-profile` to point to the corresponding JSON file.

Each profile has `id`, `name`, `reference_images` (one to three local PNG, JPG, JPEG, or WEBP files), `fixed_appearance`, `default_wardrobe`, and one or more `rules`. All descriptive text must be ASCII English.

The runner rejects non-ASCII text in the profile or composed prompt, missing reference files, unsupported extensions, a scene/profile ID mismatch, and more than three or fewer than one reference image.

## Flow selector configuration

The current Flow UI's reference upload DOM has not yet been validated. Before using this feature, inspect the live Flow page and replace the three `REPLACE_WITH_EXACT...` values in your local selector file:
- `ingredient_add_button`: unique visible button that opens the add-reference flow
- `ingredient_file_input`: unique `input[type=file]` used for Ingredients
- `ingredient_reference_items`: CSS selector matching each attached reference thumbnail/item, and only those items

The dry-run must report the expected number of attached references before it fills the final prompt and shows READY-TO-CREATE. If selectors are ambiguous or the visible item count differs, the runner stops before Create. Do not guess these selectors or run `--execute` until a dry-run proves upload works on the real Flow UI.

## Example setup

1. Copy `examples/character-profile.template.json` to `local/characters/mai.json`.
2. Replace the fixed appearance description with an approved English description grounded in Mai's actual reference photos. Do not infer unverified identity traits.
3. Set one to three actual image paths. For this test, the tester's source folder is `/workspace/mai-fitness/refs/`; choose real image filenames from that directory.
4. Add `"character_id": "mai"` to the scene JSON.
5. Run dry-run with `--character-profile local/characters/mai.json`. Inspect the screenshot and verify the right reference thumbnails and count before any real generation.

Example:
```bash
node scripts/flow-pilot.mjs --dry-run --tab 4 \
  --scene examples/flow-pilot-scene.example.json \
  --selectors local/flow-selectors.json \
  --character-profile local/characters/mai.json \
  --account-label "my Flow account" \
  --expected-email "you@example.com" \
  --expected-project "project-uuid"
```

Mai, Linh, Mila, and future characters all use the same schema and runner path. Only the local profile and scene's `character_id` change.

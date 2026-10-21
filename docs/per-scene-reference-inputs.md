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

The runner validates all local paths before touching Flow. The picker is opened with `button[aria-label="Add ingredients to the prompt box"]`; because Flow creates its file input only after the user clicks `Upload media`, the runner waits for Playwright's `filechooser` event and calls `setFiles()`. It then resolves each uploaded asset by its displayed filename, extracts the UUID from the library thumbnail URL, selects that asset, and verifies the same UUID appears in the attached prompt chip. Asset readiness waits up to 90 seconds by default because Flow can render the library tile before its thumbnail URL/UUID is ready. Override with `FLOW_ASSET_READY_TIMEOUT_MS` (15,000–180,000 ms). The runner waits for every attached chip thumbnail to finish loading (`img.complete && img.naturalWidth > 0`) and verifies chip count, UUIDs, and order. It repeats this verification after filling the prompt and again after the final execute confirmation, immediately before Create.

The selector config includes:
- `ingredient_add_button`: opens the Ingredients asset picker.
- `ingredient_upload_button`: visible `Upload media` button that triggers the file chooser.
- `ingredient_library_item`: project-library asset entries, not prompt chips.
- `ingredient_add_to_prompt`: button used when selecting an asset does not immediately attach it.
- `ingredient_reference_items`: `flow-ingredient-bar button[aria-label="Ingredient"]` chip selector.
- `clear_prompt`: `button[aria-label="Clear prompt"]`, which clears both prompt text and attached chips.
- `ingredient_picker_backdrop`: the visible CDK overlay backdrop used to close the picker; the runner clicks near the backdrop edge and verifies that it is no longer visible. Escape is not relied on.

Flow may retain uploaded media in the project library. The runner attempts an upload first. If no new UUID becomes available before the configured timeout, it logs UUIDs observed before and after upload and may reuse a readable existing UUID for a same-name asset. Reuse is explicitly logged as `asset_upload_reused_existing`; inspect the reported thumbnail in dry-run before any execute. If no existing UUID is verifiable, the runner stops safely. This fallback is filename-based, not a cryptographic content match, so same-name files with different contents must not be treated as interchangeable. Do not use `--execute` until the real-browser dry-run passes. On an upload failure, a `finally` cleanup attempts to close and verify the picker, then clears and verifies prompt text and chips; cleanup failures are logged explicitly and require manual inspection. A failed preflight also attempts to dismiss a visible Google account panel without toggling unrelated menus. Dry-run never clicks Create and must finish with prompt text empty and zero attached chips.

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

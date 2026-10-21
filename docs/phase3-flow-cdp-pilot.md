# Phase 3 — Google Flow one-scene CDP pilot

This is a local, human-gated browser pilot. It does not call a Google Flow API or send direct HTTP requests to Flow. It attaches to the already-open Chrome CDP endpoint at `127.0.0.1:9224`.

## Install and inspect

Use the same Linux user/session that owns the Chrome instance. Ensure Chrome was started with remote debugging enabled on port 9224 and the intended Flow project tab is already open.

```bash
npm install
npm run flow:inspect
```

Inspection is read-only: it lists exposed tabs, their URLs, visible text and visible controls. It never navigates, fills, or clicks. The current project UI is recognized at `https://flow.google.com/project/<UUID>`; the old `labs.google/fx/tools/flow` route remains supported. A `flow.google.com/404` page is explicitly rejected. CDP context indexes do **not** prove which Google account is active.

## Prepare local selectors

```bash
mkdir -p local
cp examples/flow-pilot-selectors.example.json local/flow-selectors.json
```

The selector template reflects the tested current DOM pattern. Verify every selector with `--inspect` before use. The settings panel must be opened before model and radio controls exist. Because Flow renders this panel asynchronously, the runner waits up to 5 seconds for the model selector after opening Settings, and up to 5 seconds for the model option after opening its menu. The runner uses the settings trigger, opens the model family menu, selects the exact `menuitem`, and verifies radio state through `aria-checked="true"`.

Required selector keys:

- `account_button`: account control with an aria-label containing the active account email; defaults to `[role="button"][aria-label^="Google Account:"]`.
- `prompt`, `settings_trigger`, `model`, `model_option`, `resolution`, `ingredients_mode`, `aspect_9_16`, `duration`, `create`.

Do not commit the local selector file, account identifiers, screenshots, or logs.

## Dry run — always stop before Create

```bash
node scripts/flow-pilot.mjs --dry-run \
  --tab 4 \
  --scene examples/flow-pilot-scene.example.json \
  --selectors local/flow-selectors.json \
  --account-label "my intended Flow account" \
  --expected-email "you@example.com" \
  --expected-project "project-uuid"
```

Replace the tab index, email, project UUID and label with the exact values you have verified. `--expected-email` is mandatory: the runner reads the email from the Google account button's DOM aria-label and compares it before changing any page fields. `--expected-project` is optional but recommended; when supplied it must exactly match the project UUID in the current URL.

The first confirmation still requires typing exactly:

`CONFIRM ACCOUNT my intended Flow account HAS CREDIT`

Before filling the prompt, the runner validates the project and account, checks the prompt/Create/settings selectors, opens settings, validates the model/radio controls, and applies/verifies these settings:

- Model: `Omni 1.1 Flash`
- Resolution: `360p`
- Mode: `Ingredients`
- Aspect ratio: `9:16`
- Duration: `8s`

It reads the visible `Generating will use N credits` text when present and includes the estimated cost in the READY-TO-CREATE CHECK. It closes the settings overlay before filling the prompt. Non-ASCII prompt text is rejected before connecting to or changing the page. After prompt fill it verifies Create is enabled, saves a screenshot and exits without clicking Create.

If a selector or setting fails before prompt fill, the prompt is not touched. If prompt fill itself fails or the button remains disabled, the runner attempts to clear the prompt. Run the command in an interactive terminal rather than piping stdin. If stdin closes before the confirmation is entered, the runner reports `Confirmation input closed before an answer. No Create click was performed.` and does not proceed. The readline interface is closed when dry-run completes so the process can exit cleanly.

## Execute exactly one generation — requires separate approval

Do not run this command until the tester has accepted the dry-run output and explicitly approves one real generation.

```bash
node scripts/flow-pilot.mjs --execute \
  --tab 4 \
  --scene examples/flow-pilot-scene.example.json \
  --selectors local/flow-selectors.json \
  --account-label "my intended Flow account" \
  --expected-email "you@example.com" \
  --expected-project "project-uuid" \
  --log local/flow-pilot.jsonl
```

After the account confirmation and READY-TO-CREATE CHECK, the runner requires a second exact phrase:

`CREATE ONE VIDEO FOR pilot-scene-01`

It re-checks the URL, project/account identity and Create control before a single click. It never retries. If the click outcome is ambiguous, inspect Flow manually and do not click again until the result is known. The append-only receipt records submission intent and whether the click returned or its outcome is unknown; it does not claim generation completion or credit charge.

## Safety properties

- Existing Chrome CDP connection only; no navigation, direct Flow API or direct HTTP request.
- Rejects non-Flow tabs and `flow.google.com/404`; can optionally pin the exact project UUID.
- Verifies active Google email from page DOM against mandatory `--expected-email`; operator-supplied label alone is not treated as identity proof.
- ASCII-only prompt, exact model/resolution, and verified Ingredients / 9:16 / 8s settings.
- Dry-run is the default and never clicks Create.
- Execute requires two explicit confirmations and permits at most one Create click.
- No retry, no inferred completion/credit deduction, no credential or cookie storage.

## Tester acceptance

1. With multiple tabs/profiles open, verify inspect recognizes the real `flow.google.com/project/<UUID>` tab and rejects the 404 tab.
2. Verify a mismatched `--expected-email` and mismatched `--expected-project` both stop before any page mutation.
3. Verify non-ASCII prompt text is rejected before the runner touches Flow.
4. Run dry-run with the local selectors. Confirm model, 360p, Ingredients, 9:16, 8s and credit-cost estimate; verify settings overlay closes and prompt is filled only after selector preflight.
5. Confirm dry-run does not click Create and credit remains unchanged.
6. Exercise out-of-range/non-Flow tab, zero-match/duplicate selectors, and cancelled confirmations.
7. Only after the above pass, separately approve and run exactly one `--execute` test. Manually verify the resulting generation and balance; do not retry ambiguous outcomes.
8. Run Python tests, Node syntax check, JSON validation and existing Chrome regression checks.

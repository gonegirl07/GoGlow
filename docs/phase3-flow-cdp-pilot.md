# Phase 3 — Google Flow one-scene CDP pilot

This is a local, human-gated browser pilot. It does not call a Google Flow API or send direct HTTP requests to Flow. It attaches to the already-open Chrome CDP endpoint at `127.0.0.1:9224`.

## Install and preflight

Use the same Linux user/session that owns the Chrome instance. Ensure Chrome was started with remote debugging enabled on port 9224 and the intended Flow tab is already open.

```bash
npm install
npm run flow:inspect
```

The inspector is read-only. It lists every page exposed by CDP, including a zero-based global tab index, context index, title, URL, visible text and a small set of UI controls. It never navigates, fills a field, or clicks anything. If the intended Flow tab is not listed, stop; do not let the runner open a new tab or assume another profile is the correct account.

Only `labs.google/fx/tools/flow` URLs are recognized in this pilot. If the current official Flow UI uses a different host or route, update the allowlist only after manually verifying the official URL.

## Prepare selector config

1. Run `npm run flow:inspect` and inspect the actual page controls on the account/profile that has credit.
2. Copy `examples/flow-pilot-selectors.example.json` to a local-only file such as `local/flow-selectors.json`.
3. Replace every `REPLACE_AFTER_INSPECT` value with a CSS selector observed on the current UI. The example intentionally does not guess selectors.
4. Do not commit real account identifiers, screenshots, logs, or local selector files if they reveal private account information.

Selector config requires unique selectors for `prompt`, `model`, `resolution`, and `create`. Each selector must match exactly one visible element. Model and resolution selectors must either be native `select` elements with a matching label/value, or open a menu containing one exact accessible `option` name.

## Dry run (default, no Create click)

```bash
node scripts/flow-pilot.mjs \
  --tab 0 \
  --scene examples/flow-pilot-scene.example.json \
  --selectors local/flow-selectors.json \
  --account-label "my intended Flow account"
``

Replace tab index and account label with the values shown/verified on your machine. Before changing the page, the runner prints the selected tab and visible page text, then requires the operator to type exactly:

`CONFIRM ACCOUNT my intended Flow account HAS CREDIT`

The runner then fills the prompt and selected settings, checks the Create control, saves a screenshot, prints a review summary, and exits **without clicking Create**. If a selector is missing, ambiguous, hidden, or disabled, it stops. Dry-run does not generate a video.

## Execute one generation (only after dry-run passes)

```bash
node scripts/flow-pilot.mjs --execute \
  --tab 0 \
  --scene examples/flow-pilot-scene.example.json \
  --selectors local/flow-selectors.json \
  --account-label "my intended Flow account" \
  --log local/flow-pilot.jsonl
``

The runner requires the same account-and-credit confirmation before filling fields, then prints the final prompt/model/resolution and requires a second exact phrase:

`CREATE ONE VIDEO FOR pilot-scene-01`

Only then does it re-check the existing tab URL and Create control and attempt one click. There is no loop and no automatic retry. If a click throws or the result is ambiguous, the append-only JSONL receipt records `submission_outcome_unknown`; inspect Flow manually and **do not click again** until you know whether a generation was submitted.

The JSONL receipt records intent before the non-idempotent click, then records that the click returned or that the outcome is unknown. It does not claim that generation completed or that credits were charged. Completion detection and automatic URI import are out of scope for this pilot.

## Safety properties

- Connects only to `http://127.0.0.1:9224`; it does not launch a separate browser or navigate tabs.
- Enumerates existing tabs and requires an explicit tab index. A non-Flow page is rejected.
- Requires an operator-supplied account label and explicit confirmation that the selected account has credit.
- Restricts the scene to exact labels `Omni 1.1 Flash` and `360p`.
- Uses configured selectors only; no blind coordinate clicks.
- Dry-run is the default. Only `--execute` plus the final typed phrase can reach the Create click.
- A single Create click at most; no retry on timeout/ambiguous outcome.
- Does not save credentials, cookies, or profile data into GoGlow.
- The runner does not read or infer the credit balance.

## Tester acceptance

1. Run `--inspect` with several Chrome tabs/profiles open. Verify the correct Flow tab can be identified without navigation or writes.
2. Use a valid local selector config in dry-run. Verify exact prompt, Omni 1.1 Flash, 360p and screenshot; verify no generation/credit change occurs.
3. Try an incorrect tab index, a non-Flow tab, zero-match selector and duplicate-match selector; each must stop without Create click.
4. Cancel the first account/credit confirmation; no field should be filled.
5. In a disposable test, verify dry-run never clicks Create even when the button is enabled.
6. Only after those pass, execute one 360p pilot and manually verify one generation appears. Verify the JSONL receipt and manually inspect result/credit balance; GoGlow must not infer either.
7. Run existing Python CI and Chrome regression checks. Keep screenshots/logs local if they reveal account details.

## Known limitations

- The real Flow DOM, exact option labels and Create button selector must be confirmed by the tester; no selectors are assumed to be stable.
- The runner is intentionally interactive and requires a terminal. Do not run it unattended.
- A click returning is not proof that generation started or finished.
- No generation completion polling, result download, URI import, automatic credit tracking, or multi-scene loop is included.

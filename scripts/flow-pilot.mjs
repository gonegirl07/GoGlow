#!/usr/bin/env node
/**
 * Human-gated Google Flow pilot runner.
 * Dry-run prepares one scene and always stops before the non-idempotent Create click.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { createHash, randomUUID } from "node:crypto";

const CDP_ENDPOINT = "http://127.0.0.1:9224";
const LEGACY_FLOW_HOST = "labs.google";
const FLOW_HOST = "flow.google.com";
const PROJECT_PATH = /^\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i;
const ASSET_READY_TIMEOUT_MS = Number(process.env.FLOW_ASSET_READY_TIMEOUT_MS || 90000);
if (!Number.isInteger(ASSET_READY_TIMEOUT_MS) || ASSET_READY_TIMEOUT_MS < 15000 || ASSET_READY_TIMEOUT_MS > 180000) {
  throw new Error("FLOW_ASSET_READY_TIMEOUT_MS must be an integer from 15000 to 180000.");
}

function argsOf(argv) {
  const args = { inspect: false, execute: false, dryRun: false, clearAfterDryRun: true, tab: null, scene: null, selectors: null,
    accountLabel: null, expectedEmail: null, expectedProject: null, log: "flow-pilot.jsonl", screenshot: null,
    waitForResult: false, waitTimeoutMs: 600000, downloadDir: "local/flow-downloads", ledgerOutput: "local/flow-generation-ledger.jsonl", ledgerProjectId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--inspect") args.inspect = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--keep-prompt-after-dry-run") args.clearAfterDryRun = false;
    else if (arg === "--tab") args.tab = Number(argv[++i]);
    else if (arg === "--scene") args.scene = argv[++i];
    else if (arg === "--selectors") args.selectors = argv[++i];
    else if (arg === "--account-label") args.accountLabel = argv[++i];
    else if (arg === "--expected-email") args.expectedEmail = argv[++i];
    else if (arg === "--expected-project") args.expectedProject = argv[++i];
    else if (arg === "--log") args.log = argv[++i];
    else if (arg === "--screenshot") args.screenshot = argv[++i];
    else if (arg === "--wait") args.waitForResult = true;
    else if (arg === "--wait-timeout-ms") args.waitTimeoutMs = Number(argv[++i]);
    else if (arg === "--download-dir") args.downloadDir = argv[++i];
    else if (arg === "--ledger-output") args.ledgerOutput = argv[++i];
    else if (arg === "--ledger-project-id") args.ledgerProjectId = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.inspect && args.execute) throw new Error("Use --inspect or --execute, not both.");
  if (args.execute && args.dryRun) throw new Error("Use --dry-run or --execute, not both.");
  if (args.waitForResult && !args.execute && !args.dryRun) throw new Error("--wait without --execute is preflight-only; pass --dry-run --wait explicitly.");
  if (!Number.isInteger(args.waitTimeoutMs) || args.waitTimeoutMs < 30000 || args.waitTimeoutMs > 1800000) throw new Error("--wait-timeout-ms must be an integer from 30000 to 1800000.");
  if (args.waitForResult && (!args.downloadDir || !args.ledgerOutput)) throw new Error("--wait requires non-empty --download-dir and --ledger-output paths.");
  if (args.tab !== null && (!Number.isInteger(args.tab) || args.tab < 0)) throw new Error("--tab must be a zero-based non-negative index.");
  return args;
}

function usage() {
  console.log(`GoGlow Flow Pilot (CDP ${CDP_ENDPOINT})

Read-only tab inventory:
  node scripts/flow-pilot.mjs --inspect

Dry-run (validates account, project, settings and prompt; stops before Create):
  node scripts/flow-pilot.mjs --dry-run --tab 4 --scene examples/flow-pilot-scene.example.json \\\
    --selectors local/flow-selectors.json --account-label "my Flow account" \\\
    --expected-email "you@example.com" --expected-project "project-uuid"

Actual one-scene submission (requires a separate second confirmation):
  node scripts/flow-pilot.mjs --execute --tab 4 --scene path/to/scene.json \\\
    --selectors local/flow-selectors.json --account-label "my Flow account" \\\
    --expected-email "you@example.com" --expected-project "project-uuid"

Wait for completion, download 360p Original size, and append a credit/media ledger record:
  node scripts/flow-pilot.mjs --execute --wait --wait-timeout-ms 600000 \\
    --download-dir local/flow-downloads --ledger-output local/flow-generation-ledger.jsonl ...

Selector-only preflight (no Create click; validates balance and stable tile identities):
  node scripts/flow-pilot.mjs --dry-run --wait --tab 4 --scene path/to/scene.json \\\
    --selectors local/flow-selectors.json --account-label "my Flow account" \\\
    --expected-email "you@example.com" --expected-project "project-uuid"

--wait requires selector keys: credit_balance, generated_video_items, download_media_button,
and download_360p_original_button. Replace the example selectors and pass --dry-run --wait
to validate credit balance and existing tile identities before any real execute.
Never run --execute until the dry-run and selector inspection have passed.
`);
}

function flowProjectId(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== FLOW_HOST || url.pathname === "/404" || url.searchParams.has("reason")) return null;
    return PROJECT_PATH.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

function isFlowUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname === LEGACY_FLOW_HOST) return url.pathname.startsWith("/fx/tools/flow");
    return flowProjectId(value) !== null;
  } catch { return false; }
}

function appendEvent(logPath, event) {
  const absolute = path.resolve(logPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.appendFileSync(absolute, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { encoding: "utf8", flag: "a" });
}

function waitForSelectors(selectors, args) {
  if (!args.waitForResult) return;
  for (const key of ["credit_balance", "generated_video_items", "download_media_button", "download_360p_original_button", "account_panel_open", "account_panel_close"]) {
    if (typeof selectors[key] !== "string" || !selectors[key].trim()) {
      throw new Error(`--wait requires a non-empty '${key}' selector in the selector config.`);
    }
  }
}

async function readCreditBalance(page, selectors) {
  const selector = typeof selectors === "string" ? selectors : selectors.credit_balance;
  const readVisible = async () => {
    try {
      const locator = await exactVisibleLocator(page, selector, "credit balance");
      const text = (await locator.innerText({ timeout: 2500 }).catch(() => "")).replace(/,/g, "");
      const match = text.match(/(?:^|\D)(\d+)(?:\D|$)/);
      return match ? Number(match[1]) : null;
    } catch { return null; }
  };
  let balance = await readVisible();
  if (balance !== null || typeof selectors === "string") return balance;
  if (!selectors.account_panel_open || !selectors.account_panel_close) return null;
  const opener = await exactVisibleLocator(page, selectors.account_panel_open, "account panel open button").catch(() => null);
  if (!opener) return null;
  await opener.click({ timeout: 2500 }).catch(() => {});
  try {
    const locator = await exactVisibleLocator(page, selector, "credit balance after opening account panel", 3000);
    const text = (await locator.innerText({ timeout: 2500 }).catch(() => "")).replace(/,/g, "");
    const match = text.match(/(?:^|\D)(\d+)(?:\D|$)/);
    balance = match ? Number(match[1]) : null;
  } finally {
    const closer = await exactVisibleLocator(page, selectors.account_panel_close, "account panel close button").catch(() => null);
    if (closer) {
      await closer.click({ timeout: 2500 }).catch(() => {});
      await page.locator(selectors.account_panel_close).waitFor({ state: "hidden", timeout: 2500 }).catch(() => {});
    }
  }
  return balance;
}

async function generatedItemKeys(page, selector) {
  return page.locator(selector).evaluateAll(elements => elements.map(element => {
    const key = element.getAttribute("data-id")
      || element.getAttribute("data-testid")
      || element.getAttribute("href")
      || element.querySelector("a[href]")?.getAttribute("href")
      || element.querySelector("video, img")?.getAttribute("src")
      || "";
    return String(key).trim();
  }));
}

function appendGenerationLedger(pathname, record) {
  const absolute = path.resolve(pathname);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.appendFileSync(absolute, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
  return absolute;
}

function nextLedgerAttemptNumber(pathname, sceneId) {
  const absolute = path.resolve(pathname);
  if (!fs.existsSync(absolute)) return 1;
  let max = 0;
  for (const line of fs.readFileSync(absolute, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record.scene_id === sceneId && Number.isInteger(record.attempt_number)) max = Math.max(max, record.attempt_number);
    } catch { /* Ignore malformed historical lines; append remains non-destructive. */ }
  }
  return max + 1;
}

function makeGenerationLedgerRecord({ scene, projectId, ledgerProjectId, prompt, estimatedCost, beforeBalance, afterBalance, resultStatus, mediaUri, downloadedFile, downloadError, timeoutError, attemptNumber, attemptId, startedOn }) {
  const observedDelta = beforeBalance !== null && afterBalance !== null && beforeBalance >= afterBalance
    ? beforeBalance - afterBalance : null;
  const actualAmount = observedDelta !== null && observedDelta > 0 ? observedDelta : null;
  const chargeStatus = actualAmount !== null ? "charged" : "unknown";
  const timestamp = new Date().toISOString();
  attemptId = attemptId || ("attempt-" + randomUUID());
  return {
    schema_version: "1.0",
    attempt_id: attemptId,
    project_id: ledgerProjectId || scene.goglow_project_id || projectId || "google-flow-project",
    scene_id: scene.scene_id,
    attempt_number: attemptNumber || 1,
    retry_of: null,
    provider: "google_flow",
    started_on: startedOn || null,
    finished_on: timestamp,
    configuration: {
      model_label: scene.model || "Omni 1.1 Flash",
      resolution: scene.resolution || "360p",
      duration_seconds: Number.parseInt(scene.duration || "8s", 10) || 8,
      aspect_ratio: "9:16",
      pose_reference_id: null,
      face_reference_id: null,
      other_reference_ids: (scene.reference_images || []).map(item => path.basename(item)),
    },
    prompt: { text: prompt, sha256: createHash("sha256").update(prompt, "utf8").digest("hex"), template_version: null },
    rule_ids: [],
    result: {
      status: resultStatus,
      provider_message: timeoutError || null,
      failure: resultStatus === "failed" ? { category: "browser_automation", message: timeoutError || downloadError || "Flow result was not verified.", provider_error_code: null, retryable: false, suggested_prompt_revision: null, revision_rationale: null } : null,
    },
    credits: {
      estimated_amount: estimatedCost,
      actual_amount: actualAmount,
      currency_or_unit: "credits",
      charge_status: chargeStatus,
      before_balance: beforeBalance,
      after_balance: afterBalance,
      evidence_source: beforeBalance !== null && afterBalance !== null ? "provider_display" : "unknown",
      notes: actualAmount !== null ? `Observed balance delta: ${beforeBalance} -> ${afterBalance}.` : (beforeBalance !== null && afterBalance !== null && beforeBalance === afterBalance ? "Balance unchanged during the observation window; actual charge remains unknown." : "Credit delta not confirmed; no charge amount inferred."),
    },
    media: {
      uri: mediaUri || null,
      downloaded_file: downloadedFile || null,
      sha256: downloadedFile && fs.existsSync(downloadedFile) ? createHash("sha256").update(fs.readFileSync(downloadedFile)).digest("hex") : null,
      integrity_status: downloadedFile ? "verified" : (mediaUri ? "not_checked" : "missing"),
    },
    qc: { status: "not_reviewed", observed_defects: [], checks_passed: null, checks_total: null, reviewed_by: null, reviewed_on: null, notes: "Human QC has not been recorded." },
    created_by: "browser_automation",
    notes: [downloadError ? `Download failed: ${downloadError}` : null, timeoutError ? `Wait ended without verified completion: ${timeoutError}` : null].filter(Boolean).join(" "),
  };
}

async function waitForGenerationAndDownload(page, selectors, { beforeKeys, timeoutMs, downloadDir, sceneId, attemptId }) {
  const itemLocator = page.locator(selectors.generated_video_items);
  const deadline = Date.now() + timeoutMs;
  let newItem = null;
  while (Date.now() < deadline) {
    const keys = await generatedItemKeys(page, selectors.generated_video_items).catch(() => []);
    const newIndexes = keys.map((key, index) => ({ key, index })).filter(item => item.key && !beforeKeys.includes(item.key));
    if (newIndexes.length === 1) { newItem = itemLocator.nth(newIndexes[0].index); break; }
    if (newIndexes.length > 1) throw new Error(`More than one new Flow video tile appeared (${newIndexes.length}); refusing to guess which clip to download.`);
    await page.waitForTimeout(1000);
  }
  if (!newItem) throw new Error(`No uniquely identifiable new video tile appeared within ${timeoutMs}ms. Submission may still be processing; do not retry.`);
  await newItem.click({ timeout: 5000 });
  const remainingMs = Math.max(1000, deadline - Date.now());
  const downloadButtonLocator = page.locator(selectors.download_media_button);
  try { await downloadButtonLocator.waitFor({ state: "visible", timeout: remainingMs }); }
  catch { throw new Error("A new video tile appeared, but Download media did not become visible before the wait deadline; completion remains unverified."); }
  const downloadButton = await exactVisibleLocator(page, selectors.download_media_button, "Download media button");
  const mediaUri = page.url();
  try {
    await downloadButton.click({ timeout: 5000 });
    const qualityLocator = page.locator(selectors.download_360p_original_button);
    await qualityLocator.waitFor({ state: "visible", timeout: 10000 });
    const quality = await exactVisibleLocator(page, selectors.download_360p_original_button, "360p Original size download option");
    const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
    await quality.click({ timeout: 5000 });
    const download = await downloadPromise;
    const suggested = download.suggestedFilename() || "flow-clip-360p.mp4";
    const rawExtension = path.extname(suggested).toLowerCase();
    const extension = /^\.[a-z0-9]{1,8}$/.test(rawExtension) ? rawExtension : ".mp4";
    const safeScene = String(sceneId || "scene").replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeAttempt = String(attemptId || "attempt").replace(/[^a-zA-Z0-9_-]/g, "_");
    const targetDir = path.resolve(downloadDir);
    fs.mkdirSync(targetDir, { recursive: true });
    const target = path.join(targetDir, `${safeScene}__${safeAttempt}${extension}`);
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite an existing scene/attempt download: ${target}`);
    await download.saveAs(target);
    if (!fs.statSync(target).size) throw new Error("Downloaded media file is empty.");
    return { downloadedFile: target, mediaUri, downloadError: null };
  } catch (error) {
    return { downloadedFile: null, mediaUri, downloadError: String(error.message || error) };
  }
}

function createConfirmationReader() {
  // Buffer stdin lines immediately, before browser preflight can finish. This supports
  // piped/scripted confirmations even when stdin reaches EOF before the first question.
  const interface_ = readline.createInterface({ input, crlfDelay: Infinity, terminal: Boolean(input.isTTY) });
  const queued = [];
  const waiters = [];
  let closed = false;
  interface_.on("line", line => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else queued.push(line);
  });
  interface_.on("close", () => {
    closed = true;
    waiters.splice(0).forEach(waiter => waiter.reject(new Error("stdin closed")));
  });
  return {
    question(prompt) {
      output.write(prompt);
      if (queued.length) return Promise.resolve(queued.shift());
      if (closed) return Promise.reject(new Error("stdin closed"));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close() { interface_.close(); },
  };
}

async function askExact(rl, prompt, expected) {
  let answer;
  try { answer = (await rl.question(prompt)).trim(); }
  catch { throw new Error("Confirmation input closed before an answer. No Create click was performed."); }
  if (answer !== expected) throw new Error("Confirmation did not match. No Create click was performed.");
}

async function waitForCreateEnabled(page, create, timeout = 5000) {
  const handle = await create.elementHandle();
  if (!handle) throw new Error("Create button disappeared before enabled-state wait.");
  try {
    await page.waitForFunction(element => element.isConnected
      && !element.disabled
      && element.getAttribute("aria-disabled") !== "true", handle, { timeout });
  } catch {
    throw new Error(`Create button did not become enabled within ${timeout}ms after filling prompt.`);
  }
  if (!(await create.isEnabled().catch(() => false))) {
    throw new Error("Create button still reports disabled after its DOM enabled state changed.");
  }
}

async function closeIngredientsPicker(page, selectors) {
  const backdropSelector = selectors.ingredient_picker_backdrop || ".cdk-overlay-backdrop-showing";
  const backdrop = page.locator(backdropSelector);
  const count = await backdrop.count().catch(() => 0);
  if (count === 0) return;
  const visible = await backdrop.last().isVisible().catch(() => false);
  if (!visible) return;
  const bounds = await backdrop.last().boundingBox().catch(() => null);
  if (!bounds) throw new Error("Ingredients picker backdrop is visible but has no bounding box; cannot verify picker closure.");
  await backdrop.last().click({ position: { x: 5, y: 5 }, timeout: 2500, force: true });
  try {
    await page.waitForFunction(selector => !Array.from(document.querySelectorAll(selector)).some(node => {
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
    }), backdropSelector, { timeout: 2500 });
  } catch {
    throw new Error("Clicked the edge of the Ingredients picker backdrop, but the overlay is still open.");
  }
  const remaining = await backdrop.count().catch(() => -1);
  if (remaining > 0 && await backdrop.last().isVisible().catch(() => false)) {
    throw new Error("Ingredients picker closure verification failed; backdrop remains visible.");
  }
}

async function clearPromptContentsVerified(prompt, selectors, timeout = 2500) {
  const page = prompt.page();
  const clearButton = await exactVisibleLocator(page, selectors.clear_prompt, "Clear prompt button");
  await clearButton.click({ timeout: 2500 });
  const handle = await prompt.elementHandle();
  if (!handle) throw new Error("Prompt textbox disappeared before empty-state verification.");
  try {
    await page.waitForFunction(element => {
      const value = ("value" in element) ? element.value : (element.innerText || element.textContent || "");
      return String(value).trim() === "";
    }, handle, { timeout });
  } catch {
    throw new Error("Clear prompt was clicked but textbox did not become empty within the verification timeout.");
  }
  const remaining = await handle.evaluate(element => ("value" in element) ? element.value : (element.innerText || element.textContent || ""));
  if (String(remaining).trim() !== "") throw new Error("Clear prompt verification failed; textbox still contains text.");
  const chipCount = await page.locator(selectors.ingredient_reference_items).count().catch(() => -1);
  if (chipCount !== 0) throw new Error(`Clear prompt removed text but left ${chipCount} Ingredients chip(s).`);
}

async function clearPromptVerified(prompt, selectors, timeout = 2500) {
  await closeIngredientsPicker(prompt.page(), selectors);
  await clearPromptContentsVerified(prompt, selectors, timeout);
}

async function listPages(browser) {
  const pages = [];
  for (let contextIndex = 0; contextIndex < browser.contexts().length; contextIndex += 1) {
    const context = browser.contexts()[contextIndex];
    for (const page of context.pages()) {
      pages.push({ index: pages.length, contextIndex, page, url: page.url(), title: await page.title().catch(() => "") });
    }
  }
  return pages;
}

async function inspect(browser) {
  const pages = await listPages(browser);
  if (!pages.length) console.log("No pages were exposed by CDP. Runner did not open or navigate a tab.");
  for (const item of pages) {
    const recognized = isFlowUrl(item.url);
    console.log(`[${item.index}] context=${item.contextIndex} flow=${recognized ? "YES" : "no"} title=${JSON.stringify(item.title)}\n    ${item.url}`);
    if (recognized) {
      const text = (await item.page.locator("body").innerText({ timeout: 2500 }).catch(() => "")).replace(/\s+/g, " ").trim();
      console.log(`    visible text: ${text.slice(0, 2200)}`);
      const controls = await item.page.locator("button, input, textarea, select, [role=button], [role=combobox], [contenteditable=true]")
        .evaluateAll(nodes => nodes.slice(0, 80).map(node => ({
          tag: node.tagName.toLowerCase(), role: node.getAttribute("role"), aria: node.getAttribute("aria-label"),
          placeholder: node.getAttribute("placeholder"), text: (node.innerText || node.value || "").trim().slice(0, 120),
          disabled: Boolean(node.disabled),
        }))).catch(() => []);
      console.log("    controls:", JSON.stringify(controls));
    }
  }
  console.log("\nRead-only inspection complete. No navigation, fill, click, or generation was performed.");
}

async function exactVisibleLocator(page, selector, label, timeout = 2500) {
  if (typeof selector !== "string" || !selector.trim()) throw new Error(`Missing selector for ${label} in selector config.`);
  const locator = page.locator(selector);
  let count;
  try { count = await locator.count(); }
  catch (error) { throw new Error(`Could not evaluate selector for ${label}: ${error.message}`); }
  if (count !== 1) throw new Error(`Selector for ${label} matched ${count} elements; expected exactly one. Stopping safely.`);
  if (!(await locator.isVisible({ timeout }).catch(() => false))) throw new Error(`Selector for ${label} is not visible. Stopping safely.`);
  return locator;
}

async function checkedRadio(page, selector, value, label) {
  const locator = await exactVisibleLocator(page, selector, label);
  const role = await locator.getAttribute("role");
  if (role !== "radio") throw new Error(`The ${label} selector must match a role=radio element.`);
  const labelText = (await locator.innerText()).replace(/\\s+/g, " ").trim();
  if (!labelText.includes(value)) throw new Error(`The ${label} selector text ${JSON.stringify(labelText)} does not match expected value ${JSON.stringify(value)}.`);
  const checked = await locator.getAttribute("aria-checked");
  if (checked !== "true") {
    await locator.click({ timeout: 2500 });
    const after = await locator.getAttribute("aria-checked");
    if (after !== "true") throw new Error(`Could not verify ${label}=${value}; aria-checked is ${JSON.stringify(after)}. Stopping safely.`);
  }
}

async function chooseModel(page, selectors, model) {
  const trigger = await exactVisibleLocator(page, selectors.model, "model selector");
  await trigger.click({ timeout: 2500 });
  const option = page.locator(selectors.model_option);
  try {
    await option.waitFor({ state: "visible", timeout: 5000 });
  } catch {
    throw new Error("Model option did not become visible within 5000ms after opening the model menu.");
  }
  const verifiedOption = await exactVisibleLocator(page, selectors.model_option, "model option");
  const rawText = (await verifiedOption.innerText()).trim();
  // Flow prepends a material icon ligature (e.g. volume_up); compare the final visible text line exactly.
  const text = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
  if (text !== model) throw new Error(`Model option text mismatch: expected ${JSON.stringify(model)}, got ${JSON.stringify(text)}.`);
  await verifiedOption.click({ timeout: 2500 });
  const selected = await exactVisibleLocator(page, selectors.model, "model selector after selection");
  const selectedText = (await selected.innerText()).trim();
  if (!selectedText.includes(model)) throw new Error(`Model selection did not persist; current label is ${JSON.stringify(selectedText)}.`);
}


function assetUuidFromUrl(value) {
  const match = String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return match?.[0]?.toLowerCase() || null;
}

async function waitForChipImagesReady(page, selectors, timeout = 15000) {
  try {
    await page.waitForFunction(selector => {
      const chips = Array.from(document.querySelectorAll(selector));
      return chips.every(chip => {
        const image = chip.querySelector("img.chip-image");
        return Boolean(image && image.complete && image.naturalWidth > 0);
      });
    }, selectors.ingredient_reference_items, { timeout });
  } catch {
    throw new Error(`One or more Ingredients chip thumbnails did not finish loading within ${timeout}ms.`);
  }
}

async function verifyAttachedReferenceUuids(page, selectors, expectedUuids, timeout = 15000) {
  await waitForChipImagesReady(page, selectors, timeout);
  const chips = page.locator(selectors.ingredient_reference_items);
  const count = await chips.count();
  if (count !== expectedUuids.length) {
    throw new Error(`Ingredients chip count changed: expected ${expectedUuids.length}, observed ${count}.`);
  }
  const actualUuids = [];
  for (let i = 0; i < count; i += 1) {
    const src = await chips.nth(i).locator("img.chip-image").getAttribute("src").catch(() => null);
    actualUuids.push(assetUuidFromUrl(src));
  }
  if (actualUuids.some(uuid => !uuid)) throw new Error("One or more attached Ingredients chips have no verifiable UUID.");
  if (actualUuids.some((uuid, index) => uuid !== expectedUuids[index])) {
    throw new Error(`Ingredients chip UUID/order mismatch: expected ${expectedUuids.join(", ")}, observed ${actualUuids.join(", ")}.`);
  }
  return actualUuids;
}

async function openIngredientsPicker(page, selectors) {
  const addButton = await exactVisibleLocator(page, selectors.ingredient_add_button, "add ingredients button");
  await addButton.click({ timeout: 2500 });
  await page.locator(selectors.ingredient_library_item).first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
}

async function uploadSceneReferencesUnsafe(page, selectors, referenceImages) {
  const chips = page.locator(selectors.ingredient_reference_items);
  const beforeCount = await chips.count().catch(() => -1);
  if (beforeCount !== 0) throw new Error(`Ingredients already contains ${beforeCount} reference chip(s); clear the prompt manually and rerun so this run can prove which images it attached.`);
  const expectedUuids = [];

  for (const imagePath of referenceImages) {
    const filename = path.basename(imagePath);
    await openIngredientsPicker(page, selectors);
    const picker = page.locator(selectors.ingredient_library_item);
    const matchingAssets = picker.filter({ hasText: filename });
    const existingUuids = new Set();
    const existingCount = await matchingAssets.count().catch(() => 0);
    for (let i = 0; i < existingCount; i += 1) {
      const src = await matchingAssets.nth(i).locator("img").first().getAttribute("src").catch(() => null);
      const uuid = assetUuidFromUrl(src);
      if (uuid) existingUuids.add(uuid);
    }

    const uploadButton = await exactVisibleLocator(page, selectors.ingredient_upload_button, "Upload media button");
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
    await uploadButton.click({ timeout: 2500 });
    const chooser = await chooserPromise;
    await chooser.setFiles(imagePath);
    let reusedExistingUuid = null;
    try {
      await page.waitForFunction(({ selector, filename, oldUuids }) => {
        // Flow inserts the newest upload at the top. Wait for the first same-name entry's
        // thumbnail UUID rather than accepting a slower-loading old duplicate lower in the list.
        const newestMatch = Array.from(document.querySelectorAll(selector)).find(asset =>
          (asset.innerText || asset.textContent || "").includes(filename));
        if (!newestMatch) return false;
        const src = newestMatch.querySelector("img")?.getAttribute("src") || "";
        const match = src.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
        return Boolean(match && !oldUuids.includes(match[0].toLowerCase()));
      }, { selector: selectors.ingredient_library_item, filename, oldUuids: Array.from(existingUuids) }, { timeout: ASSET_READY_TIMEOUT_MS });
    } catch {
      const diagnostics = [];
      const countAfterTimeout = await matchingAssets.count().catch(() => 0);
      for (let i = 0; i < countAfterTimeout; i += 1) {
        const src = await matchingAssets.nth(i).locator("img").first().getAttribute("src").catch(() => null);
        const uuid = assetUuidFromUrl(src);
        if (uuid) diagnostics.push(uuid);
      }
      // Flow can deduplicate an upload and keep the existing project-library UUID.
      // Reuse is allowed only when the existing same-name asset has a readable UUID;
      // the dry-run reports it so the operator can inspect the thumbnail before execution.
      reusedExistingUuid = diagnostics.find(uuid => existingUuids.has(uuid)) || null;
      console.warn(JSON.stringify({
        event: reusedExistingUuid ? "asset_upload_reused_existing" : "asset_upload_uuid_timeout",
        filename,
        timeout_ms: ASSET_READY_TIMEOUT_MS,
        existing_uuids_before_upload: Array.from(existingUuids),
        matching_uuids_after_timeout: diagnostics,
        selected_existing_uuid: reusedExistingUuid,
      }));
      if (!reusedExistingUuid) {
        throw new Error("Upload " + filename + " did not expose a new UUID within " + ASSET_READY_TIMEOUT_MS + "ms and no reusable same-name asset UUID was verifiable. Stopping before prompt fill/Create.");
      }
    }
    let asset = matchingAssets.first();
    if (reusedExistingUuid) {
      let reuseIndex = -1;
      const currentCount = await matchingAssets.count().catch(() => 0);
      for (let i = 0; i < currentCount; i += 1) {
        const src = await matchingAssets.nth(i).locator("img").first().getAttribute("src").catch(() => null);
        if (assetUuidFromUrl(src) === reusedExistingUuid) { reuseIndex = i; break; }
      }
      if (reuseIndex < 0) throw new Error("Reusable asset UUID disappeared from the library; refusing to select an unverified item.");
      asset = matchingAssets.nth(reuseIndex);
    }
    const assetSrc = await asset.locator("img").first().getAttribute("src").catch(() => null);
    const assetUuid = assetUuidFromUrl(assetSrc);
    if (!assetUuid || (existingUuids.has(assetUuid) && assetUuid !== reusedExistingUuid)) {
      throw new Error("Library entry for " + filename + " did not have a verifiable new UUID or an explicitly identified reusable UUID.");
    }
    if (reusedExistingUuid) console.warn(`Reusing existing Flow library asset ${filename} -> UUID ${assetUuid}; inspect its thumbnail during dry-run before any execute.`);

    await asset.click({ timeout: 2500 });
    let attached = false;
    const chipsAfterClick = await chips.count().catch(() => -1);
    for (let i = 0; i < chipsAfterClick; i += 1) {
      const src = await chips.nth(i).locator("img.chip-image").getAttribute("src").catch(() => null);
      if (assetUuidFromUrl(src) === assetUuid) attached = true;
    }
    if (!attached) {
      const addToPrompt = await exactVisibleLocator(page, selectors.ingredient_add_to_prompt, "Add to prompt button");
      await addToPrompt.click({ timeout: 2500 });
      try {
        await page.waitForFunction(({ selector, uuid }) => Array.from(document.querySelectorAll(selector)).some(chip => {
          const src = chip.querySelector("img.chip-image")?.getAttribute("src") || "";
          return src.toLowerCase().includes(uuid);
        }), { selector: selectors.ingredient_reference_items, uuid: assetUuid }, { timeout: 5000 });
      } catch {
        await closeIngredientsPicker(page, selectors);
        throw new Error(`Asset ${filename} was selected but its UUID ${assetUuid} never appeared in an attached prompt chip. Stopping before prompt fill/Create.`);
      }
    }
    await closeIngredientsPicker(page, selectors);
    const attachedUuids = [];
    const finalChipCount = await chips.count();
    for (let i = 0; i < finalChipCount; i += 1) {
      const src = await chips.nth(i).locator("img.chip-image").getAttribute("src").catch(() => null);
      attachedUuids.push(assetUuidFromUrl(src));
    }
    if (attachedUuids.some(uuid => !uuid)) throw new Error(`One or more prompt chips lack a verifiable asset UUID after attaching ${filename}.`);
    if (new Set(attachedUuids).size !== attachedUuids.length) throw new Error("Duplicate Ingredients chip UUID detected; refusing to continue.");
    if (!attachedUuids.includes(assetUuid)) throw new Error(`Attached chip identity mismatch for ${filename}: expected asset UUID ${assetUuid}, observed ${attachedUuids.join(", ")}.`);
    expectedUuids.push(assetUuid);
    console.log(`Verified Ingredients asset ${filename} -> UUID ${assetUuid}`);
  }

  const finalCount = await chips.count();
  if (finalCount !== referenceImages.length) throw new Error(`Ingredients chip count mismatch: expected ${referenceImages.length}, observed ${finalCount}. Stopping before prompt fill/Create.`);
  await verifyAttachedReferenceUuids(page, selectors, expectedUuids);
  console.log(`Verified exact asset identity and loaded thumbnails for ${finalCount} reference chip(s).`);
  return expectedUuids;
}

async function uploadSceneReferences(page, selectors, referenceImages, prompt) {
  let uploadError = null;
  try {
    return await uploadSceneReferencesUnsafe(page, selectors, referenceImages);
  } catch (error) {
    uploadError = error;
    throw error;
  } finally {
    if (uploadError) {
      const cleanup = [];
      try {
        await closeIngredientsPicker(page, selectors);
        cleanup.push("picker closed and verified");
      } catch (closeError) {
        cleanup.push(`picker closure FAILED: ${closeError.message}`);
      }
      try {
        // Attempt clearing even if backdrop closure verification failed; report either failure explicitly.
        await clearPromptContentsVerified(prompt, selectors, 4000);
        cleanup.push("prompt and Ingredients chips cleared and verified");
      } catch (clearError) {
        cleanup.push(`prompt/chip cleanup FAILED: ${clearError.message}`);
      }
      console.error(`Upload failure cleanup (finally): ${cleanup.join("; ")}`);
    }
  }
}

function requiredSelectorConfig(selectors) {
  const required = ["prompt", "settings_trigger", "model", "model_option", "resolution", "ingredients_mode", "ingredient_add_button", "ingredient_upload_button", "ingredient_library_item", "ingredient_add_to_prompt", "ingredient_reference_items", "clear_prompt", "aspect_9_16", "duration", "create"];
  for (const key of required) {
    if (typeof selectors[key] !== "string" || !selectors[key].trim()) {
      throw new Error(`Selector config must provide a non-empty CSS selector for '${key}'.`);
    }
  }
}

async function loadInputs(args) {
  if (!args.scene || !args.selectors || args.tab === null || !args.accountLabel || !args.expectedEmail) {
    throw new Error("--tab, --scene, --selectors, --account-label, and --expected-email are required outside --inspect.");
  }
  const scenePath = path.resolve(args.scene);
  const scene = JSON.parse(fs.readFileSync(scenePath, "utf8"));
  const selectors = JSON.parse(fs.readFileSync(args.selectors, "utf8"));
  if (typeof scene.scene_id !== "string" || !scene.scene_id.trim()) throw new Error("Scene JSON must contain a non-empty scene_id.");
  if (typeof scene.prompt !== "string" || !scene.prompt.trim()) throw new Error("Scene JSON must contain a non-empty prompt.");
  const faceDescriptionMode = scene.face_description_mode || "include";
  if (!["include", "reference_only"].includes(faceDescriptionMode)) {
    throw new Error("face_description_mode must be 'include' or 'reference_only'.");
  }
  const characterDescription = typeof scene.character_description === "string" ? scene.character_description.trim() : "";
  if (faceDescriptionMode === "include" && !characterDescription) {
    throw new Error("Scene JSON must contain a non-empty character_description unless face_description_mode is 'reference_only'.");
  }
  if (!/^[\x00-\x7F]+$/.test(scene.prompt)) throw new Error("Prompt must be ASCII/English only; non-ASCII characters are blocked before touching Flow.");
  if (characterDescription && !/^[\x00-\x7F]+$/.test(characterDescription)) throw new Error("Character description must be ASCII/English only; non-ASCII characters are blocked before touching Flow.");
  if (!Array.isArray(scene.reference_images) || scene.reference_images.length < 1 || scene.reference_images.length > 3) {
    throw new Error("Scene JSON must provide reference_images as an array of 1 to 3 local file paths.");
  }
  const referenceImages = scene.reference_images.map((value, index) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`reference_images[${index}] must be a non-empty local path.`);
    const resolved = path.resolve(path.dirname(scenePath), value);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Reference image does not exist or is not a file: ${resolved}`);
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(resolved).toLowerCase())) {
      throw new Error(`Reference image must be PNG, JPG, JPEG, or WEBP: ${resolved}`);
    }
    return resolved;
  });
  if (new Set(referenceImages).size !== referenceImages.length) throw new Error("reference_images must contain distinct file paths.");
  const resolveReferencePath = (value, label) => {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must identify a path from reference_images.`);
    const resolved = path.resolve(path.dirname(scenePath), value);
    if (!referenceImages.includes(resolved)) throw new Error(`${label} must match one of the image paths in this job's reference_images.`);
    return resolved;
  };
  let faceReferenceImages;
  if (scene.face_reference_ids !== undefined) {
    if (!Array.isArray(scene.face_reference_ids) || scene.face_reference_ids.length < 1 || scene.face_reference_ids.length > 3) {
      throw new Error("face_reference_ids must be an array of 1 to 3 paths from reference_images.");
    }
    faceReferenceImages = scene.face_reference_ids.map((value, index) => resolveReferencePath(value, `face_reference_ids[${index}]`));
    if (new Set(faceReferenceImages).size !== faceReferenceImages.length) throw new Error("face_reference_ids must contain distinct paths.");
  } else {
    const requestedFaceReference = scene.face_reference_id;
    const legacyFaceReference = requestedFaceReference === undefined || requestedFaceReference === null || requestedFaceReference === ""
      ? referenceImages[0]
      : resolveReferencePath(requestedFaceReference, "face_reference_id");
    faceReferenceImages = [legacyFaceReference];
  }
  scene.face_reference_ids = faceReferenceImages.map(imagePath => scene.reference_images.find(value =>
    path.resolve(path.dirname(scenePath), value) === imagePath));
  scene.face_reference_id = scene.face_reference_ids[0];
  const primaryFaceReferenceImage = faceReferenceImages[0];
  // Attach all selected face angles first, then non-face/supporting images.
  const orderedReferenceImages = [
    ...faceReferenceImages,
    ...referenceImages.filter(imagePath => !faceReferenceImages.includes(imagePath)),
  ];
  scene.character_description = characterDescription;
  scene.scene_prompt = scene.prompt;
  const faceIdentityInstructions = "PRIMARY FACE REFERENCE: The first attached image is the primary face identity anchor. Match its facial structure, eye shape and spacing, nose, lips, jawline, cheek fullness, and overall likeness as closely as possible. Keep the same person throughout the clip.";
  const additionalFaceInstructions = faceReferenceImages.length > 1
    ? "The next attached face-reference image(s) show the same person from additional angles. Use them to understand the same identity, not as different people."
    : "";
  const characterDescriptionInstructions = faceDescriptionMode === "reference_only"
    ? "Use the selected face reference image(s) as the source of truth for facial appearance. Do not invent or reinterpret face shape, cheeks, chin, eyes, eyebrows, or smile from a text description."
    : `CHARACTER DESCRIPTION: ${characterDescription}`;
  scene.prompt = `${faceIdentityInstructions}\n${additionalFaceInstructions}\n${characterDescriptionInstructions}\n\nSCENE: ${scene.prompt.trim()}\n\nUse only the remaining non-face reference images as supporting references for clothing, body, or context. Do not let them override the selected face references. Preserve the person's facial features, hair, and skin tone. Do not substitute a different person.`;
  if (!/^[\x00-\x7F]+$/.test(scene.prompt)) throw new Error("Composed prompt must contain ASCII characters only.");
  if (scene.model !== "Omni 1.1 Flash" || scene.resolution !== "360p") {
    throw new Error("Phase 3 pilot is restricted to model='Omni 1.1 Flash' and resolution='360p'.");
  }
  if (scene.duration && scene.duration !== "8s") throw new Error("Phase 3 pilot is restricted to duration='8s'.");
  requiredSelectorConfig(selectors);
  return { scene, selectors, referenceImages: orderedReferenceImages, faceReferenceImage: primaryFaceReferenceImage, faceReferenceImages };
}
async function chooseFlowTab(browser, args) {
  const pages = await listPages(browser);
  if (args.tab >= pages.length) throw new Error(`--tab ${args.tab} is out of range; inspect the current list and select an existing tab.`);
  const chosen = pages[args.tab];
  if (!isFlowUrl(chosen.url)) throw new Error(`Selected tab is not a recognized Google Flow project page: ${chosen.url}. Runner will not navigate to Flow.`);
  const projectId = flowProjectId(chosen.url);
  if (args.expectedProject && projectId !== args.expectedProject) {
    throw new Error(`Selected project ID ${JSON.stringify(projectId)} does not match --expected-project ${JSON.stringify(args.expectedProject)}.`);
  }
  return { ...chosen, projectId };
}

async function closeAccountMenuIfOpen(page, selectors, expectedEmail) {
  // Escape first to dismiss transient menus. Only click the account button if a visible
  // menu/dialog still looks like Google's account panel; do not toggle unrelated UI.
  await page.keyboard.press("Escape").catch(() => {});
  const panels = page.locator(selectors.account_menu || '[role="menu"]:visible, [role="dialog"]:visible');
  const count = await panels.count().catch(() => 0);
  let accountPanelVisible = false;
  for (let i = 0; i < count; i += 1) {
    const panel = panels.nth(i);
    if (!(await panel.isVisible().catch(() => false))) continue;
    const text = (await panel.innerText().catch(() => "")).toLowerCase();
    if (text.includes("google account") || text.includes("manage your google account")
      || (expectedEmail && text.includes(expectedEmail.toLowerCase()))) {
      accountPanelVisible = true;
      break;
    }
  }
  if (accountPanelVisible) {
    const accountSelector = selectors.account_button || '[role="button"][aria-label^="Google Account:"]';
    const accountButton = await exactVisibleLocator(page, accountSelector, "Google account button for menu cleanup").catch(() => null);
    if (accountButton) await accountButton.click({ timeout: 2000 }).catch(() => {});
  }
  try {
    await page.waitForFunction(selector => !Array.from(document.querySelectorAll(selector)).some(node => {
      const style = window.getComputedStyle(node);
      return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0;
    }), selectors.account_menu || '[role="menu"], [role="dialog"]', { timeout: 3000 });
  } catch {
    // Do not mask the original preflight error if the UI has a non-account dialog.
  }
}

async function verifyAccount(page, selectors, expectedEmail) {
  const selector = selectors.account_button || '[role="button"][aria-label^="Google Account:"]';
  const account = await exactVisibleLocator(page, selector, "Google account button");
  const label = await account.getAttribute("aria-label") || "";
  const match = label.match(/\(([^()\s]+@[^()\s]+)\)\s*$/);
  const observedEmail = match?.[1]?.toLowerCase() ?? null;
  if (!observedEmail) throw new Error(`Could not read an email from the Google account button aria-label ${JSON.stringify(label)}.`);
  if (observedEmail !== expectedEmail.toLowerCase()) {
    throw new Error(`Google account mismatch: expected ${expectedEmail}, observed ${observedEmail}. No page fields were changed.`);
  }
  return { observedEmail, ariaLabel: label };
}

async function readCreditCost(page) {
  const text = (await page.locator("body").innerText({ timeout: 2500 }).catch(() => "")).replace(/\s+/g, " ");
  const match = text.match(/Generating will use\s+(\d+)\s+credits?/i);
  return match ? Number(match[1]) : null;
}

async function prepare(args, browser, rl) {
  const { scene, selectors, referenceImages, faceReferenceImage } = await loadInputs(args);
  waitForSelectors(selectors, args);
  const chosen = await chooseFlowTab(browser, args);
  const originalUrl = chosen.page.url();
  let promptForCleanup = null;
  let createMayHaveBeenClicked = false;
  try {
  console.log(`Selected existing tab [${chosen.index}] context=${chosen.contextIndex}\nTitle: ${chosen.title}\nURL: ${chosen.url}\nProject ID: ${chosen.projectId || "legacy Flow route"}`);
  const account = await verifyAccount(chosen.page, selectors, args.expectedEmail);
  console.log(`Verified account email from page DOM: ${account.observedEmail}`);
  await askExact(
    rl,
    `Confirm account ${account.observedEmail} has available credit and this is the intended Flow project. Type CONFIRM ACCOUNT ${args.accountLabel} HAS CREDIT: `,
    `CONFIRM ACCOUNT ${args.accountLabel} HAS CREDIT`,
  );

  const prompt = promptForCleanup = await exactVisibleLocator(chosen.page, selectors.prompt, "prompt field");
  const create = await exactVisibleLocator(chosen.page, selectors.create, "Create button");
  const settings = await exactVisibleLocator(chosen.page, selectors.settings_trigger, "settings trigger");

  // Normalize the settings overlay state. If its controls are already visible, toggle it
  // closed first. A separate account-menu overlay is not dismissed blindly; stop safely.
  const modelAlreadyVisible = await chosen.page.locator(selectors.model).count() === 1
    && await chosen.page.locator(selectors.model).isVisible().catch(() => false);
  if (modelAlreadyVisible) {
    await settings.click({ timeout: 2500 }).catch(() => {
      throw new Error("Settings overlay could not be closed. Close the Flow overlay manually and rerun; prompt remains untouched.");
    });
  } else {
    const backdrop = chosen.page.locator(".cdk-overlay-backdrop:visible");
    if (await backdrop.count().catch(() => 0) > 0) {
      throw new Error("A Flow/account overlay is already open and blocks the settings control. Close the overlay manually and rerun; prompt remains untouched.");
    }
  }
  // Open settings; the model/radio controls are rendered only while this panel is open.
  await settings.click({ timeout: 2500 }).catch(() => {
    throw new Error("Could not open Flow settings (possibly blocked by an account overlay). Close any overlay manually and rerun; prompt remains untouched.");
  });

  // Settings controls render asynchronously after the trigger click.
  // Wait for the model selector before validating exact match count.
  // Any failure after opening settings, including this wait, must clean up overlays.
  let creditCost = null;
  try {
    try {
      await chosen.page.locator(selectors.model).waitFor({ state: "visible", timeout: 5000 });
    } catch {
      throw new Error("Model selector did not become visible within 5000ms after opening Settings.");
    }
    const model = await exactVisibleLocator(chosen.page, selectors.model, "model selector");
    const resolution = await exactVisibleLocator(chosen.page, selectors.resolution, "resolution radio");
    const ingredients = await exactVisibleLocator(chosen.page, selectors.ingredients_mode, "Ingredients mode radio");
    const aspect = await exactVisibleLocator(chosen.page, selectors.aspect_9_16, "9:16 aspect radio");
    const duration = await exactVisibleLocator(chosen.page, selectors.duration, "8s duration radio");
    const radioChecks = await Promise.all([resolution, ingredients, aspect, duration].map(locator => locator.getAttribute("role")));
    if (radioChecks.some(role => role !== "radio")) {
      throw new Error("Resolution, Ingredients, 9:16 and duration selectors must all match role=radio controls.");
    }

    await chooseModel(chosen.page, selectors, scene.model);
    await checkedRadio(chosen.page, selectors.resolution, scene.resolution, "resolution");
    await checkedRadio(chosen.page, selectors.ingredients_mode, "Ingredients", "Ingredients mode");
    await checkedRadio(chosen.page, selectors.aspect_9_16, "9:16", "aspect ratio");
    await checkedRadio(chosen.page, selectors.duration, scene.duration || "8s", "duration");

    // Read cost only after all settings are applied, so it reflects the final configuration.
    creditCost = await readCreditCost(chosen.page);

    const settingsAgain = await exactVisibleLocator(chosen.page, selectors.settings_trigger, "settings trigger to close panel");
    await settingsAgain.click({ timeout: 2500 });
  } catch (error) {
    // First close a nested model menu, then toggle Settings closed if it remains open.
    await chosen.page.keyboard.press("Escape").catch(() => {});
    const modelStillVisible = await chosen.page.locator(selectors.model).count().then(async count =>
      count === 1 && await chosen.page.locator(selectors.model).isVisible().catch(() => false)).catch(() => false);
    const overlayStillVisible = await chosen.page.locator(".cdk-overlay-backdrop:visible").count().catch(() => 0) > 0;
    if (modelStillVisible || overlayStillVisible) {
      await chosen.page.locator(selectors.settings_trigger).click({ timeout: 1500 }).catch(() => {});
      await chosen.page.keyboard.press("Escape").catch(() => {});
    }
    throw new Error(`Settings preparation failed; attempted to close Flow overlays before stopping: ${error.message}`);
  }
  if (chosen.page.url() !== originalUrl || !isFlowUrl(chosen.page.url())) {
    throw new Error("Flow tab URL changed unexpectedly while preparing. Stopping before Create.");
  }

  // Attach and verify the exact per-scene reference images only after closing Settings.
  // If Flow does not expose a unique add button, file input, and visible reference-item selector,
  // stop before filling the prompt or enabling a possible Create action.
  const attachedReferenceUuids = await uploadSceneReferences(chosen.page, selectors, referenceImages, prompt);
  if (args.waitForResult) {
    try {
      const initialBalance = await readCreditBalance(chosen.page, selectors);
      if (initialBalance === null) throw new Error("Could not read an integer credit balance.");
      const initialItems = await generatedItemKeys(chosen.page, selectors.generated_video_items);
      if (initialItems.some(key => !key) || new Set(initialItems).size !== initialItems.length) {
        throw new Error("generated_video_items selector must match distinct tiles with stable data-id, data-testid, href, link href, or media src keys.");
      }
      args._waitInitialBalance = initialBalance;
      args._waitInitialItemKeys = initialItems;
      args._waitInitialItemCount = initialItems.length;
      console.log("WAIT SELECTOR PREFLIGHT (read-only; no Create click)");
      console.log(JSON.stringify({ credit_balance: initialBalance, existing_video_tile_count: initialItems.length, existing_video_tile_keys: initialItems }, null, 2));
    } catch (error) {
      let cleanup = "Prompt/Ingredients cleanup was not verified.";
      try {
        await clearPromptVerified(prompt, selectors, 2500);
        cleanup = "Prompt and Ingredients were cleared and verified.";
      } catch (cleanupError) {
        cleanup += ` Cleanup error: ${cleanupError.message}`;
      }
      throw new Error(`Wait selector preflight failed: ${error.message}. ${cleanup}`);
    }
  }

  // Only now modify the prompt. If fill fails, attempt to clear it before returning an error.
  const screenshot = path.resolve(args.screenshot || `flow-pilot-${scene.scene_id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${args.execute ? "execute" : "dry-run"}.png`);
  try {
    await prompt.fill(scene.prompt, { timeout: 2500 });
    await waitForCreateEnabled(chosen.page, create, 5000);
    await verifyAttachedReferenceUuids(chosen.page, selectors, attachedReferenceUuids);
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await chosen.page.screenshot({ path: screenshot, fullPage: false, timeout: 4000 });
  } catch (error) {
    let cleanupStatus;
    try {
      await clearPromptVerified(prompt, selectors, 2500);
      cleanupStatus = "Prompt was cleared and verified empty.";
    } catch (cleanupError) {
      cleanupStatus = `CRITICAL: prompt could not be verified empty (${cleanupError.message}). Inspect Flow and clear it manually before continuing.`;
    }
    throw new Error(`Dry-run preparation failed after prompt fill: ${error.message}. ${cleanupStatus}`);
  }
  const createEnabled = await create.isEnabled().catch(() => false);
  console.log("\nREADY-TO-CREATE CHECK (reference images were attached and verified before this check)");
  console.log(JSON.stringify({
    mode: args.execute ? "execute-awaiting-final-confirmation" : "dry-run",
    account_email_verified: account.observedEmail,
    account_label: args.accountLabel,
    tab_index: chosen.index,
    context_index: chosen.contextIndex,
    project_id: chosen.projectId,
    url: chosen.page.url(),
    scene_id: scene.scene_id,
    reference_image_count: referenceImages.length,
    reference_image_names: referenceImages.map(file => path.basename(file)),
    face_reference_id: scene.face_reference_id,
    face_reference_image: path.basename(faceReferenceImage),
    reference_order: "primary face reference first, supporting references after",
    character_description: scene.character_description,
    model: scene.model,
    resolution: scene.resolution,
    ingredients_mode: "Ingredients",
    aspect_ratio: "9:16",
    duration: scene.duration || "8s",
    estimated_credit_cost: creditCost,
    prompt: scene.prompt,
    create_button_enabled: createEnabled,
    screenshot,
  }, null, 2));

  if (!args.execute) {
    if (args.clearAfterDryRun) {
      try {
        await clearPromptVerified(prompt, selectors, 2500);
      } catch (error) {
        throw new Error(`Dry-run finished but prompt could not be verified empty: ${error.message}. Clear it manually before continuing.`);
      }
      console.log("Dry-run prompt cleared.");
    }
    console.log("\nDRY RUN COMPLETE: stopped before clicking Create. No generation was submitted.");
    rl.close();
    return;
  }

  await askExact(rl, `This action may consume credit. Type CREATE ONE VIDEO FOR ${scene.scene_id} to submit exactly once: `,
    `CREATE ONE VIDEO FOR ${scene.scene_id}`);
  args._waitStartedOn = new Date().toISOString();
  appendEvent(args.log, {
    event: "submission_intent", scene_id: scene.scene_id, reference_image_count: referenceImages.length, reference_image_names: referenceImages.map(file => path.basename(file)), face_reference_id: scene.face_reference_id, face_reference_image: path.basename(faceReferenceImage), character_description: scene.character_description, model: scene.model, resolution: scene.resolution,
    prompt: scene.prompt, account_email: account.observedEmail, project_id: chosen.projectId,
    estimated_credit_cost: creditCost, url: chosen.page.url(), status: "submission_in_progress",
  });
  try {
    if (chosen.page.url() !== originalUrl || !isFlowUrl(chosen.page.url())) throw new Error("Flow tab changed after confirmation; refusing to click Create.");
    const currentAccount = await verifyAccount(chosen.page, selectors, args.expectedEmail);
    if (currentAccount.observedEmail !== account.observedEmail) throw new Error("Google account changed after confirmation; refusing to click Create.");
    // Recheck every chip UUID and loaded thumbnail after the operator's final confirmation.
    await verifyAttachedReferenceUuids(chosen.page, selectors, attachedReferenceUuids);
    const finalButton = await exactVisibleLocator(chosen.page, selectors.create, "Create button");
    if (!(await finalButton.isEnabled())) throw new Error("Create button became disabled; refusing to click.");
    if (args.waitForResult) {
      const currentBalance = await readCreditBalance(chosen.page, selectors);
      if (currentBalance === null) throw new Error("Credit balance could not be re-read immediately before Create; refusing to click.");
      args._waitInitialBalance = currentBalance;
      args._waitInitialItemKeys = await generatedItemKeys(chosen.page, selectors.generated_video_items);
      args._waitInitialItemCount = args._waitInitialItemKeys.length;
    }
    createMayHaveBeenClicked = true; // Conservatively preserve state if the click result is ambiguous.
    await finalButton.click({ timeout: 2500 });
    appendEvent(args.log, { event: "create_click_returned", scene_id: scene.scene_id, model: scene.model,
      resolution: scene.resolution, status: "submitted_unverified",
      note: "Click returned; generation completion and credit charge are not inferred." });
    console.log(`Create click returned once. Completion/credit status is unverified. Receipt: ${path.resolve(args.log)}`);
    if (args.waitForResult) {
      let resultStatus = "unknown";
      let mediaUri = chosen.page.url();
      let downloadedFile = null;
      let downloadError = null;
      let timeoutError = null;
      let afterBalance = null;
      let attemptNumber = 1;
      args._waitAttemptId = "attempt-" + randomUUID();
      try {
        attemptNumber = nextLedgerAttemptNumber(args.ledgerOutput, scene.scene_id);
        const result = await waitForGenerationAndDownload(chosen.page, selectors, {
          beforeKeys: args._waitInitialItemKeys,
          beforeCount: args._waitInitialItemCount,
          timeoutMs: args.waitTimeoutMs,
          downloadDir: args.downloadDir,
          sceneId: scene.scene_id,
          attemptId: args._waitAttemptId,
        });
        downloadedFile = result.downloadedFile;
        mediaUri = result.mediaUri || chosen.page.url();
        downloadError = result.downloadError;
        resultStatus = "succeeded";
      } catch (error) {
        timeoutError = String(error.message || error);
        mediaUri = chosen.page.url();
        appendEvent(args.log, { event: "generation_wait_unverified", scene_id: scene.scene_id, status: "unknown_do_not_retry", error: timeoutError });
        console.error(`WAIT STOPPED SAFELY: ${timeoutError}`);
      }
      // Detail pages do not expose credits; return to the original project before polling.
      if (chosen.page.url() !== originalUrl) {
        await chosen.page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      }
      // Start the polling budget only after navigation recovery has had its chance.
      const balanceDeadline = Date.now() + 30000;
      do {
        try { afterBalance = await readCreditBalance(chosen.page, selectors); } catch {}
        if (afterBalance !== null && args._waitInitialBalance !== null && afterBalance !== args._waitInitialBalance) break;
        await chosen.page.waitForTimeout(1000);
      } while (Date.now() < balanceDeadline);
      const ledgerRecord = makeGenerationLedgerRecord({
        scene, projectId: chosen.projectId, ledgerProjectId: args.ledgerProjectId, prompt: scene.prompt, estimatedCost: creditCost,
        beforeBalance: args._waitInitialBalance ?? null, afterBalance,
        resultStatus, mediaUri, downloadedFile, downloadError, timeoutError, attemptNumber, attemptId: args._waitAttemptId, startedOn: args._waitStartedOn,
      });
      try {
        const ledgerPath = appendGenerationLedger(args.ledgerOutput, ledgerRecord);
        appendEvent(args.log, { event: "generation_ledger_recorded", scene_id: scene.scene_id, attempt_id: ledgerRecord.attempt_id, status: ledgerRecord.result.status, ledger_path: ledgerPath, before_balance: ledgerRecord.credits.before_balance, after_balance: ledgerRecord.credits.after_balance, actual_amount: ledgerRecord.credits.actual_amount, charge_status: ledgerRecord.credits.charge_status, media_uri: ledgerRecord.media.uri, downloaded_file: ledgerRecord.media.downloaded_file });
        console.log(`Generation ledger appended: ${ledgerPath}`);
      } catch (error) {
        appendEvent(args.log, { event: "generation_ledger_write_failed", scene_id: scene.scene_id, error: String(error) });
        console.error(`CRITICAL: generation completed/unknown but ledger write failed: ${error.message}`);
        process.exitCode = 2;
      }
      if (resultStatus === "succeeded") {
        console.log(`Generation result verified. Media URI: ${mediaUri}`);
        if (downloadedFile) console.log(`Downloaded clip: ${downloadedFile}`);
        else {
          console.error(`Clip is ready but download failed: ${downloadError}`);
          process.exitCode = 2;
        }
      } else {
        console.error("Generation result remains unverified. Do NOT retry automatically; inspect Flow manually.");
        throw new Error("Generation was submitted but completion could not be verified; ledger recorded status=unknown.");
      }
    }
  } catch (error) {
    appendEvent(args.log, { event: "submission_outcome_unknown", scene_id: scene.scene_id,
      status: "unknown_do_not_retry", error: String(error) });
    console.error("Submission outcome is unknown. Do NOT click again or retry automatically. Inspect Flow manually.");
    throw error;
  }
  } catch (error) {
    // Any pre-submit failure after locating the prompt must leave Flow clean. In particular,
    // failures while building/printing READY-TO-CREATE metadata must not strand Ingredients chips.
    if (promptForCleanup && !createMayHaveBeenClicked) {
      try {
        await clearPromptVerified(promptForCleanup, selectors, 4000);
        console.error("Failure cleanup: prompt and Ingredients chips cleared and verified.");
      } catch (cleanupError) {
        console.error(`CRITICAL: failure cleanup could not verify prompt/chips empty: ${cleanupError.message}. Inspect Flow and clear manually before rerunning.`);
      }
    }
    await closeAccountMenuIfOpen(chosen.page, selectors, args.expectedEmail);
    if (args.waitForResult && chosen.page.url() !== originalUrl) {
      await chosen.page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
    }
    throw error;
  }
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.help) return usage();
  if (args.inspect && (args.scene || args.selectors || args.execute || args.expectedEmail || args.expectedProject)) {
    throw new Error("--inspect is read-only and cannot be combined with scene, selectors, --execute, or expected account/project.");
  }
  if (args.inspect) {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    try { await inspect(browser); } finally { await browser.close(); }
    return;
  }
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const rl = createConfirmationReader();
  try { await prepare(args, browser, rl); }
  finally {
    rl.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Flow Pilot stopped safely: ${error.message}`);
  process.exitCode = 2;
});

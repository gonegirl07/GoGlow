#!/usr/bin/env node
/**
 * Human-gated Google Flow pilot runner.
 * Dry-run prepares one scene and always stops before the non-idempotent Create click.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

const CDP_ENDPOINT = "http://127.0.0.1:9224";
const LEGACY_FLOW_HOST = "labs.google";
const FLOW_HOST = "flow.google.com";
const PROJECT_PATH = /^\/project\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i;

function argsOf(argv) {
  const args = { inspect: false, execute: false, dryRun: false, tab: null, scene: null, selectors: null,
    accountLabel: null, expectedEmail: null, expectedProject: null, log: "flow-pilot.jsonl", screenshot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--inspect") args.inspect = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--tab") args.tab = Number(argv[++i]);
    else if (arg === "--scene") args.scene = argv[++i];
    else if (arg === "--selectors") args.selectors = argv[++i];
    else if (arg === "--account-label") args.accountLabel = argv[++i];
    else if (arg === "--expected-email") args.expectedEmail = argv[++i];
    else if (arg === "--expected-project") args.expectedProject = argv[++i];
    else if (arg === "--log") args.log = argv[++i];
    else if (arg === "--screenshot") args.screenshot = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.inspect && args.execute) throw new Error("Use --inspect or --execute, not both.");
  if (args.execute && args.dryRun) throw new Error("Use --dry-run or --execute, not both.");
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

async function askExact(rl, prompt, expected) {
  let answer;
  try { answer = (await rl.question(prompt)).trim(); }
  catch { throw new Error("Confirmation input closed before an answer. No Create click was performed."); }
  if (answer !== expected) throw new Error("Confirmation did not match. No Create click was performed.");
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
  const option = await exactVisibleLocator(page, selectors.model_option, "model option");
  const text = (await option.innerText()).trim();
  if (text !== model) throw new Error(`Model option text mismatch: expected ${JSON.stringify(model)}, got ${JSON.stringify(text)}.`);
  await option.click({ timeout: 2500 });
  const selected = await exactVisibleLocator(page, selectors.model, "model selector after selection");
  const selectedText = (await selected.innerText()).trim();
  if (!selectedText.includes(model)) throw new Error(`Model selection did not persist; current label is ${JSON.stringify(selectedText)}.`);
}

function requiredSelectorConfig(selectors) {
  const required = ["prompt", "settings_trigger", "model", "model_option", "resolution", "ingredients_mode", "aspect_9_16", "duration", "create"];
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
  const scene = JSON.parse(fs.readFileSync(args.scene, "utf8"));
  const selectors = JSON.parse(fs.readFileSync(args.selectors, "utf8"));
  if (typeof scene.scene_id !== "string" || !scene.scene_id.trim()) throw new Error("Scene JSON must contain a non-empty scene_id.");
  if (typeof scene.prompt !== "string" || !scene.prompt.trim()) throw new Error("Scene JSON must contain a non-empty prompt.");
  if (!/^[\x00-\x7F]+$/.test(scene.prompt)) throw new Error("Prompt must be ASCII/English only; non-ASCII characters are blocked before touching Flow.");
  if (scene.model !== "Omni 1.1 Flash" || scene.resolution !== "360p") {
    throw new Error("Phase 3 pilot is restricted to model='Omni 1.1 Flash' and resolution='360p'.");
  }
  if (scene.duration && scene.duration !== "8s") throw new Error("Phase 3 pilot is restricted to duration='8s'.");
  requiredSelectorConfig(selectors);
  return { scene, selectors };
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

async function verifyAccount(page, selectors, expectedEmail) {
  const selector = selectors.account_button || 'button[aria-label^="Google Account:"]';
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
  const { scene, selectors } = await loadInputs(args);
  const chosen = await chooseFlowTab(browser, args);
  console.log(`Selected existing tab [${chosen.index}] context=${chosen.contextIndex}\nTitle: ${chosen.title}\nURL: ${chosen.url}\nProject ID: ${chosen.projectId || "legacy Flow route"}`);
  const account = await verifyAccount(chosen.page, selectors, args.expectedEmail);
  console.log(`Verified account email from page DOM: ${account.observedEmail}`);
  await askExact(
    rl,
    `Confirm account ${account.observedEmail} has available credit and this is the intended Flow project. Type CONFIRM ACCOUNT ${args.accountLabel} HAS CREDIT: `,
    `CONFIRM ACCOUNT ${args.accountLabel} HAS CREDIT`,
  );

  const originalUrl = chosen.page.url();
  const prompt = await exactVisibleLocator(chosen.page, selectors.prompt, "prompt field");
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
  const model = await exactVisibleLocator(chosen.page, selectors.model, "model selector");
  const resolution = await exactVisibleLocator(chosen.page, selectors.resolution, "resolution radio");
  const ingredients = await exactVisibleLocator(chosen.page, selectors.ingredients_mode, "Ingredients mode radio");
  const aspect = await exactVisibleLocator(chosen.page, selectors.aspect_9_16, "9:16 aspect radio");
  const duration = await exactVisibleLocator(chosen.page, selectors.duration, "8s duration radio");
  const creditCost = await readCreditCost(chosen.page);
  const radioChecks = await Promise.all([resolution, ingredients, aspect, duration].map(locator => locator.getAttribute("role")));
  if (radioChecks.some(role => role !== "radio")) throw new Error("Resolution, Ingredients, 9:16 and duration selectors must all match role=radio controls.");

  // Set and verify each setting while the settings panel is open. Never fill the prompt until
  // all settings and the Create/prompt controls have been successfully located.
  await chooseModel(chosen.page, selectors, scene.model);
  await checkedRadio(chosen.page, selectors.resolution, scene.resolution, "resolution");
  await checkedRadio(chosen.page, selectors.ingredients_mode, "Ingredients", "Ingredients mode");
  await checkedRadio(chosen.page, selectors.aspect_9_16, "9:16", "aspect ratio");
  await checkedRadio(chosen.page, selectors.duration, scene.duration || "8s", "duration");

  // The Flow overlay may intercept pointer events while open. The tester observed that
  // clicking the trigger again reliably closes it; use a short explicit timeout.
  const settingsAgain = await exactVisibleLocator(chosen.page, selectors.settings_trigger, "settings trigger to close panel");
  await settingsAgain.click({ timeout: 2500 });
  if (chosen.page.url() !== originalUrl || !isFlowUrl(chosen.page.url())) {
    throw new Error("Flow tab URL changed unexpectedly while preparing. Stopping before Create.");
  }

  // Only now modify the prompt. If fill fails, attempt to clear it before returning an error.
  const screenshot = path.resolve(args.screenshot || `flow-pilot-${scene.scene_id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${args.execute ? "execute" : "dry-run"}.png`);
  try {
    await prompt.fill(scene.prompt, { timeout: 2500 });
    const createEnabled = await create.isEnabled().catch(() => false);
    if (!createEnabled) throw new Error("Create button is disabled after filling prompt.");
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await chosen.page.screenshot({ path: screenshot, fullPage: false, timeout: 4000 });
  } catch (error) {
    await prompt.fill("", { timeout: 1500 }).catch(() => {});
    throw new Error(`Dry-run preparation failed after prompt fill; attempted to clear prompt: ${error.message}`);
  }
  const createEnabled = await create.isEnabled().catch(() => false);
  console.log("\nREADY-TO-CREATE CHECK");
  console.log(JSON.stringify({
    mode: args.execute ? "execute-awaiting-final-confirmation" : "dry-run",
    account_email_verified: account.observedEmail,
    account_label: args.accountLabel,
    tab_index: chosen.index,
    context_index: chosen.contextIndex,
    project_id: chosen.projectId,
    url: chosen.page.url(),
    scene_id: scene.scene_id,
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
    console.log("\nDRY RUN COMPLETE: stopped before clicking Create. No generation was submitted.");
    return;
  }

  await askExact(rl, `This action may consume credit. Type CREATE ONE VIDEO FOR ${scene.scene_id} to submit exactly once: `,
    `CREATE ONE VIDEO FOR ${scene.scene_id}`);
  appendEvent(args.log, {
    event: "submission_intent", scene_id: scene.scene_id, model: scene.model, resolution: scene.resolution,
    prompt: scene.prompt, account_email: account.observedEmail, project_id: chosen.projectId,
    estimated_credit_cost: creditCost, url: chosen.page.url(), status: "submission_in_progress",
  });
  try {
    if (chosen.page.url() !== originalUrl || !isFlowUrl(chosen.page.url())) throw new Error("Flow tab changed after confirmation; refusing to click Create.");
    const currentAccount = await verifyAccount(chosen.page, selectors, args.expectedEmail);
    if (currentAccount.observedEmail !== account.observedEmail) throw new Error("Google account changed after confirmation; refusing to click Create.");
    const finalButton = await exactVisibleLocator(chosen.page, selectors.create, "Create button");
    if (!(await finalButton.isEnabled())) throw new Error("Create button became disabled; refusing to click.");
    await finalButton.click({ timeout: 2500 });
    appendEvent(args.log, { event: "create_click_returned", scene_id: scene.scene_id, model: scene.model,
      resolution: scene.resolution, status: "submitted_unverified",
      note: "Click returned; generation completion and credit charge are not inferred." });
    console.log(`Create click returned once. Completion/credit status is unverified. Receipt: ${path.resolve(args.log)}`);
  } catch (error) {
    appendEvent(args.log, { event: "submission_outcome_unknown", scene_id: scene.scene_id,
      status: "unknown_do_not_retry", error: String(error) });
    console.error("Submission outcome is unknown. Do NOT click again or retry automatically. Inspect Flow manually.");
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
  const rl = readline.createInterface({ input, output });
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

#!/usr/bin/env node
/**
 * Human-gated Google Flow pilot runner.
 *
 * Default mode is a dry run: inspect an existing CDP-connected Flow tab, fill
 * only configured fields, verify the Create control, screenshot, and stop.
 * It never navigates, retries, or clicks Create in dry-run mode.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";

const CDP_ENDPOINT = "http://127.0.0.1:9224";
const FLOW_HOSTS = new Set(["labs.google"]);
const FLOW_PATH_MARKER = "/fx/tools/flow";

function argsOf(argv) {
  const args = { inspect: false, execute: false, tab: null, scene: null, selectors: null,
    accountLabel: null, log: "flow-pilot.jsonl", screenshot: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--inspect") args.inspect = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--tab") args.tab = Number(argv[++i]);
    else if (arg === "--scene") args.scene = argv[++i];
    else if (arg === "--selectors") args.selectors = argv[++i];
    else if (arg === "--account-label") args.accountLabel = argv[++i];
    else if (arg === "--log") args.log = argv[++i];
    else if (arg === "--screenshot") args.screenshot = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.inspect && args.execute) throw new Error("Use --inspect or --execute, not both.");
  if (args.tab !== null && (!Number.isInteger(args.tab) || args.tab < 0)) throw new Error("--tab must be a zero-based non-negative index.");
  return args;
}

function usage() {
  console.log(`GoGlow Flow Pilot (CDP ${CDP_ENDPOINT})

Read-only tab inventory:
  node scripts/flow-pilot.mjs --inspect

Default dry-run (fills configured fields, stops before Create):
  node scripts/flow-pilot.mjs --tab 0 --scene examples/flow-pilot-scene.example.json \\
    --selectors local/flow-selectors.json --account-label "my Flow account"

Actual one-scene submission (two interactive confirmations):
  node scripts/flow-pilot.mjs --execute --tab 0 --scene path/to/scene.json \\
    --selectors local/flow-selectors.json --account-label "my Flow account"

Never run --execute until the dry-run and selector inspection have passed.
`);
}

function isFlowUrl(value) {
  try {
    const url = new URL(value);
    return FLOW_HOSTS.has(url.hostname) && url.pathname.includes(FLOW_PATH_MARKER);
  } catch {
    return false;
  }
}

function appendEvent(logPath, event) {
  const absolute = path.resolve(logPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.appendFileSync(absolute, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { encoding: "utf8", flag: "a" });
}

async function askExact(rl, prompt, expected) {
  const answer = (await rl.question(prompt)).trim();
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
    console.log(`[${item.index}] context=${item.contextIndex} flow=${isFlowUrl(item.url) ? "YES" : "no"} title=${JSON.stringify(item.title)}\n    ${item.url}`);
    if (isFlowUrl(item.url)) {
      const text = (await item.page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      console.log(`    visible text: ${text.slice(0, 2200)}`);
      const controls = await item.page.locator("button, input, textarea, select, [role=button], [role=combobox], [contenteditable=true]")
        .evaluateAll(nodes => nodes.slice(0, 80).map(node => ({
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute("role"),
          aria: node.getAttribute("aria-label"),
          placeholder: node.getAttribute("placeholder"),
          text: (node.innerText || node.value || "").trim().slice(0, 120),
          disabled: Boolean(node.disabled),
        }))).catch(() => []);
      console.log("    controls:", JSON.stringify(controls));
    }
  }
  console.log("\nRead-only inspection complete. No navigation, fill, click, or generation was performed.");
}

async function exactVisibleLocator(page, selector, label) {
  if (typeof selector !== "string" || !selector.trim()) throw new Error(`Missing selector for ${label} in selector config.`);
  const locator = page.locator(selector);
  const count = await locator.count();
  if (count !== 1) throw new Error(`Selector for ${label} matched ${count} elements; expected exactly one. Stopping safely.`);
  if (!(await locator.isVisible())) throw new Error(`Selector for ${label} is not visible. Stopping safely.`);
  return locator;
}

async function setChoice(page, selector, value, label) {
  const locator = await exactVisibleLocator(page, selector, label);
  const tag = await locator.evaluate(element => element.tagName.toLowerCase());
  if (tag === "select") {
    const matched = await locator.locator("option").evaluateAll((options, desired) =>
      options.filter(option => option.label === desired || option.value === desired).length, value);
    if (matched !== 1) throw new Error(`The ${label} select does not have exactly one option labelled ${JSON.stringify(value)}.`);
    await locator.selectOption({ label: value }).catch(async () => locator.selectOption(value));
    return;
  }
  await locator.click();
  const option = page.getByRole("option", { name: value, exact: true });
  const count = await option.count();
  if (count !== 1 || !(await option.isVisible())) {
    throw new Error(`Could not uniquely identify the ${label} option ${JSON.stringify(value)}. Dropdown left open; no Create click was performed.`);
  }
  await option.click();
}

async function loadInputs(args) {
  if (!args.scene || !args.selectors || args.tab === null || !args.accountLabel) {
    throw new Error("--tab, --scene, --selectors, and --account-label are required outside --inspect.");
  }
  const scene = JSON.parse(fs.readFileSync(args.scene, "utf8"));
  const selectors = JSON.parse(fs.readFileSync(args.selectors, "utf8"));
  if (typeof scene.scene_id !== "string" || !scene.scene_id.trim()) throw new Error("Scene JSON must contain a non-empty scene_id.");
  if (typeof scene.prompt !== "string" || !scene.prompt.trim()) throw new Error("Scene JSON must contain a non-empty prompt.");
  if (scene.model !== "Omni 1.1 Flash" || scene.resolution !== "360p") {
    throw new Error("Phase 3 pilot is restricted to model='Omni 1.1 Flash' and resolution='360p'.");
  }
  for (const key of ["prompt", "model", "resolution", "create"]) {
    if (typeof selectors[key] !== "string" || !selectors[key].trim()) {
      throw new Error(`Selector config must provide a non-empty CSS selector for '${key}'.`);
    }
  }
  return { scene, selectors };
}

async function chooseFlowTab(browser, index) {
  const pages = await listPages(browser);
  if (index >= pages.length) throw new Error(`--tab ${index} is out of range; inspect the current list and select an existing tab.`);
  const chosen = pages[index];
  if (!isFlowUrl(chosen.url)) {
    throw new Error(`Selected tab is not a recognized Google Flow page: ${chosen.url}. Runner will not navigate to Flow.`);
  }
  return chosen;
}

async function prepare(args, browser, rl) {
  const { scene, selectors } = await loadInputs(args);
  const chosen = await chooseFlowTab(browser, args.tab);
  console.log(`Selected existing tab [${chosen.index}] context=${chosen.contextIndex}\nTitle: ${chosen.title}\nURL: ${chosen.url}`);
  const bodyText = (await chosen.page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  console.log(`Visible account/page text (read-only): ${bodyText.slice(0, 1600)}`);
  await askExact(
    rl,
    `Confirm the selected tab is account "${args.accountLabel}", is the account with available credit, and is the intended Flow workspace. Type CONFIRM ACCOUNT ${args.accountLabel} HAS CREDIT: `,
    `CONFIRM ACCOUNT ${args.accountLabel} HAS CREDIT`,
  );

  const originalUrl = chosen.page.url();
  const prompt = await exactVisibleLocator(chosen.page, selectors.prompt, "prompt field");
  await prompt.fill(scene.prompt);
  await setChoice(chosen.page, selectors.model, scene.model, "model");
  await setChoice(chosen.page, selectors.resolution, scene.resolution, "resolution");
  if (chosen.page.url() !== originalUrl || !isFlowUrl(chosen.page.url())) {
    throw new Error("Flow tab URL changed unexpectedly while preparing. Stopping before Create.");
  }
  const create = await exactVisibleLocator(chosen.page, selectors.create, "Create button");
  const createEnabled = await create.isEnabled();
  if (!createEnabled) throw new Error("Create button is disabled. Stopping safely.");
  const screenshot = path.resolve(args.screenshot || `flow-pilot-${scene.scene_id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${args.execute ? "execute" : "dry-run"}.png`);
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await chosen.page.screenshot({ path: screenshot, fullPage: false });
  console.log("\nREADY-TO-CREATE CHECK");
  console.log(JSON.stringify({
    mode: args.execute ? "execute-awaiting-final-confirmation" : "dry-run",
    account_label: args.accountLabel,
    tab_index: chosen.index,
    context_index: chosen.contextIndex,
    url: chosen.page.url(),
    scene_id: scene.scene_id,
    model: scene.model,
    resolution: scene.resolution,
    prompt: scene.prompt,
    create_button_enabled: createEnabled,
    screenshot,
  }, null, 2));

  if (!args.execute) {
    console.log("\nDRY RUN COMPLETE: stopped before clicking Create. No generation was submitted.");
    return;
  }

  await askExact(
    rl,
    `This action may consume credit. Type CREATE ONE VIDEO FOR ${scene.scene_id} to submit exactly once: `,
    `CREATE ONE VIDEO FOR ${scene.scene_id}`,
  );
  // Record intent before the non-idempotent click. If the click outcome is ambiguous,
  // never retry automatically; the receipt explicitly records an unknown outcome.
  appendEvent(args.log, {
    event: "submission_intent",
    scene_id: scene.scene_id,
    model: scene.model,
    resolution: scene.resolution,
    prompt: scene.prompt,
    account_label: args.accountLabel,
    url: chosen.page.url(),
    status: "submission_in_progress",
  });
  try {
    if (chosen.page.url() !== originalUrl || !isFlowUrl(chosen.page.url())) {
      throw new Error("Flow tab changed after confirmation; refusing to click Create.");
    }
    const finalButton = await exactVisibleLocator(chosen.page, selectors.create, "Create button");
    if (!(await finalButton.isEnabled())) throw new Error("Create button became disabled; refusing to click.");
    await finalButton.click({ timeout: 5000 });
    appendEvent(args.log, {
      event: "create_click_returned",
      scene_id: scene.scene_id,
      model: scene.model,
      resolution: scene.resolution,
      status: "submitted_unverified",
      note: "Click returned; generation completion and credit charge are not inferred.",
    });
    console.log(`Create click returned once. Completion/credit status is unverified. Receipt: ${path.resolve(args.log)}`);
  } catch (error) {
    appendEvent(args.log, {
      event: "submission_outcome_unknown",
      scene_id: scene.scene_id,
      status: "unknown_do_not_retry",
      error: String(error),
    });
    console.error("Submission outcome is unknown. Do NOT click again or retry automatically. Inspect Flow manually.");
    throw error;
  }
}

async function main() {
  const args = argsOf(process.argv.slice(2));
  if (args.help) return usage();
  if (args.inspect && (args.scene || args.selectors || args.execute)) {
    throw new Error("--inspect is read-only and cannot be combined with scene, selectors, or --execute.");
  }
  if (args.inspect) {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    try { await inspect(browser); } finally { await browser.close(); }
    return;
  }
  if (args.execute && !args.scene) throw new Error("--execute requires a scene JSON file.");
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const rl = readline.createInterface({ input, output });
  try {
    await prepare(args, browser, rl);
  } finally {
    rl.close();
    // Disconnect without intentionally closing user-owned tabs.
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Flow Pilot stopped safely: ${error.message}`);
  process.exitCode = 2;
});

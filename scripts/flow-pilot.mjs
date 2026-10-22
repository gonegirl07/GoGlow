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
  const parseBalance = text => {
    const match = String(text || "").replace(/,/g, "").match(/(?:^|\D)(\d+)(?:\D|$)/);
    return match ? Number(match[1]) : null;
  };
  const readVisible = async () => {
    try {
      const locator = await exactVisibleLocator(page, selector, "credit balance");
      return parseBalance(await locator.innerText({ timeout: 2500 }).catch(() => ""));
    } catch { return null; }
  };
  let balance = await readVisible();
  if (balance !== null || typeof selectors === "string") return balance;
  if (!selectors.account_panel_open || !selectors.account_panel_close) return null;
  const opener = await exactVisibleLocator(page, selectors.account_panel_open, "account panel open button").catch(() => null);
  if (!opener) return null;
  // Wait for asynchronous credit rendering; retry opening the account panel once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await opener.click({ timeout: 2500 }).catch(() => {});
    try {
      await page.locator(selector).first().waitFor({ state: "visible", timeout: 8000 });
      const locator = await exactVisibleLocator(page, selector, "credit balance after opening account panel", 2500);
      balance = parseBalance(await locator.innerText({ timeout: 2500 }).catch(() => ""));
      if (balance !== null) break;
    } catch {
      if (attempt === 1) break;
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300).catch(() => {});
    }
  }
  const closer = await exactVisibleLocator(page, selectors.account_panel_close, "account panel close button").catch(() => null);
  if (closer) {
    await closer.click({ timeout: 2500 }).catch(() => {});
    await page.locator(selectors.account_panel_close).waitFor({ state: "hidden", timeout: 2500 }).catch(() => {});
  }
  return balance;
}

async function generatedItemKeys(page, selector) {
  return page.locator(selector).evaluateAll(elements => elements.map(element => {
    const sources = [
      element.getAttribute("href"),
      element.querySelector("a[href]")?.getAttribute("href"),
      element.querySelector("video")?.getAttribute("src"),
      element.getAttribute("data-id"),
      element.querySelector("img")?.getAttribute("src"),
    ].filter(Boolean).map(String);
    const uuidFrom = value => {
      const matches = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
      return matches && matches.length ? matches[matches.length - 1].toLowerCase() : null;
    };
    const mediaUuid = sources.map(uuidFrom).find(Boolean);
    return mediaUuid ? `media:${mediaUuid}` : String(sources[0] || "").trim();
  }));
}

// Flow's media grid may virtualize its DOM. Sweep the grid's scroll container and
// union keys from every viewport instead of treating the first rendered batch as
// the complete project inventory. Restore the initial scroll position unless a
// target key was requested, in which case leave that tile in view for a safe click.
async function collectAllGeneratedItems(page, selector, { targetKey = null, maxScrolls = 120, uuidCache = new Map(), topLimit = null, selectors = {} } = {}) {
  const scrollInfo = await page.evaluate(selectorText => {
    const first = document.querySelector(selectorText);
    let node = first?.parentElement || null;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 8 && /(auto|scroll|overlay)/.test(style.overflowY)) {
        return { kind: "element", initialTop: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight };
      }
      node = node.parentElement;
    }
    const root = document.scrollingElement || document.documentElement;
    return { kind: "document", initialTop: root.scrollTop, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight };
  }, selector);
  // Always begin at the true top so the first viewport is the newest/top-of-grid snapshot
  // and the downward sweep cannot omit tiles above an arbitrary prior scroll position.
  await page.evaluate(selectorText => {
    const first = document.querySelector(selectorText);
    let node = first?.parentElement || null;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 8 && /(auto|scroll|overlay)/.test(style.overflowY)) {
        node.scrollTop = 0;
        return;
      }
      node = node.parentElement;
    }
    (document.scrollingElement || document.documentElement).scrollTop = 0;
  }, selector);
  await page.waitForTimeout(120);
  const all = new Map();
  // Observe Flow's own JSON responses while the virtualized grid is swept. Some builds
  // expose the media UUID in list payloads before it appears in thumbnail DOM attributes.
  const networkMediaRecords = [];
  const normalizeLabel = value => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  const walkNetworkPayload = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (Array.isArray(value)) {
      for (const child of value) walkNetworkPayload(child, depth + 1);
      return;
    }
    const values = Object.entries(value);
    const uuidFields = values.filter(([key]) => /^(?:uuid|mediauuid|videoid|mediaid|assetid|id)$/i.test(key));
    const uuid = uuidFields.map(([, item]) => assetUuidFromUrl(item)).find(Boolean)
      || values.map(([, item]) => typeof item === "string" ? assetUuidFromUrl(item) : null).find(Boolean);
    if (uuid) {
      const labels = values.filter(([key, item]) => typeof item === "string"
        && /title|name|prompt|description|label|text|created/i.test(key))
        .map(([, item]) => normalizeLabel(item)).filter(item => item.length >= 4);
      networkMediaRecords.push({ uuid, labels });
    }
    for (const [, child] of values) if (child && typeof child === "object") walkNetworkPayload(child, depth + 1);
  };
  const networkResponseListener = async response => {
    try {
      const url = response.url();
      if (!/flow\.google|googleusercontent|flow-content/i.test(url)) return;
      const headers = await response.allHeaders();
      if (!/json/i.test(headers["content-type"] || "")) return;
      walkNetworkPayload(await response.json());
    } catch { /* A consumed/streaming response is not authoritative; DOM fallback remains. */ }
  };
  page.on("response", networkResponseListener);
  const resolveUuidFromNetwork = item => {
    const tileText = normalizeLabel(item.text);
    if (!tileText) return null;
    const matches = networkMediaRecords.filter(record => record.labels.some(label =>
      label === tileText || (label.length >= 8 && (tileText.includes(label) || label.includes(tileText)))));
    const uuids = Array.from(new Set(matches.map(record => record.uuid)));
    return uuids.length === 1 ? uuids[0] : null;
  };
  const readScrollTop = async () => page.evaluate(selectorText => {
    const first = document.querySelector(selectorText);
    let node = first?.parentElement || null;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 8 && /(auto|scroll|overlay)/.test(style.overflowY)) return node.scrollTop;
      node = node.parentElement;
    }
    return (document.scrollingElement || document.documentElement).scrollTop;
  }, selector);
  const restoreScrollTop = async top => page.evaluate(({ selectorText, top }) => {
    const first = document.querySelector(selectorText);
    let node = first?.parentElement || null;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 8 && /(auto|scroll|overlay)/.test(style.overflowY)) { node.scrollTop = top; return; }
      node = node.parentElement;
    }
    (document.scrollingElement || document.documentElement).scrollTop = top;
  }, { selectorText: selector, top });
  const resolveUuidByOpeningTile = async (index, identity = null) => {
    const gridUrl = page.url();
    const scrollTop = await readScrollTop();
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        // Re-enter the project grid and Videos tab for each attempt, then re-find
        // the same card by its thumbnail URL token instead of trusting a virtualized index.
        await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
        const tabResult = await activateVideosTab(page, selectors).catch(error => `error:${error.message}`);
        // Flow may briefly render All media (or an incomplete grid) after route entry.
        // Wait for six visible Videos thumbnails and a stable two-snapshot token list.
        let previousTokens = null;
        let currentTokens = [];
        for (let gridPoll = 0; gridPoll < 20; gridPoll += 1) {
          currentTokens = await page.locator(selector).evaluateAll(elements => elements.slice(0, 6).map(element => {
            const source = element.querySelector("img")?.getAttribute("src") || "";
            const asb = source.match(/\/asb\/([^/?#]+)/i);
            if (asb) return `asb:${asb[1]}`;
            try { return new URL(source, location.href).pathname; }
            catch { return source.split(/[?#]/, 1)[0]; }
          })).catch(() => []);
          if (currentTokens.length >= 6 && previousTokens
            && currentTokens.length === previousTokens.length
            && currentTokens.every((token, i) => token === previousTokens[i])) break;
          previousTokens = currentTokens;
          await page.waitForTimeout(250);
        }
        const expectedToken = identity?.thumbnailSrc ? thumbnailIdentityToken(identity.thumbnailSrc) : null;
        console.log(JSON.stringify({
          event: "media_tile_reidentification",
          attempt,
          tile_index: index,
          videos_tab_activation: tabResult,
          expected_thumbnail_token: expectedToken,
          visible_first_six_thumbnail_tokens: currentTokens.slice(0, 6),
          visible_tile_count: await page.locator(selector).count().catch(() => 0),
        }));
        let currentIndex = -1;
        if (expectedToken) {
          currentIndex = await page.locator(selector).evaluateAll((elements, expected) =>
            elements.findIndex(element => {
              const source = element.querySelector("img")?.getAttribute("src") || "";
              const asb = source.match(/\/asb\/([^/?#]+)/i);
              let token;
              if (asb) token = `asb:${asb[1]}`;
              else { try { token = new URL(source, location.href).pathname; } catch { token = source.split(/[?#]/, 1)[0]; } }
              return token === expected;
            }), expectedToken).catch(() => -1);
        }
        if (currentIndex < 0 && identity?.text) {
          const normalizedTargetText = String(identity.text).replace(/\\s+/g, " ").trim();
          const matchingIndices = await page.locator(selector).evaluateAll((elements, targetText) =>
            elements.map((element, i) => ({ i, text: String(element.innerText || element.textContent || "").replace(/\\s+/g, " ").trim() }))
              .filter(item => item.text === targetText).map(item => item.i), normalizedTargetText).catch(() => []);
          if (matchingIndices.length === 1) currentIndex = matchingIndices[0];
        }
        if (currentIndex < 0 && !identity?.thumbnailSrc && !identity?.text) currentIndex = index;
        if (currentIndex < 0) throw new Error("Could not re-identify the same tile by thumbnail token/text after returning to the project grid.");
        const tile = page.locator(selector).nth(currentIndex);
        await tile.scrollIntoViewIfNeeded({ timeout: 3500 });
        await page.waitForTimeout(1000);
        await tile.click({ timeout: 4000, force: true });
        // Read the browser's current URL directly. Flow can serve a cached editor
        // route without emitting a fresh network response, so response listeners
        // and page-context waitForFunction are not authoritative for navigation.
        const editRoute = /\/edit\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
        await page.waitForURL(url => editRoute.test(new URL(url).pathname), { timeout: 8000 }).catch(() => {});
        const currentUrl = page.url();
        const match = currentUrl.match(editRoute);
        const uuid = match?.[1]?.toLowerCase() || null;
        if (currentUrl !== gridUrl || uuid) {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
          await page.waitForURL(url => new URL(url).pathname === new URL(gridUrl).pathname, { timeout: 10000 }).catch(() => {});
        }
        await restoreScrollTop(scrollTop);
        await page.waitForTimeout(250);
        if (uuid) {
          if (attempt > 1) console.log(`Resolved tile index ${index} UUID after retry ${attempt}: ${uuid}`);
          return uuid;
        }
        lastError = new Error(`clicked tile did not expose an /edit/<uuid> URL (current URL: ${currentUrl})`);
      } catch (error) {
        lastError = error;
        if (/\/edit\//i.test(page.url())) {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
          await page.waitForFunction(pathname => location.pathname === pathname, new URL(gridUrl).pathname, { timeout: 10000 }).catch(() => {});
          await restoreScrollTop(scrollTop).catch(() => {});
        }
        if (attempt < 3) {
          console.warn(`Retrying media UUID lookup for tile index ${index} (attempt ${attempt}/3): ${error.message}`);
          await page.waitForTimeout(400 * attempt);
        }
      }
    }
    console.warn(`Could not resolve media UUID by opening tile index ${index} after 3 attempts: ${lastError?.message || "unknown error"}`);
    return null;
  };
  let stableBottomRounds = 0;
  let reachedBottom = false;
  let topItems = null;
  let targetIndex = null;
  let unkeyedItemsDetected = false;
  let duplicateVisibleKeyDetected = false;
  for (let step = 0; step <= maxScrolls; step += 1) {
    let visible = await page.locator(selector).evaluateAll(elements => elements.map((element, index) => {
      // Normalize media URLs to their stable UUID so deleted/Failed tiles and URL-shape
      // changes cannot make the same video look like a newly-created item.
      const sources = [
        element.getAttribute("href"),
        element.querySelector("a[href]")?.getAttribute("href"),
        element.querySelector("video")?.getAttribute("src"),
        element.getAttribute("data-id"),
        element.querySelector("img")?.getAttribute("src"),
      ].filter(Boolean).map(String);
      const uuidFrom = value => {
        const matches = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
        return matches && matches.length ? matches[matches.length - 1].toLowerCase() : null;
      };
      const thumbnailSrc = element.querySelector("img")?.getAttribute("src") || null;
      const mediaUuid = sources.map(uuidFrom).find(Boolean);
      const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      const hint = [text, ...sources].join("|");
      const key = mediaUuid ? `media:${mediaUuid}` : (thumbnailSrc || sources[0] || "");
      const state = [element.getAttribute("data-status"), element.getAttribute("data-state"),
        element.getAttribute("aria-label"), element.getAttribute("title")].filter(Boolean).join(" ");
      const progress = Boolean(element.querySelector('[role="progressbar"], progress, [aria-valuenow]'));
      const createdAt = element.querySelector("time[datetime]")?.getAttribute("datetime")
        || element.getAttribute("data-created-at") || element.getAttribute("data-createdat")
        || element.querySelector("[data-created-at]")?.getAttribute("data-created-at") || null;
      return { key: String(key).trim(), mediaUuid: mediaUuid ? mediaUuid.toLowerCase() : null, hint, text, thumbnailSrc, state, progress, index, createdAt };
    }));
    if (Number.isInteger(topLimit) && topLimit > 0) visible = visible.slice(0, topLimit);
    for (const item of visible) {
      if (!item.mediaUuid && item.hint && uuidCache.has(item.hint)) {
        item.mediaUuid = uuidCache.get(item.hint);
        item.key = item.mediaUuid ? `media:${item.mediaUuid}` : item.key;
      }
      if (!item.mediaUuid) {
        const networkUuid = resolveUuidFromNetwork(item);
        if (networkUuid) {
          item.mediaUuid = networkUuid;
          item.key = `media:${networkUuid}`;
          if (item.hint) uuidCache.set(item.hint, networkUuid);
        }
      }
      if (!item.mediaUuid) {
        const resolvedUuid = await resolveUuidByOpeningTile(item.index, item);
        if (resolvedUuid) {
          item.mediaUuid = resolvedUuid;
          item.key = `media:${resolvedUuid}`;
          if (item.hint) uuidCache.set(item.hint, resolvedUuid);
        }
      }
    }
    if (step === 0) topItems = visible.map(item => ({ ...item }));
    const keysThisViewport = new Set();
    for (const item of visible) {
      if (!item.key || !item.mediaUuid) unkeyedItemsDetected = true;
      if (item.key) {
        if (keysThisViewport.has(item.key)) duplicateVisibleKeyDetected = true;
        keysThisViewport.add(item.key);
        all.set(item.key, { ...item });
      }
      if (targetKey && item.key === targetKey) targetIndex = item.index;
    }
    if (targetIndex !== null) {
      page.off("response", networkResponseListener);
      return { items: Array.from(all.values()), targetIndex, scrolledToTarget: true, unkeyedItemsDetected, duplicateVisibleKeyDetected };
    }
    if (Number.isInteger(topLimit) && topLimit > 0) {
      reachedBottom = true; // Top-only inventory is complete by contract; no virtualized-grid sweep is required.
      break;
    }
    const metrics = await page.evaluate((selectorText) => {
      const first = document.querySelector(selectorText);
      let node = first?.parentElement || null;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (node.scrollHeight > node.clientHeight + 8 && /(auto|scroll|overlay)/.test(style.overflowY)) {
          return { kind: "element", top: node.scrollTop, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight };
        }
        node = node.parentElement;
      }
      const root = document.scrollingElement || document.documentElement;
      return { kind: "document", top: root.scrollTop, clientHeight: root.clientHeight, scrollHeight: root.scrollHeight };
    }, selector);
    const atBottom = metrics.top + metrics.clientHeight >= metrics.scrollHeight - 3;
    if (atBottom) stableBottomRounds += 1; else stableBottomRounds = 0;
    if (stableBottomRounds >= 2) { reachedBottom = true; break; }
    if (step === maxScrolls) break;
    await page.evaluate(({ selectorText, amount }) => {
      const first = document.querySelector(selectorText);
      let node = first?.parentElement || null;
      while (node && node !== document.body) {
        const style = getComputedStyle(node);
        if (node.scrollHeight > node.clientHeight + 8 && /(auto|scroll|overlay)/.test(style.overflowY)) {
          node.scrollTop = Math.min(node.scrollTop + amount, node.scrollHeight);
          return;
        }
        node = node.parentElement;
      }
      const root = document.scrollingElement || document.documentElement;
      root.scrollTop = Math.min(root.scrollTop + amount, root.scrollHeight);
    }, { selectorText: selector, amount: Math.max(250, scrollInfo.clientHeight * 0.75) });
    await page.waitForTimeout(120);
  }
  await page.evaluate(({ selectorText, initialTop }) => {
    const first = document.querySelector(selectorText);
    let node = first?.parentElement || null;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (node.scrollHeight > node.clientHeight + 8 && /(auto|scroll|overlay)/.test(style.overflowY)) {
        node.scrollTop = initialTop;
        return;
      }
      node = node.parentElement;
    }
    (document.scrollingElement || document.documentElement).scrollTop = initialTop;
  }, { selectorText: selector, initialTop: scrollInfo.initialTop });
  page.off("response", networkResponseListener);
  page.off("response", networkResponseListener);
  return { items: Array.from(all.values()).slice(0, Number.isInteger(topLimit) && topLimit > 0 ? topLimit : undefined), topItems: topItems || [], targetIndex: null, scrolledToTarget: false, unkeyedItemsDetected, duplicateVisibleKeyDetected, reachedBottom, topLimited: Number.isInteger(topLimit) && topLimit > 0 };
}

function isGenerationFailureText(value) {
  // Match Flow's current policy-failure wording as well as older generic errors.
  // Keep bare "Failed" out of this body-level matcher; old failed tiles can remain
  // in the project. The per-new-tile check below handles that short status safely.
  return /generation failed|failed to generate|couldn['’]?t generate|unable to generate|video failed|something went wrong|blocked by (?:policy|safety)|might violate|violate(?:s|d)? (?:our )?policies|violat(?:es|ed) (?:our )?(?:policy|policies|guidelines)|prominent people|you will be refunded|generation error/i.test(String(value || ""));
}

async function activateVideosTab(page, selectors) {
  if (selectors.videos_tab) {
    const tab = await exactVisibleLocator(page, selectors.videos_tab, "Videos tab");
    await tab.click({ timeout: 3000 });
    await page.waitForTimeout(300);
    return "configured_selector";
  }
  const roleTab = page.getByRole("tab", { name: /^Videos$/i });
  if (await roleTab.count().catch(() => 0) === 1 && await roleTab.isVisible().catch(() => false)) {
    await roleTab.click({ timeout: 3000 });
    await page.waitForTimeout(300);
    return "role=tab";
  }
  const button = page.getByRole("button", { name: /^Videos$/i });
  if (await button.count().catch(() => 0) === 1 && await button.isVisible().catch(() => false)) {
    await button.click({ timeout: 3000 });
    await page.waitForTimeout(300);
    return "role=button";
  }
  return "not_found_no_tab_switch";
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

function rawProviderMessage(value) {
  const message = String(value || "");
  const tileMarker = " reports failure: ";
  const tileIndex = message.indexOf(tileMarker);
  if (tileIndex >= 0) return message.slice(tileIndex + tileMarker.length).trim();
  const pageMarker = "Flow displayed a generation/policy failure: ";
  const pageIndex = message.indexOf(pageMarker);
  if (pageIndex >= 0) return message.slice(pageIndex + pageMarker.length).trim();
  return message || null;
}

function makeGenerationLedgerRecord({ scene, projectId, ledgerProjectId, prompt, estimatedCost, beforeBalance, afterBalance, resultStatus, mediaUri, downloadedFile, downloadError, timeoutError, attemptNumber, attemptId, startedOn, variantIndex = 1, variantCount = 1 }) {
  const observedDelta = beforeBalance !== null && afterBalance !== null && beforeBalance >= afterBalance
    ? beforeBalance - afterBalance : null;
  const actualAmount = observedDelta !== null && observedDelta > 0 ? observedDelta : null;
  const refundPending = resultStatus === "failed" && /refund(?:ed)?(?: for this generation| may take| pending)?|you will be refunded/i.test(String(timeoutError || ""));
  const chargeStatus = refundPending ? "refunded_pending"
    : (actualAmount !== null ? "charged"
      : (resultStatus === "failed" && beforeBalance !== null && afterBalance !== null && beforeBalance === afterBalance ? "not_charged" : "unknown"));
  const timestamp = new Date().toISOString();
  attemptId = attemptId || ("attempt-" + randomUUID());
  return {
    schema_version: "1.0",
    attempt_id: attemptId,
    project_id: ledgerProjectId || scene.goglow_project_id || projectId || "google-flow-project",
    scene_id: scene.scene_id,
    job_id: scene.job_id || scene.scene_id,
    variant_index: variantIndex,
    variant_count: variantCount,
    selected_variant: null,
    variant_selection_reason: null,
    attempt_number: attemptNumber || 1,
    retry_of: null,
    provider: "google_flow",
    started_on: startedOn || null,
    finished_on: timestamp,
    configuration: (() => {
      const referenceImages = scene.reference_images || [];
      const selectedFaceRefs = scene.face_reference_ids || [scene.face_reference_id || referenceImages[0]].filter(Boolean);
      const selectedPaths = new Set(selectedFaceRefs.map(item => path.resolve(String(item))));
      const otherReferences = referenceImages.filter(item => !selectedPaths.has(path.resolve(String(item))));
      const faceReferenceIds = selectedFaceRefs.map(item => path.basename(item));
      const otherReferenceIds = otherReferences.map(item => path.basename(item));
      // Fingerprint reference image bytes and their roles/order, without storing local paths.
      const referenceSetKey = createHash("sha256").update(JSON.stringify({
        face_reference_sha256: selectedFaceRefs.map(item => createHash("sha256").update(fs.readFileSync(item)).digest("hex")),
        other_reference_sha256: otherReferences.map(item => createHash("sha256").update(fs.readFileSync(item)).digest("hex")),
      }), "utf8").digest("hex");
      return {
        model_label: scene.model || "Omni 1.1 Flash",
        resolution: scene.resolution || "360p",
        duration_seconds: Number.parseInt(scene.duration || "8s", 10) || 8,
        aspect_ratio: "9:16",
        pose_reference_id: null,
        face_reference_id: faceReferenceIds[0] || null,
        face_reference_ids: faceReferenceIds,
        face_description_mode: scene.face_description_mode || "include",
        reference_set_key: referenceSetKey,
        expression: scene.expression || null,
        other_reference_ids: otherReferenceIds,
      };
    })(),
    prompt: { text: prompt, sha256: createHash("sha256").update(prompt, "utf8").digest("hex"), template_version: null },
    rule_ids: [],
    result: {
      status: resultStatus,
      provider_message: resultStatus === "failed" ? rawProviderMessage(timeoutError) : (timeoutError || null),
      failure: resultStatus === "failed" ? {
        category: /prominent people|might violate our policies/i.test(String(timeoutError || "")) ? "provider_policy_prominent_people" : "browser_automation",
        message: timeoutError || downloadError || "Flow result was not verified.",
        provider_error_code: null,
        retryable: false,
        suggested_prompt_revision: null,
        revision_rationale: /prominent people|might violate our policies/i.test(String(timeoutError || ""))
          ? "Stop the batch. Do not retry automatically or alter references/prompt to evade the policy decision. Review the content and Flow policy; any new attempt requires a human-reviewed, policy-compliant revision and fresh confirmation."
          : null,
      } : null,
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
    qc: { status: "not_reviewed", observed_defects: [], checks_passed: null, checks_total: null, reviewed_by: null, reviewed_on: null, notes: "Human QC has not been recorded.", watermark_status: scene.watermark_status || "not_reviewed" },
    created_by: "browser_automation",
    notes: [downloadError ? `Download failed: ${downloadError}` : null, timeoutError ? `Wait ended without verified completion: ${timeoutError}` : null].filter(Boolean).join(" "),
  };
}

async function waitForGenerationAndDownload(page, selectors, { beforeKeys, beforeBalance, createClickedAt, uuidCache = new Map(), timeoutMs, downloadDir, sceneId, attemptId, timeoutScreenshot, variantIndex = 1, variantCount = 1 }) {
  const itemLocator = page.locator(selectors.generated_video_items);
  let deadline = Date.now() + timeoutMs;
  let chargedExtensionUsed = false;
  let newKey = null;
  let newItem = null;
  let attemptedKeys = new Set();
  const failIfVisible = async () => {
    // Project grids may retain older failed tiles. Only inspect the whole page on
    // a generation detail route; on the grid, inspect only newly-created tiles below.
    if (!/\/(?:edit|video)\//i.test(page.url())) return;
    const bodyText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    if (isGenerationFailureText(bodyText)) {
      throw new Error(`FLOW_GENERATION_FAILED: Flow displayed a generation/policy failure: ${bodyText.replace(/\s+/g, " ").trim()}`);
    }
  };
  const captureTimeout = async () => {
    if (!timeoutScreenshot) return;
    try {
      fs.mkdirSync(path.dirname(path.resolve(timeoutScreenshot)), { recursive: true });
      await page.screenshot({ path: path.resolve(timeoutScreenshot), fullPage: false, timeout: 5000 });
      console.error(`Wait-timeout screenshot saved: ${path.resolve(timeoutScreenshot)}`);
    } catch (error) {
      console.error(`Could not save wait-timeout screenshot: ${error.message}`);
    }
  };
  while (true) {
    if (Date.now() >= deadline) {
      // A credit debit is strong evidence that Create was accepted even when Flow's
      // media grid is stale. Give the newly charged generation one extra five-minute
      // discovery window; never click Create again.
      if (!chargedExtensionUsed && beforeBalance !== null) {
        const currentBalance = await readCreditBalance(page, selectors).catch(() => null);
        if (currentBalance !== null && currentBalance < beforeBalance) {
          chargedExtensionUsed = true;
          deadline = Date.now() + 300000;
          console.warn(`Flow credit balance decreased (${beforeBalance} -> ${currentBalance}) but the new video is not yet verified; extending result polling by 300000ms without resubmitting.`);
        } else {
          break;
        }
      } else {
        break;
      }
    }
    // Flow can switch back to All media after Create. Explicitly re-select Videos
    // on every grid poll before comparing the new result against the pre-Create inventory.
    await activateVideosTab(page, selectors).catch(() => "not_found_no_tab_switch");
    await failIfVisible();
    const scan = await collectAllGeneratedItems(page, selectors.generated_video_items, { uuidCache, topLimit: 1, selectors }).catch(() => ({ items: [], topItems: [], reachedBottom: false, topLimited: false }));
    if (!scan.topLimited || scan.unkeyedItemsDetected || scan.duplicateVisibleKeyDetected) {
      console.warn("Media inventory scan is incomplete or ambiguous; refusing to identify/download a clip.");
      await page.waitForTimeout(1000);
      continue;
    }
    // Open/read only the first tile at the top of the post-Create Videos grid. The
    // first six pre-Create UUIDs are the baseline; never scan the virtualized grid.
    const topItem = scan.topItems?.[0] || null;
    const newItems = topItem?.mediaUuid && topItem.key && !beforeKeys.includes(topItem.key) ? [topItem] : [];
    // Failed tiles already in the pre-Create UUID baseline are not new results.
    // A newly failed UUID is still detected below and stops the batch safely.
    const candidateItems = newItems.filter(item =>
      !(/\bfailed\b/i.test(`${item.state} ${item.text}`) || isGenerationFailureText(`${item.state} ${item.text}`)));
    const failedTile = newItems.find(item =>
      /\bfailed\b/i.test(`${item.state} ${item.text}`)
      || isGenerationFailureText(`${item.state} ${item.text}`));
    if (failedTile) {
      throw new Error(`FLOW_GENERATION_FAILED: new Flow tile ${failedTile.key} reports failure: ${failedTile.text || failedTile.state}`);
    }
    if (candidateItems.length > 1) {
      throw new Error(`More than one new non-failed Flow video tile appeared in the top-of-grid result check (${candidateItems.length}); refusing to guess which clip to download.`);
    }
    if (candidateItems.length === 1 && !attemptedKeys.has(candidateItems[0].key)) {
      const candidate = candidateItems[0];
      if (candidate.createdAt) {
        const createdMs = Date.parse(candidate.createdAt);
        const createMs = Date.parse(createClickedAt || "");
        if (!Number.isFinite(createdMs) || !Number.isFinite(createMs) || createdMs <= createMs) {
          console.warn(`Top tile ${candidate.key} has an unreadable or non-new creation timestamp; result remains unknown and will not be downloaded.`);
          await page.waitForTimeout(1000);
          continue;
        }
      }
      newKey = candidate.key;
      attemptedKeys.add(newKey);
      const located = await collectAllGeneratedItems(page, selectors.generated_video_items, { targetKey: newKey }).catch(() => ({ targetIndex: null }));
      if (located.targetIndex !== null) {
        newItem = itemLocator.nth(located.targetIndex);
        await newItem.click({ timeout: 5000 });
        const shortWait = Math.min(3500, Math.max(500, deadline - Date.now()));
        const downloadButtonLocator = page.locator(selectors.download_media_button);
        try {
          await downloadButtonLocator.waitFor({ state: "visible", timeout: shortWait });
          break;
        } catch {
          await failIfVisible();
          // If the new tile opened its own editor, keep waiting there for the
          // actual result instead of confusing an in-progress tile with a stale card.
          if (page.url().includes("/edit/") || page.url().includes("/video/")) {
            while (true) {
              await failIfVisible();
              if (await page.locator(selectors.download_media_button).isVisible().catch(() => false)) break;
              if (Date.now() >= deadline) {
                // Recover to the project grid before checking credits: detail pages do
                // not reliably expose the balance panel. If charged, keep polling rather
                // than declaring an already-paid generation unknown.
                if (!chargedExtensionUsed && beforeBalance !== null) {
                  await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
                  await activateVideosTab(page, selectors).catch(() => "not_found_no_tab_switch");
                  const currentBalance = await readCreditBalance(page, selectors).catch(() => null);
                  if (currentBalance !== null && currentBalance < beforeBalance) {
                    chargedExtensionUsed = true;
                    deadline = Date.now() + 300000;
                    newItem = null;
                    newKey = null;
                    console.warn(`Flow credit balance decreased (${beforeBalance} -> ${currentBalance}) but Download media is not ready; extending result polling by 300000ms without resubmitting.`);
                    break;
                  }
                }
                await captureTimeout();
                throw new Error("New video detail opened, but generation did not expose Download media before the wait deadline.");
              }
              await page.waitForTimeout(1000);
            }
            if (newItem === null || newKey === null) continue;
            if (await page.locator(selectors.download_media_button).isVisible().catch(() => false)) break;
          }
          // If no detail page opened, keep polling the project grid. This avoids
          // waiting ten minutes on a stale card that never navigated anywhere.
          newItem = null;
          newKey = null;
        }
      }
    }
    await page.waitForTimeout(1000);
  }
  if (!newItem || !newKey) {
    await failIfVisible();
    await captureTimeout();
    throw new Error(`No verified new video detail/download became available within ${timeoutMs}ms. The virtualized media grid was fully swept; completion remains unverified. Do not retry.`);
  }
  const remainingMs = Math.max(1000, deadline - Date.now());
  const downloadButtonLocator = page.locator(selectors.download_media_button);
  try { await downloadButtonLocator.waitFor({ state: "visible", timeout: remainingMs }); }
  catch {
    await failIfVisible();
    await captureTimeout();
    throw new Error("A new tile was opened but Download media did not become visible before the wait deadline; completion remains unverified.");
  }
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
    // Every output is tied to its unique submission attempt; reruns never collide with old files.
    const targetName = `${safeScene}__${safeAttempt}${extension}`;
    const target = path.join(targetDir, targetName);
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
  const initialHandle = await prompt.elementHandle();
  if (!initialHandle) throw new Error("Prompt textbox disappeared before empty-state verification.");
  const initialValue = await initialHandle.evaluate(element => ("value" in element) ? element.value : (element.innerText || element.textContent || ""));
  const initialChipCount = await page.locator(selectors.ingredient_reference_items).count().catch(() => -1);
  if (String(initialValue).trim() === "" && initialChipCount === 0) return;
  const clearButton = await exactVisibleLocator(page, selectors.clear_prompt, "Clear prompt button");
  try {
    await clearButton.click({ timeout: 2500 });
  } catch (clickError) {
    // A timeout can be reported after Flow already handled the click during an animation.
    // Re-check actual state before deciding cleanup failed.
    await page.waitForTimeout(250);
    const afterClickHandle = await prompt.elementHandle();
    const afterClickValue = afterClickHandle
      ? await afterClickHandle.evaluate(element => ("value" in element) ? element.value : (element.innerText || element.textContent || ""))
      : "__PROMPT_MISSING__";
    const afterClickChips = await page.locator(selectors.ingredient_reference_items).count().catch(() => -1);
    if (String(afterClickValue).trim() !== "" || afterClickChips !== 0) {
      throw new Error(`Clear prompt click did not complete and state is not empty (prompt=${JSON.stringify(String(afterClickValue).trim())}, chips=${afterClickChips}): ${clickError.message}`);
    }
    return;
  }
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
  let chipCount = await page.locator(selectors.ingredient_reference_items).count().catch(() => -1);
  while (chipCount > 0) {
    const chip = page.locator(selectors.ingredient_reference_items).last();
    const remove = chip.locator('button[aria-label*="remove" i], button[aria-label*="delete" i], button[aria-label*="close" i], button[title*="remove" i], button[title*="delete" i], [role="button"][aria-label*="remove" i], [role="button"][aria-label*="delete" i]').first();
    if (await remove.count().catch(() => 0) === 0 || !(await remove.isVisible().catch(() => false))) {
      throw new Error(`Clear prompt removed text but left ${chipCount} Ingredients chip(s), and no verified remove control was found. Remove chips manually before continuing.`);
    }
    let removeClickError = null;
    try { await remove.click({ timeout: 1500 }); } catch (error) { removeClickError = error; }
    try {
      // State change, not click return, is decisive if the hover animation times out.
      await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length < expected,
        { selector: selectors.ingredient_reference_items, expected: chipCount }, { timeout: Math.max(timeout, 3000) });
    } catch {
      throw new Error(`Ingredients chip count did not decrease from ${chipCount}${removeClickError ? ` after remove click timeout: ${removeClickError.message}` : ""}; stop and inspect Flow manually.`);
    }
    chipCount = await page.locator(selectors.ingredient_reference_items).count().catch(() => -1);
  }
  if (chipCount !== 0) throw new Error(`Clear prompt verification failed; ${chipCount} Ingredients chip(s) remain.`);
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
  const labelText = (await locator.innerText()).replace(/\s+/g, " ").trim();
  if (!labelText.includes(value)) throw new Error(`The ${label} selector text ${JSON.stringify(labelText)} does not match expected value ${JSON.stringify(value)}.`);
  const checked = await locator.getAttribute("aria-checked");
  if (checked !== "true") {
    await locator.click({ timeout: 2500 });
    const after = await locator.getAttribute("aria-checked");
    if (after !== "true") throw new Error(`Could not verify ${label}=${value}; aria-checked is ${JSON.stringify(after)}. Stopping safely.`);
  }
}

async function chooseModel(page, selectors, model) {
  const trigger = await exactVisibleLocator(page, selectors.model, "model selector", 6000);
  const currentText = (await trigger.innerText({ timeout: 6000 })).trim();
  // Avoid opening an animated menu when the requested model is already selected.
  if (currentText.includes(model)) {
    console.log(`Model already selected (${model}); skipping model menu interaction.`);
    return;
  }
  await trigger.click({ timeout: 8000 });
  const option = page.locator(selectors.model_option);
  try {
    await option.waitFor({ state: "visible", timeout: 8000 });
    // Wait for the menu option's rendered box to stop moving before clicking it.
    let previousBox = await option.boundingBox();
    let stableBox = false;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.waitForTimeout(150);
      await option.waitFor({ state: "visible", timeout: 3000 });
      const currentBox = await option.boundingBox();
      if (previousBox && currentBox
        && Math.abs(previousBox.x - currentBox.x) <= 1
        && Math.abs(previousBox.y - currentBox.y) <= 1
        && Math.abs(previousBox.width - currentBox.width) <= 1
        && Math.abs(previousBox.height - currentBox.height) <= 1) {
        stableBox = true;
        break;
      }
      previousBox = currentBox;
    }
    if (!stableBox) throw new Error("Model menu option layout did not stabilize after opening.");
  } catch {
    throw new Error("Model option did not become stably visible within 8000ms after opening the model menu.");
  }
  const verifiedOption = await exactVisibleLocator(page, selectors.model_option, "model option", 6000);
  const rawText = (await verifiedOption.innerText({ timeout: 6000 })).trim();
  // Flow prepends a material icon ligature (e.g. volume_up); compare the final visible text line exactly.
  const text = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || "";
  if (text !== model) throw new Error(`Model option text mismatch: expected ${JSON.stringify(model)}, got ${JSON.stringify(text)}.`);
  await verifiedOption.click({ timeout: 8000 });
  const selected = await exactVisibleLocator(page, selectors.model, "model selector after selection", 6000);
  const selectedText = (await selected.innerText({ timeout: 6000 })).trim();
  if (!selectedText.includes(model)) throw new Error(`Model selection did not persist; current label is ${JSON.stringify(selectedText)}.`);
}


function assetUuidFromUrl(value) {
  const match = String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match?.[0]?.toLowerCase() || null;
}

function thumbnailIdentityToken(value) {
  const source = String(value || "");
  const asbToken = source.match(/\/asb\/([^/?#]+)/i);
  if (asbToken) return `asb:${asbToken[1]}`;
  try { return new URL(source, "https://flow.google.com").pathname; }
  catch { return source.split(/[?#]/, 1)[0]; }
}

async function assetUuidFromLocator(locator) {
  const values = await locator.evaluate(element => {
    const collected = [];
    const add = node => {
      if (!node) return;
      for (const name of ["href", "src", "id", "data-id", "data-uuid", "data-asset-id", "data-media-id", "aria-label", "title", "alt"]) {
        const value = node.getAttribute?.(name);
        if (value) collected.push(value);
      }
    };
    add(element);
    for (const node of element.querySelectorAll("a[href], img, video, [data-id], [data-uuid], [data-asset-id], [data-media-id]")) add(node);
    for (const node of [element, ...element.querySelectorAll("*")]) {
      for (const attribute of Array.from(node.attributes || [])) collected.push(attribute.value);
    }
    return collected;
  }).catch(() => []);
  for (const value of values) {
    const uuid = assetUuidFromUrl(value);
    if (uuid) return uuid;
  }
  return null;
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

async function uploadSceneReferencesUnsafe(page, selectors, referenceImages, referenceAssetUuids = new Map()) {
  const chips = page.locator(selectors.ingredient_reference_items);
  const beforeCount = await chips.count().catch(() => -1);
  if (beforeCount !== 0) throw new Error(`Ingredients already contains ${beforeCount} reference chip(s); clear the prompt manually and rerun so this run can prove which images it attached.`);
  const expectedUuids = [];

  // Capture Flow JSON responses while the asset picker opens. Signed thumbnail URLs
  // can later be replaced by /asb/<token>, so network metadata is the durable lookup.
  const networkAssetRecords = [];
  const walkAssetPayload = (value, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 14) return;
    if (Array.isArray(value)) {
      for (const child of value) walkAssetPayload(child, depth + 1);
      return;
    }
    const entries = Object.entries(value);
    const uuid = entries.filter(([key]) => /^(?:uuid|assetuuid|assetid|mediauuid|mediaid|id)$/i.test(key))
      .map(([, item]) => assetUuidFromUrl(item)).find(Boolean)
      || entries.map(([, item]) => typeof item === "string" ? assetUuidFromUrl(item) : null).find(Boolean);
    if (uuid) {
      const strings = entries.filter(([, item]) => typeof item === "string").map(([, item]) => item.toLowerCase());
      networkAssetRecords.push({ uuid, strings });
    }
    for (const [, child] of entries) if (child && typeof child === "object") walkAssetPayload(child, depth + 1);
  };
  const assetResponseListener = async response => {
    try {
      const url = response.url();
      if (!/flow\.google|googleusercontent|flow-content/i.test(url)) return;
      const headers = await response.allHeaders();
      if (!/json/i.test(headers["content-type"] || "")) return;
      walkAssetPayload(await response.json());
    } catch { /* DOM and attached-chip verification remain the fallback. */ }
  };
  page.on("response", assetResponseListener);

  for (const imagePath of referenceImages) {
    const filename = path.basename(imagePath);
    const assetStartedAt = Date.now();
    console.log(`Reference upload started: ${filename}`);
    await openIngredientsPicker(page, selectors);
    const picker = page.locator(selectors.ingredient_library_item);
    const filenameStem = path.parse(filename).name;
    let matchingAssets = picker.filter({ hasText: filename });
    // Some Flow library cards display the filename without its extension. Fall back
    // to the stem only when the exact filename has no match; UUID uniqueness still gates reuse.
    if (await matchingAssets.count().catch(() => 0) === 0 && filenameStem !== filename) {
      matchingAssets = picker.filter({ hasText: filenameStem });
    }
    const existingUuids = new Set();
    const existingCount = await matchingAssets.count().catch(() => 0);
    // Flow lazily upgrades old thumbnail URLs from /asb/<token> to flow-content/image/<uuid>.
    // A unique same-name UUID in Flow's JSON is authoritative enough to skip that
    // slow thumbnail upgrade for a single card.
    const filenameNeedles = [filename.toLowerCase(), filenameStem.toLowerCase()];
    const networkNameUuids = Array.from(new Set(networkAssetRecords
      .filter(record => record.strings.some(value => filenameNeedles.some(needle => needle && value.includes(needle))))
      .map(record => record.uuid)));
    const networkUuidShortcut = existingCount === 1 && networkNameUuids.length === 1;
    if (networkUuidShortcut) existingUuids.add(networkNameUuids[0]);
    // Only poll lazy thumbnail URLs when Flow JSON did not already identify the
    // unique existing card. This avoids a needless 6.75s wait per reference.
    const thumbnailDeadline = networkUuidShortcut ? Date.now() : Date.now() + 7000;
    let thumbnailPolls = 0;
    do {
      if (!networkUuidShortcut) {
        existingUuids.clear();
        for (let i = 0; i < existingCount; i += 1) {
          const uuid = await assetUuidFromLocator(matchingAssets.nth(i));
          if (uuid) existingUuids.add(uuid);
        }
      }
      if (existingUuids.size === existingCount || Date.now() >= thumbnailDeadline) break;
      thumbnailPolls += 1;
      await page.waitForTimeout(250);
    } while (Date.now() < thumbnailDeadline);
    if (networkUuidShortcut) {
      console.log(`Skipped Flow asset thumbnail UUID wait: ${filename}, UUID resolved from unique matching Flow JSON metadata.`);
    } else if (thumbnailPolls > 0) {
      console.log(`Waited for Flow asset thumbnail UUIDs: ${filename}, polls=${thumbnailPolls}, elapsed_ms=${Math.min(7000, thumbnailPolls * 250)}`);
    }

    console.log(JSON.stringify({
      event: "asset_library_inventory_before_upload",
      filename,
      existing_uuids_before_upload: Array.from(existingUuids),
      matching_asset_count: existingCount,
    }));
    const requestedAssetUuid = referenceAssetUuids instanceof Map
      ? referenceAssetUuids.get(imagePath) : referenceAssetUuids?.[imagePath];
    let reusedExistingUuid = null;
    if (requestedAssetUuid) {
      let requestedFound = false;
      for (let i = 0; i < existingCount; i += 1) {
        if (await assetUuidFromLocator(matchingAssets.nth(i)) === requestedAssetUuid) { requestedFound = true; break; }
      }
      const responseConfirmsPin = networkAssetRecords.some(record => record.uuid === requestedAssetUuid
        && record.strings.some(value => value.includes(filename.toLowerCase()) || value.includes(filenameStem.toLowerCase())));
      if (!requestedFound && !responseConfirmsPin && existingCount !== 1) {
        throw new Error(`Job explicitly requested Flow asset UUID ${requestedAssetUuid} for ${filename}, but it was not found in DOM or matching Flow JSON metadata; matching_asset_count=${existingCount}. Refusing to guess among ambiguous entries.`);
      }
      reusedExistingUuid = requestedAssetUuid;
      console.log(JSON.stringify({ event: "asset_library_reused_explicit_uuid", filename, selected_existing_uuid: reusedExistingUuid, identity_source: requestedFound ? "dom" : responseConfirmsPin ? "network" : "unique-name-plus-attached-chip-verification" }));
    } else if (existingCount === 1 && existingUuids.size === 1) {
      // The library already contains one unambiguous asset with this exact local filename.
      // Reuse immediately rather than uploading a duplicate and waiting for Flow's 90s UUID timeout.
      reusedExistingUuid = Array.from(existingUuids)[0];
      console.log(JSON.stringify({
        event: "asset_library_reused_existing",
        filename,
        selected_existing_uuid: reusedExistingUuid,
        note: "Existing unique library asset found; skipping upload and UUID timeout wait.",
      }));
    } else if (existingUuids.size > 1 || existingCount > 1) {
      throw new Error(`Multiple existing library assets match ${filename}; refusing to guess which reference is correct.`);
    } else {
      if (existingCount > 0) throw new Error(`Found ${existingCount} existing Flow library asset(s) matching ${filename}, but could not read a stable UUID from their DOM attributes/URLs. Refusing to upload a duplicate; inspect the asset entry DOM and selector configuration.`);
      const uploadButton = await exactVisibleLocator(page, selectors.ingredient_upload_button, "Upload media button");
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
      await uploadButton.click({ timeout: 2500 });
      const chooser = await chooserPromise;
      await chooser.setFiles(imagePath);
      const uuidWaitStartedAt = Date.now();
      try {
        // Inspect every same-name card, not only the first one: older duplicates can
        // appear before the newly uploaded card and otherwise mask its UUID for 90 seconds.
        await page.waitForFunction(({ selector, filename, filenameStem, oldUuids }) => {
          const cards = Array.from(document.querySelectorAll(selector)).filter(asset => {
            const label = (asset.innerText || asset.textContent || "").toLowerCase();
            const image = asset.querySelector("img");
            const metadata = [image?.getAttribute("alt"), image?.getAttribute("title"),
              asset.getAttribute("aria-label"), asset.getAttribute("title")].filter(Boolean).join(" ").toLowerCase();
            return label.includes(filename.toLowerCase()) || label.includes(filenameStem.toLowerCase())
              || metadata.includes(filename.toLowerCase()) || metadata.includes(filenameStem.toLowerCase());
          });
          const uuids = cards.flatMap(card => {
            const sources = [card, ...Array.from(card.querySelectorAll("*"))]
              .flatMap(node => Array.from(node.attributes || [], attribute => attribute.value)).join(" ");
            return Array.from(sources.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig), match => match[0].toLowerCase());
          });
          return uuids.some(uuid => !oldUuids.includes(uuid));
        }, { selector: selectors.ingredient_library_item, filename, filenameStem, oldUuids: Array.from(existingUuids) }, { timeout: ASSET_READY_TIMEOUT_MS });
        console.log(`Reference UUID ready: ${filename} in ${Date.now() - uuidWaitStartedAt}ms`);
      } catch {
        const diagnostics = [];
        const countAfterTimeout = await picker.count().catch(() => 0);
        for (let i = 0; i < countAfterTimeout; i += 1) {
          const label = await picker.nth(i).innerText().catch(() => "");
          if (!label.toLowerCase().includes(filename.toLowerCase()) && !label.toLowerCase().includes(filenameStem.toLowerCase())) continue;
          const uuid = await assetUuidFromLocator(picker.nth(i));
          if (uuid) diagnostics.push(uuid);
        }
        console.warn(JSON.stringify({
          event: "asset_library_match_diagnostics",
          filename,
          existing_uuids_before_upload: Array.from(existingUuids),
          matching_uuids_after_timeout: diagnostics,
          note: "A UUID is reusable only when it was present before upload and uniquely matched the asset label.",
        }));
        throw new Error("Upload " + filename + " did not expose a new UUID within " + ASSET_READY_TIMEOUT_MS + "ms and no reusable same-name asset UUID was verifiable. Stopping before prompt fill/Create.");
      }
    }
    let asset = matchingAssets.first();
    if (reusedExistingUuid) {
      let reuseIndex = -1;
      const currentCount = await matchingAssets.count().catch(() => 0);
      for (let i = 0; i < currentCount; i += 1) {
        if (await assetUuidFromLocator(matchingAssets.nth(i)) === reusedExistingUuid) { reuseIndex = i; break; }
      }
      if (reuseIndex < 0) {
        if (currentCount !== 1) throw new Error("Reusable asset UUID disappeared from the library and matching names are ambiguous; refusing to select an unverified item.");
        // A single same-name card may have a tokenized /asb thumbnail; the UUID pin
        // is checked against the attached Ingredients chip immediately after selection.
        asset = matchingAssets.first();
      } else {
        asset = matchingAssets.nth(reuseIndex);
      }
    }
    const requestedAssetUuidForPin = requestedAssetUuid || null;
    const networkCandidates = networkAssetRecords.filter(record =>
      record.strings.some(value => value.includes(filename.toLowerCase()) || value.includes(filenameStem.toLowerCase()))
    );
    const networkUuids = Array.from(new Set(networkCandidates.map(record => record.uuid)));
    let assetUuid = await assetUuidFromLocator(asset);
    if (!assetUuid && requestedAssetUuidForPin && networkUuids.includes(requestedAssetUuidForPin)) {
      assetUuid = requestedAssetUuidForPin;
    }
    if (!assetUuid && networkUuids.length === 1) assetUuid = networkUuids[0];
    const allowUniqueUnresolvedAsset = existingCount === 1 && !assetUuid;
    if (requestedAssetUuidForPin && assetUuid && assetUuid !== requestedAssetUuidForPin) {
      throw new Error(`Pinned Flow asset UUID mismatch for ${filename}: requested ${requestedAssetUuidForPin}, library/network resolved ${assetUuid}.`);
    }
    if (!assetUuid && !allowUniqueUnresolvedAsset) {
      throw new Error(`Library entry for ${filename} has no stable UUID in DOM or matching Flow JSON response; matching_asset_count=${existingCount}, network_candidate_uuids=${networkUuids.join(",") || "none"}. Refusing to guess among ambiguous entries.`);
    }
    if (reusedExistingUuid) console.warn(`Reusing existing Flow library asset ${filename} -> UUID ${reusedExistingUuid}; inspect its thumbnail during dry-run before any execute.`);

    // Snapshot the currently attached chip identities before selecting this asset.
    // Flow can keep earlier chips mounted while a new chip is added; never verify a
    // requested asset by scanning all chips and accidentally reading an earlier one.
    const beforeAttachChipCount = await chips.count();
    const beforeAttachChipUuids = [];
    for (let i = 0; i < beforeAttachChipCount; i += 1) {
      const src = await chips.nth(i).locator("img.chip-image").getAttribute("src").catch(() => null);
      const uuid = assetUuidFromUrl(src);
      if (!uuid) throw new Error(`Existing Ingredients chip ${i + 1} has no verifiable UUID before attaching ${filename}.`);
      beforeAttachChipUuids.push(uuid);
    }
    await asset.click({ timeout: 2500 });
    const addToPrompt = await exactVisibleLocator(page, selectors.ingredient_add_to_prompt, "Add to prompt button");
    let attachedAfterClick = false;
    let lastClickError = null;
    for (let clickAttempt = 0; clickAttempt < 3; clickAttempt += 1) {
      try {
        await addToPrompt.click({ timeout: 6000 });
        lastClickError = null;
      } catch (error) {
        lastClickError = error;
      }
      attachedAfterClick = await page.waitForFunction(({ selector, beforeCount }) =>
        document.querySelectorAll(selector).length > beforeCount,
        { selector: selectors.ingredient_reference_items, beforeCount: beforeAttachChipCount },
        { timeout: 2500 }).then(() => true).catch(() => false);
      if (attachedAfterClick) break;
      if (clickAttempt < 2) await page.waitForTimeout(350);
    }
    if (!attachedAfterClick) {
      await closeIngredientsPicker(page, selectors);
      const detail = lastClickError ? ` Last click error: ${lastClickError.message}` : "";
      throw new Error(`Add to prompt did not add a new Ingredients chip for ${filename} after 3 verified click attempts.${detail}`);
    }
    // Identify the newly attached chip by set difference against the pre-click
    // snapshot. This works whether Flow appends or prepends chips in its UI.
    const attachedChipCount = await chips.count();
    if (attachedChipCount !== beforeAttachChipCount + 1) {
      await closeIngredientsPicker(page, selectors);
      throw new Error(`Attaching ${filename} should add exactly one Ingredients chip; before=${beforeAttachChipCount}, after=${attachedChipCount}. Stopping before prompt fill/Create.`);
    }
    const afterAttachChipUuids = [];
    for (let i = 0; i < attachedChipCount; i += 1) {
      const src = await chips.nth(i).locator("img.chip-image").getAttribute("src").catch(() => null);
      afterAttachChipUuids.push(assetUuidFromUrl(src));
    }
    const newChipUuids = afterAttachChipUuids.filter(uuid => uuid && !beforeAttachChipUuids.includes(uuid));
    const selectedChipUuid = newChipUuids.length === 1 ? newChipUuids[0] : null;
    if (!selectedChipUuid) {
      await closeIngredientsPicker(page, selectors);
      throw new Error(`Selected asset ${filename} was attached, but neither its library metadata nor Ingredients chip exposed a stable UUID. Stopping before prompt fill/Create.`);
    }
    if (assetUuid && selectedChipUuid !== assetUuid) {
      await closeIngredientsPicker(page, selectors);
      throw new Error(`Flow asset UUID mismatch after attach for ${filename}: library/network resolved ${assetUuid}, newly attached chip UUID ${selectedChipUuid}. Stopping before prompt fill/Create.`);
    }
    if (requestedAssetUuidForPin && selectedChipUuid !== requestedAssetUuidForPin) {
      await closeIngredientsPicker(page, selectors);
      throw new Error(`Pinned Flow asset UUID mismatch after attach for ${filename}: requested ${requestedAssetUuidForPin}, newly attached chip UUID ${selectedChipUuid}. Stopping before prompt fill/Create.`);
    }
    assetUuid = selectedChipUuid;
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
    console.log(`Verified Ingredients asset ${filename} -> UUID ${assetUuid}; total reference step ${Date.now() - assetStartedAt}ms`);
  }

  const finalCount = await chips.count();
  if (finalCount !== referenceImages.length) throw new Error(`Ingredients chip count mismatch: expected ${referenceImages.length}, observed ${finalCount}. Stopping before prompt fill/Create.`);
  await verifyAttachedReferenceUuids(page, selectors, expectedUuids);
  console.log(`Verified exact asset identity and loaded thumbnails for ${finalCount} reference chip(s).`);
  page.off("response", assetResponseListener);
  return expectedUuids;
}

async function uploadSceneReferences(page, selectors, referenceImages, prompt, referenceAssetUuids = new Map()) {
  try {
    return await uploadSceneReferencesUnsafe(page, selectors, referenceImages, referenceAssetUuids);
  } catch (error) {
    // Close the picker here, but leave prompt/chip cleanup to the single outer
    // pre-submit failure handler. That avoids contradictory "cleanup failed" and
    // "cleanup succeeded" messages from two independent cleanup attempts.
    try {
      await closeIngredientsPicker(page, selectors);
      console.error("Upload failure: Ingredients picker closed and verified; outer handler will verify prompt/chip cleanup.");
    } catch (closeError) {
      console.error(`Upload failure: picker closure FAILED: ${closeError.message}; outer handler will still attempt prompt/chip cleanup.`);
    }
    throw error;
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
  const faceDescriptionMode = scene.face_description_mode ?? "include";
  if (!["include", "hybrid", "reference_only"].includes(faceDescriptionMode)) {
    throw new Error("face_description_mode must be 'include', 'hybrid', or 'reference_only'.");
  }
  if (typeof scene.character_description !== "string") {
    throw new Error("Scene JSON must contain character_description as a string (it may be empty when face_description_mode is 'reference_only').");
  }
  if (faceDescriptionMode !== "reference_only" && !scene.character_description.trim()) {
    throw new Error("Scene JSON must contain a non-empty character_description in ASCII English unless face_description_mode is 'reference_only'.");
  }
  if (scene.expression !== undefined && (typeof scene.expression !== "string" || !scene.expression.trim())) {
    throw new Error("expression must be a non-empty ASCII English string when provided.");
  }
  if (scene.expression && !/^[\x00-\x7F]+$/.test(scene.expression)) throw new Error("Expression must be ASCII/English only; non-ASCII characters are blocked before touching Flow.");
  if (!/^[\x00-\x7F]+$/.test(scene.prompt)) throw new Error("Prompt must be ASCII/English only; non-ASCII characters are blocked before touching Flow.");
  const variants = scene.variants === undefined ? 2 : scene.variants;
  if (!Number.isInteger(variants) || variants < 1 || variants > 3) throw new Error("variants must be an integer from 1 to 3.");
  const seatedShot = /\b(?:seated|sitting|sit|sits|kneeling|kneel|kneels)\b/i.test(scene.scene_id + " " + scene.prompt);
  scene.framing_helper_applied = scene.framing_helper === false ? false : (scene.framing_helper === true || seatedShot);
  if (scene.framing_helper_applied) {
    scene.prompt = scene.prompt.replace(/\b(?:fills?|occupies?)\s+(?:about\s+)?\d{1,3}\s*(?:percent|%)\s+of\s+(?:the\s+)?frame\s+width\b/gi, "is framed from head to knees");
    const framingSentence = "Medium-wide full-body shot. The person and yoga mat fill most of the frame while keeping the entire head, both knees, feet, and mat visible with a modest, clear margin on every side. Keep the face large enough for facial features to remain readable; do not leave excessive empty floor or make the person appear small. Do not crop the body or mat. Locked-off tripod shot from the first frame: the camera does not move, pan, tilt, dolly, or zoom at any time.";
    if (!scene.prompt.includes(framingSentence)) scene.prompt = scene.prompt.trim() + " " + framingSentence;
  }
  if (scene.character_description && !/^[\x00-\x7F]+$/.test(scene.character_description)) throw new Error("Character description must be ASCII/English only; non-ASCII characters are blocked before touching Flow.");
  if (!Array.isArray(scene.reference_images) || scene.reference_images.length < 1 || scene.reference_images.length > 3) {
    throw new Error("Scene JSON must provide reference_images as an array of 1 to 3 local file paths.");
  }
  const inlineAssetUuids = new Map();
  const referenceImages = scene.reference_images.map((value, index) => {
    const entry = typeof value === "string" ? { path: value } : value;
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || !entry.path.trim()) {
      throw new Error(`reference_images[${index}] must be a path string or {path, flow_asset_uuid} object.`);
    }
    const resolved = path.resolve(path.dirname(scenePath), entry.path);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Reference image does not exist or is not a file: ${resolved}`);
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(path.extname(resolved).toLowerCase())) {
      throw new Error(`Reference image must be PNG, JPG, JPEG, or WEBP: ${resolved}`);
    }
    if (entry.flow_asset_uuid !== undefined) {
      const uuid = String(entry.flow_asset_uuid).trim().toLowerCase();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
        throw new Error(`reference_images[${index}].flow_asset_uuid must be a UUID.`);
      }
      inlineAssetUuids.set(resolved, uuid);
    }
    return resolved;
  });
  if (new Set(referenceImages).size !== referenceImages.length) throw new Error("reference_images must contain distinct file paths.");
  scene.reference_images = referenceImages;
  const referenceAssetUuids = new Map(inlineAssetUuids);
  const declaredAssetUuids = scene.reference_asset_uuids;
  const declaredEntries = declaredAssetUuids === undefined ? []
    : Array.isArray(declaredAssetUuids) ? declaredAssetUuids.map((entry, index) => {
      if (!entry || typeof entry !== "object") throw new Error(`reference_asset_uuids[${index}] must be {path, flow_asset_uuid}.`);
      return [entry.path, entry.flow_asset_uuid];
    })
    : declaredAssetUuids && typeof declaredAssetUuids === "object" ? Object.entries(declaredAssetUuids)
    : (() => { throw new Error("reference_asset_uuids must be an object keyed by image path or an array of {path, flow_asset_uuid}."); })();
  for (const [rawPath, rawUuid] of declaredEntries) {
    if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("reference_asset_uuids entries require a non-empty path.");
    const resolvedPath = path.resolve(path.dirname(scenePath), rawPath);
    const matches = referenceImages.filter(imagePath => imagePath === resolvedPath || path.basename(imagePath) === rawPath);
    if (matches.length !== 1) throw new Error(`reference_asset_uuids path ${JSON.stringify(rawPath)} must uniquely match one reference_images entry.`);
    const uuid = String(rawUuid || "").trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) throw new Error(`reference_asset_uuids[${JSON.stringify(rawPath)}] must be a UUID.`);
    if (referenceAssetUuids.has(matches[0]) && referenceAssetUuids.get(matches[0]) !== uuid) throw new Error(`Conflicting Flow asset UUID declarations for ${rawPath}.`);
    referenceAssetUuids.set(matches[0], uuid);
  }
  const requestedFaceReferences = scene.face_reference_ids;
  let faceReferenceImages;
  if (requestedFaceReferences !== undefined) {
    if (scene.face_reference_id !== undefined && scene.face_reference_id !== null && scene.face_reference_id !== "") {
      throw new Error("Use either face_reference_ids or face_reference_id, not both.");
    }
    if (!Array.isArray(requestedFaceReferences) || requestedFaceReferences.length < 1 || requestedFaceReferences.length > 3) {
      throw new Error("face_reference_ids must be an array of 1 to 3 paths from this job's reference_images.");
    }
    faceReferenceImages = requestedFaceReferences.map((value, index) => {
      if (typeof value !== "string" || !value.trim()) throw new Error(`face_reference_ids[${index}] must be a non-empty image path.`);
      const resolved = path.resolve(path.dirname(scenePath), value);
      if (!referenceImages.includes(resolved)) {
        throw new Error("Every face_reference_ids entry must match a path in this job's reference_images.");
      }
      return resolved;
    });
    if (new Set(faceReferenceImages).size !== faceReferenceImages.length) {
      throw new Error("face_reference_ids must contain distinct paths.");
    }
    scene.face_reference_ids = requestedFaceReferences;
    scene.face_reference_id = requestedFaceReferences[0];
  } else {
    const requestedFaceReference = scene.face_reference_id;
    let singleFaceReference;
    if (requestedFaceReference === undefined || requestedFaceReference === null || requestedFaceReference === "") {
      singleFaceReference = referenceImages[0];
      scene.face_reference_id = scene.reference_images[0];
    } else {
      if (typeof requestedFaceReference !== "string" || !requestedFaceReference.trim()) {
        throw new Error("face_reference_id must identify one path from reference_images.");
      }
      singleFaceReference = path.resolve(path.dirname(scenePath), requestedFaceReference);
      if (!referenceImages.includes(singleFaceReference)) {
        throw new Error("face_reference_id must match one of the image paths in this job's reference_images.");
      }
    }
    faceReferenceImages = [singleFaceReference];
  }
  // Face references are attached first in the caller-declared order; supporting references follow.
  const orderedReferenceImages = [
    ...faceReferenceImages,
    ...referenceImages.filter(imagePath => !faceReferenceImages.includes(imagePath)),
  ];
  // Canonicalize paths so the ledger can reliably distinguish face refs from supporting refs.
  scene.reference_images = referenceImages;
  scene.face_reference_ids = faceReferenceImages;
  scene.face_reference_id = faceReferenceImages[0];
  scene.character_description = scene.character_description.trim();
  scene.scene_prompt = scene.prompt;
  const faceAnchorInstructions = faceReferenceImages.length > 1
    ? "The first attached image shows the character. Keep the same character as the reference image: facial structure, eye shape and spacing, nose, lips, cheeks, and jawline. The other selected face reference images show the same character from additional angles. Use them to understand the character's features; do not mix them with supporting references."
    : "The first attached image shows the character. Keep the same character as the reference image: facial structure, eye shape and spacing, nose, lips, cheeks, and jawline.";
  const characterDescriptionSection = faceDescriptionMode === "reference_only" || !scene.character_description
    ? "Use the attached reference images for all appearance details; do not invent or reinterpret facial features."
    : faceDescriptionMode === "hybrid"
      ? `HYBRID FACE DESCRIPTION (brief matching traits only; reference images remain authoritative): ${scene.character_description.trim().replace(/[.\s]+$/, "")}. Match the reference images and do not add conflicting traits.`
      : `CHARACTER DESCRIPTION (supporting traits only; do not override the face reference): ${scene.character_description}`;
  const rawNormalizedExpression = scene.expression
    ? scene.expression.trim().replace(/[.!?]+\s*$/, "")
    : "";
  const openEyesRequested = /\b(?:eyes?\s+(?:stay|remain|are|clearly)?\s*open|open eyes)\b/i.test(rawNormalizedExpression);
  // If the job already says "natural brief blinks only", remove that clause before
  // appending the standard guard so the composed prompt states it exactly once.
  const normalizedExpression = openEyesRequested
    ? rawNormalizedExpression
      // The standard guard below already states this full eye/smile requirement.
      // Remove equivalent short-form wording as well as the blink clause to avoid duplication.
      .replace(/(?:[,;.]?\s*)natural brief blinks only\b/ig, "")
      .replace(/(?:[,;.]?\s*)eyes?\s+(?:stay|remain)\s+open\s*,?\s*(?:gentle|warm)?\s*smile\s+showing\s+teeth\b/ig, "")
      .trim().replace(/[.!?]+\s*$/, "")
    : rawNormalizedExpression;
  const openEyesGuard = openEyesRequested
    ? "Eyes remain clearly open throughout the entire shot; she looks directly at the camera and smiles warmly with teeth visible from the first frame to the final frame; natural brief blinks only. No prolonged eye closure or eyes-closed meditation."
    : "";
  const expressionContent = [normalizedExpression, openEyesGuard].filter(Boolean).join(normalizedExpression ? ". " : "");
  const expressionSection = expressionContent
    ? `\n\nEXPRESSION AND EYE STATE (follow throughout the entire shot): ${expressionContent} Keep this expression and eye state consistent from the first frame to the last; this instruction takes priority over breathing or other subtle motion.`
    : "";
  const supportingReferenceImages = referenceImages.filter(imagePath => !faceReferenceImages.includes(imagePath));
  const supportingReferenceSection = supportingReferenceImages.length
    ? "Use remaining attached images only as supporting references for clothing, body, or context."
    : "";
  const supportingReferencePrefix = supportingReferenceSection ? `${supportingReferenceSection} ` : "";
  scene.prompt = `PRIMARY FACE REFERENCE: ${faceAnchorInstructions} Keep the same person throughout the clip.\n\n${characterDescriptionSection}\n\nSCENE: ${scene.prompt.trim()}${expressionSection}\n\n${supportingReferencePrefix}Keep the same character, hair, and skin tone throughout. Do not substitute a different person.`;
  if (!/^[\x00-\x7F]+$/.test(scene.prompt)) throw new Error("Composed prompt must contain ASCII characters only.");
  if (scene.model !== "Omni 1.1 Flash" || scene.resolution !== "360p") {
    throw new Error("Phase 3 pilot is restricted to model='Omni 1.1 Flash' and resolution='360p'.");
  }
  if (scene.duration && scene.duration !== "8s") throw new Error("Phase 3 pilot is restricted to duration='8s'.");
  requiredSelectorConfig(selectors);
  return { scene, selectors, referenceImages: orderedReferenceImages, faceReferenceImage: faceReferenceImages[0], faceReferenceImages, referenceAssetUuids };
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
  let account = null;
  let lastVisibilityError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      account = await exactVisibleLocator(page, selector, "Google account button");
      break;
    } catch (error) {
      lastVisibilityError = error;
      if (attempt < 3) {
        await page.keyboard.press("Escape").catch(() => {});
        await page.waitForTimeout(400 * attempt);
      }
    }
  }
  if (!account) throw new Error(`Google account button remained unavailable after 3 read-only visibility checks: ${lastVisibilityError?.message || "not visible"}`);
  const label = await account.getAttribute("aria-label") || "";
  const match = label.match(/\(([^()\s]+@[^()\s]+)\)/);
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
  const { scene, selectors, referenceImages, faceReferenceImage, referenceAssetUuids } = await loadInputs(args);
  const variantIndex = args._variantIndex || 1;
  const variantCount = args._variantCount || scene.variants || 1;
  scene.variant_index = variantIndex;
  scene.variant_count = variantCount;
  waitForSelectors(selectors, args);
  const chosen = await chooseFlowTab(browser, args);
  const originalUrl = chosen.page.url();
  let promptForCleanup = null;
  let createMayHaveBeenClicked = false;
  try {
  console.log(`Selected existing tab [${chosen.index}] context=${chosen.contextIndex}\nTitle: ${chosen.title}\nURL: ${chosen.url}\nProject ID: ${chosen.projectId || "legacy Flow route"}`);
  const accountStartedAt = Date.now();
  const account = await verifyAccount(chosen.page, selectors, args.expectedEmail);
  console.log(`Phase timing: account verification completed in ${Date.now() - accountStartedAt}ms.`);
  console.log(`Verified account email from page DOM: ${account.observedEmail}`);
  if (!args._accountConfirmed) {
    await askExact(
      rl,
      `Confirm account ${account.observedEmail} has available credit and this is the intended Flow project. Type CONFIRM ACCOUNT ${args.accountLabel} HAS CREDIT: `,
      `CONFIRM ACCOUNT ${args.accountLabel} HAS CREDIT`,
    );
    args._accountConfirmed = true;
  }

  const prompt = promptForCleanup = await exactVisibleLocator(chosen.page, selectors.prompt, "prompt field");
  const create = await exactVisibleLocator(chosen.page, selectors.create, "Create button");
  const settings = await exactVisibleLocator(chosen.page, selectors.settings_trigger, "settings trigger");

  const settingsStartedAt = Date.now();
  // Normalize the settings overlay state. If its controls are already visible, toggle it
  // closed first. A separate account-menu overlay is not dismissed blindly; stop safely.
  const modelAlreadyVisible = await chosen.page.locator(selectors.model).count() === 1
    && await chosen.page.locator(selectors.model).isVisible().catch(() => false);
  if (modelAlreadyVisible) {
    await settings.click({ timeout: 8000 }).catch(() => {
      throw new Error("Settings overlay could not be closed. Close the Flow overlay manually and rerun; prompt remains untouched.");
    });
  } else {
    const backdrop = chosen.page.locator(".cdk-overlay-backdrop:visible");
    if (await backdrop.count().catch(() => 0) > 0) {
      throw new Error("A Flow/account overlay is already open and blocks the settings control. Close the overlay manually and rerun; prompt remains untouched.");
    }
  }
  // Open settings; the model/radio controls are rendered only while this panel is open.
  await settings.click({ timeout: 8000 }).catch(() => {
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
    await settingsAgain.click({ timeout: 8000 });
  } catch (error) {
    // First close a nested model menu, then toggle Settings closed if it remains open.
    await chosen.page.keyboard.press("Escape").catch(() => {});
    const modelStillVisible = await chosen.page.locator(selectors.model).count().then(async count =>
      count === 1 && await chosen.page.locator(selectors.model).isVisible().catch(() => false)).catch(() => false);
    const overlayStillVisible = await chosen.page.locator(".cdk-overlay-backdrop:visible").count().catch(() => 0) > 0;
    if (modelStillVisible || overlayStillVisible) {
      await chosen.page.locator(selectors.settings_trigger).click({ timeout: 4000 }).catch(() => {});
      await chosen.page.keyboard.press("Escape").catch(() => {});
    }
    throw new Error(`Settings preparation failed; attempted to close Flow overlays before stopping: ${error.message}`);
  }
  console.log(`Phase timing: settings preparation completed in ${Date.now() - settingsStartedAt}ms.`);
  if (chosen.page.url() !== originalUrl || !isFlowUrl(chosen.page.url())) {
    throw new Error("Flow tab URL changed unexpectedly while preparing. Stopping before Create.");
  }

  // Clear the prior variant's prompt and Ingredients chips before preparing another variant.
  if (variantIndex > 1) await clearPromptVerified(prompt, selectors, 4000);
  // Attach and verify the exact per-scene reference images only after closing Settings.
  // If Flow does not expose a unique add button, file input, and visible reference-item selector,
  // stop before filling the prompt or enabling a possible Create action.
  const referenceUploadStartedAt = Date.now();
  console.log(`Phase timing: reference upload started (${referenceImages.length} image(s)); asset-ready timeout=${ASSET_READY_TIMEOUT_MS}ms per image.`);
  const attachedReferenceUuids = await uploadSceneReferences(chosen.page, selectors, referenceImages, prompt, referenceAssetUuids);
  console.log(`Phase timing: reference upload completed in ${Date.now() - referenceUploadStartedAt}ms.`);
  if (args.waitForResult || args.dryRun) {
    const waitPreflightStartedAt = Date.now();
    const baselineUuidCache = new Map();
    try {
      const initialBalance = args.waitForResult ? await readCreditBalance(chosen.page, selectors) : null;
      if (args.waitForResult && initialBalance === null) throw new Error("Could not read an integer credit balance.");
      if (typeof selectors.generated_video_items !== "string" || !selectors.generated_video_items.trim()) throw new Error("Dry-run baseline scan requires a configured generated_video_items selector.");
      const videosTabState = await activateVideosTab(chosen.page, selectors);
      const initialScan = await collectAllGeneratedItems(chosen.page, selectors.generated_video_items, { uuidCache: baselineUuidCache, topLimit: 6, selectors });
      // Keep every stable media UUID in the baseline, including Failed tiles, so a
      // later disappearing/refunded tile cannot make another existing card look new.
      // Failed tiles are diagnostics only and never count as usable video candidates.
      if (!initialScan.topLimited || initialScan.items.length !== 6) throw new Error(`Pre-Create top-six baseline requires six visible tiles; observed ${initialScan.items.length}. Refusing to Create with an incomplete baseline.`);
      const initialItems = initialScan.items.map(item => item.key);
      const baselineUuids = initialScan.items.map(item => item.mediaUuid).filter(Boolean);
      const failedBaselineItems = initialScan.items.filter(item =>
        /\bfailed\b/i.test(`${item.state} ${item.text}`) || isGenerationFailureText(`${item.state} ${item.text}`));
      console.log(JSON.stringify({
        event: "baseline_media_inventory_summary",
        baseline_strategy: "top_6_tiles_only",
        reached_bottom: initialScan.reachedBottom,
        tile_count: initialScan.items.length,
        uuid_count: baselineUuids.length,
        uuid_sample_first_5: baselineUuids.slice(0, 5),
        unkeyed_items_detected: initialScan.unkeyedItemsDetected,
        duplicate_visible_key_detected: initialScan.duplicateVisibleKeyDetected,
      }, null, 2));
      if (initialScan.unkeyedItemsDetected || initialScan.duplicateVisibleKeyDetected
        || baselineUuids.length !== 6 || initialItems.some(key => !key) || new Set(initialItems).size !== initialItems.length) {
        throw new Error(`Top-6 baseline requires six unique, stable media UUIDs/keys (tiles=${initialScan.items.length}, UUIDs=${baselineUuids.length}, sample=${baselineUuids.slice(0, 6).join(",") || "none"}).`);
      }
      args._waitInitialBalance = initialBalance;
      args._waitInitialItemKeys = initialItems;
      args._waitUuidCache = baselineUuidCache;
      args._waitInitialItemCount = initialItems.length - failedBaselineItems.length;
      console.log(args.waitForResult
        ? "WAIT SELECTOR PREFLIGHT (read-only; no Create click; Videos tab selected when available; first 6 tiles only; Failed tiles retained only as baseline UUIDs)"
        : "DRY-RUN MEDIA BASELINE (read-only; no Create click; Videos tab selected when available; first 6 tiles only; no full-grid sweep)");
      console.log(JSON.stringify({
        mode: args.waitForResult ? "wait-preflight" : "dry-run-baseline",
        credit_balance: initialBalance,
        videos_tab_state: videosTabState,
        existing_video_tile_count: args._waitInitialItemCount,
        ignored_failed_tile_count: failedBaselineItems.length,
        ignored_failed_tile_keys: failedBaselineItems.map(item => item.key),
        baseline_media_key_count: initialItems.length,
        baseline_media_keys: initialItems,
      }, null, 2));
      console.log(`Phase timing: wait selector preflight completed in ${Date.now() - waitPreflightStartedAt}ms.`);
    } catch (error) {
      // The outer pre-submit failure handler owns cleanup and emits the only
      // authoritative success/failure message after verifying the actual state.
      throw new Error(`Wait selector preflight failed: ${error.message}`);
    }
  }

  // Only now modify the prompt. If fill fails, attempt to clear it before returning an error.
  const screenshot = path.resolve(args.screenshot || `flow-pilot-${scene.scene_id.replace(/[^a-zA-Z0-9_-]/g, "_")}-${args.execute ? "execute" : "dry-run"}.png`);
  const promptFillStartedAt = Date.now();
  try {
    await prompt.fill(scene.prompt, { timeout: 2500 });
    await waitForCreateEnabled(chosen.page, create, 5000);
    await verifyAttachedReferenceUuids(chosen.page, selectors, attachedReferenceUuids);
    // A screenshot is diagnostic only; a slow Chrome render must not invalidate an otherwise good preflight.
    try {
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      await chosen.page.screenshot({ path: screenshot, fullPage: false, timeout: 10000 });
    } catch (screenshotError) {
      console.warn(`Could not save preflight screenshot (non-fatal): ${screenshotError.message}`);
    }
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
  console.log(`Phase timing: prompt fill, readiness checks and screenshot completed in ${Date.now() - promptFillStartedAt}ms.`);
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
    face_reference_ids: (scene.face_reference_ids || [scene.face_reference_id]).map(value => path.basename(value)),
    face_description_mode: scene.face_description_mode || "include",
    reference_order: "primary face reference first, supporting references after",
    job_id: scene.job_id || scene.scene_id,
    variant_index: variantIndex,
    variant_count: variantCount,
    total_estimated_credit_cost: creditCost === null ? null : creditCost * variantCount,
    framing_helper_applied: Boolean(scene.framing_helper_applied),
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

  if (variantCount > 1) {
    if (!args._variantsConfirmed) {
      if (creditCost === null) throw new Error("Cannot run multiple variants safely because Flow did not expose the per-clip credit estimate; refusing to submit without a total estimate.");
      const totalEstimate = creditCost * variantCount;
      await askExact(rl,
        `This will submit ${variantCount} separate variants for job ${scene.job_id || scene.scene_id}, estimated total ${totalEstimate} credits (${creditCost} each). Type CREATE ${variantCount} VARIANTS FOR ${scene.scene_id}: `,
        `CREATE ${variantCount} VARIANTS FOR ${scene.scene_id}`);
      args._variantsConfirmed = true;
    }
  } else {
    await askExact(rl, `This action may consume credit. Type CREATE ONE VIDEO FOR ${scene.scene_id} to submit exactly once: `,
      `CREATE ONE VIDEO FOR ${scene.scene_id}`);
  }
  args._waitStartedOn = new Date().toISOString();
  appendEvent(args.log, {
    event: "submission_intent", scene_id: scene.scene_id, job_id: scene.job_id || scene.scene_id, variant_index: variantIndex, variant_count: variantCount, reference_image_count: referenceImages.length, reference_image_names: referenceImages.map(file => path.basename(file)), face_reference_id: scene.face_reference_id, face_reference_image: path.basename(faceReferenceImage), character_description: scene.character_description, model: scene.model, resolution: scene.resolution,
    prompt: scene.prompt, expression: scene.expression || null, framing_helper_applied: Boolean(scene.framing_helper_applied), account_email: account.observedEmail, project_id: chosen.projectId,
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
      await activateVideosTab(chosen.page, selectors);
      const currentScan = await collectAllGeneratedItems(chosen.page, selectors.generated_video_items, { uuidCache: args._waitUuidCache || new Map(), topLimit: 6, selectors });
      if (!currentScan.topLimited || currentScan.items.length !== 6) throw new Error(`Pre-Create top-six baseline is incomplete (observed ${currentScan.items.length}); refusing to click Create.`);
      args._waitInitialItemKeys = currentScan.items.map(item => item.key);
      if (currentScan.unkeyedItemsDetected || currentScan.duplicateVisibleKeyDetected
        || currentScan.items.some(item => !item.mediaUuid) || new Set(args._waitInitialItemKeys).size !== args._waitInitialItemKeys.length) {
        throw new Error("Pre-Create top-six media baseline is ambiguous; all six tiles must have stable unique UUIDs. Refusing to click Create.");
      }
      args._waitInitialItemCount = args._waitInitialItemKeys.length;
      console.log(`Final pre-Create baseline UUID count: ${args._waitInitialItemKeys.length}.`);
    }
    args._waitCreateClickedAt = new Date().toISOString();
    console.log(`Pre-Create baseline UUID count: ${args._waitInitialItemKeys?.length ?? 0}. Create timestamp: ${args._waitCreateClickedAt}`);
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
          beforeBalance: args._waitInitialBalance,
          createClickedAt: args._waitCreateClickedAt,
          uuidCache: args._waitUuidCache || new Map(),
          beforeCount: args._waitInitialItemCount,
          timeoutMs: args.waitTimeoutMs,
          downloadDir: args.downloadDir,
          sceneId: scene.scene_id,
          attemptId: args._waitAttemptId,
          timeoutScreenshot: `${screenshot}.wait-timeout.png`,
          variantIndex,
          variantCount,
        });
        downloadedFile = result.downloadedFile;
        mediaUri = result.mediaUri || chosen.page.url();
        downloadError = result.downloadError;
        resultStatus = "succeeded";
      } catch (error) {
        timeoutError = String(error.message || error);
        mediaUri = chosen.page.url();
        if (timeoutError.startsWith("FLOW_GENERATION_FAILED:")) resultStatus = "failed";
        appendEvent(args.log, { event: resultStatus === "failed" ? "generation_failed_detected" : "generation_wait_unverified", scene_id: scene.scene_id, status: resultStatus === "failed" ? "failed_do_not_retry" : "unknown_do_not_retry", error: timeoutError });
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
        variantIndex, variantCount,
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
      } else if (resultStatus === "failed") {
        if (/prominent people|might violate our policies/i.test(String(timeoutError || ""))) {
          console.error("POLICY REFUSAL: Flow flagged this request under its prominent-people policy. The refusal is recorded in the ledger; this batch stops and no automatic retry or reference/prompt substitution will be attempted. Review Flow policy and the content before manually starting a new, policy-compliant attempt.");
        } else {
          console.error("Flow generation failure was detected and recorded in the ledger. Do NOT retry automatically.");
        }
        if (variantCount > 1) {
          args._stopVariants = true;
          console.error(`Stopping variant batch after variant ${variantIndex}/${variantCount} failed; later variants will NOT be submitted with the same prompt.`);
        }
        process.exitCode = 2;
        return;
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
  try {
    let variantCount = 1;
    if (args.scene) {
      const inputScene = JSON.parse(fs.readFileSync(path.resolve(args.scene), "utf8"));
      variantCount = inputScene.variants === undefined ? 2 : inputScene.variants;
      if (!Number.isInteger(variantCount) || variantCount < 1 || variantCount > 3) throw new Error("variants must be an integer from 1 to 3.");
    }
    args._variantCount = variantCount;
    if (args.execute && variantCount > 1 && !args.waitForResult) {
      throw new Error("Executing variants requires --wait so every submitted clip can be verified, downloaded, and recorded in the generation ledger.");
    }
    if (args.execute && variantCount > 1) {
      for (let index = 1; index <= variantCount; index += 1) {
        args._variantIndex = index;
        console.log(`\\nPreparing variant ${index}/${variantCount} for the same job and prompt.`);
        await prepare(args, browser, rl);
        if (args._stopVariants) break;
      }
    } else {
      args._variantIndex = 1;
      await prepare(args, browser, rl);
    }
  }
  finally {
    rl.close();
    await browser.close();
  }
}

main().catch(error => {
  console.error(`Flow Pilot stopped safely: ${error.message}`);
  process.exitCode = 2;
});

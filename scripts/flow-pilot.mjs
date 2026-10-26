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
import { normalizeAsbIdentityToken, firstThreeThumbnailTokensMatch } from "./asb-identity.mjs";

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
    waitForResult: false, recoverAttempt: null, waitTimeoutMs: 600000, downloadDir: "local/flow-downloads", ledgerOutput: "local/flow-generation-ledger.jsonl", ledgerProjectId: null, variantIndex: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--inspect") args.inspect = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--keep-prompt-after-dry-run") args.clearAfterDryRun = false;
    else if (arg === "--tab") args.tab = Number(argv[++i]);
    else if (arg === "--variant-index") args.variantIndex = Number(argv[++i]);
    else if (arg === "--scene") args.scene = argv[++i];
    else if (arg === "--selectors") args.selectors = argv[++i];
    else if (arg === "--account-label") args.accountLabel = argv[++i];
    else if (arg === "--expected-email") args.expectedEmail = argv[++i];
    else if (arg === "--expected-project") args.expectedProject = argv[++i];
    else if (arg === "--log") args.log = argv[++i];
    else if (arg === "--screenshot") args.screenshot = argv[++i];
    else if (arg === "--wait") args.waitForResult = true;
    else if (arg === "--recover-attempt") args.recoverAttempt = argv[++i];
    else if (arg === "--wait-timeout-ms") args.waitTimeoutMs = Number(argv[++i]);
    else if (arg === "--download-dir") args.downloadDir = argv[++i];
    else if (arg === "--ledger-output") args.ledgerOutput = argv[++i];
    else if (arg === "--ledger-project-id") args.ledgerProjectId = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.inspect && args.execute) throw new Error("Use --inspect or --execute, not both.");
  if (args.execute && args.dryRun) throw new Error("Use --dry-run or --execute, not both.");
  if (args.recoverAttempt && (args.inspect || args.execute || args.dryRun || args.waitForResult || args.variantIndex !== null)) {
    throw new Error("--recover-attempt is a separate no-Create recovery mode; do not combine it with inspect, execute, dry-run, wait, or variant-index.");
  }
  if (args.recoverAttempt && !/^attempt-[0-9a-f-]{36}$/i.test(args.recoverAttempt)) {
    throw new Error("--recover-attempt must be the exact attempt-<UUID> from the generation ledger.");
  }
  if (args.waitForResult && !args.execute && !args.dryRun) throw new Error("--wait without --execute is preflight-only; pass --dry-run --wait explicitly.");
  if (!Number.isInteger(args.waitTimeoutMs) || args.waitTimeoutMs < 30000 || args.waitTimeoutMs > 1800000) throw new Error("--wait-timeout-ms must be an integer from 30000 to 1800000.");
  if (args.waitForResult && (!args.downloadDir || !args.ledgerOutput)) throw new Error("--wait requires non-empty --download-dir and --ledger-output paths.");
  if (args.tab !== null && (!Number.isInteger(args.tab) || args.tab < 0)) throw new Error("--tab must be a zero-based non-negative index.");
  if (args.variantIndex !== null && (!Number.isInteger(args.variantIndex) || args.variantIndex < 1 || args.variantIndex > 3)) throw new Error("--variant-index must be an integer from 1 to 3.");
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

Actual one-scene submission (requires a separate second confirmation; --wait is required; --variant-index selects one variant from a multi-variant job):
  node scripts/flow-pilot.mjs --execute --wait --wait-timeout-ms 600000 --tab 4 \\
    --scene path/to/scene.json --selectors local/flow-selectors.json \\
    --account-label "my Flow account" --expected-email "you@example.com" \\
    --expected-project "project-uuid" --download-dir local/flow-downloads \\
    --ledger-output local/flow-generation-ledger.jsonl

Selector-only preflight (no Create click; validates balance and stable tile identities):
  node scripts/flow-pilot.mjs --dry-run --wait --tab 4 --scene path/to/scene.json \\\
    --selectors local/flow-selectors.json --account-label "my Flow account" \\\
    --expected-email "you@example.com" --expected-project "project-uuid"

--wait requires selector keys: credit_balance, generated_video_items, and download_media_button.
The download menu is selected dynamically by its visible "Original size" label. Pass --dry-run --wait
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
    const normalized = String(text || "").replace(/,/g, "").replace(/\s+/g, " ").trim();
    const match = normalized.match(/^(\d+)\s*(?:Google Flow credits?|credits?)?$/i)
      || normalized.match(/(?:^|\s)(\d+)\s+Google Flow credits?\b/i);
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const readVisible = async () => {
    try {
      const locator = await exactVisibleLocator(page, selector, "credit balance", 1500);
      const parsed = parseBalance(await locator.innerText({ timeout: 2000 }).catch(() => ""));
      return parsed !== null ? parsed : parseBalance(await locator.textContent({ timeout: 1500 }).catch(() => ""));
    } catch { return null; }
  };
  for (let i = 0; i < 4; i += 1) {
    const value = await readVisible();
    if (value !== null || typeof selectors === "string") return value;
    if (i < 3) await page.waitForTimeout(500);
  }
  if (typeof selectors === "string" || !selectors.account_panel_open || !selectors.account_panel_close) return null;
  let openedByUs = false, balance = null;
  for (let attempt = 0; attempt < 3 && balance === null; attempt += 1) {
    if (!(await page.locator(selector).first().isVisible().catch(() => false))) {
      const opener = await exactVisibleLocator(page, selectors.account_panel_open, "account panel open button", 2000).catch(() => null);
      if (!opener) { await page.waitForTimeout(500); continue; }
      await opener.click({ timeout: 2500 }).catch(() => {});
      openedByUs = true;
    }
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      balance = await readVisible();
      if (balance !== null) break;
      await page.waitForTimeout(350);
    }
    if (balance === null && attempt < 2) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  if (openedByUs) {
    const closer = await exactVisibleLocator(page, selectors.account_panel_close, "account panel close button", 1500).catch(() => null);
    if (closer) {
      await closer.click({ timeout: 2500 }).catch(() => {});
      await page.locator(selectors.account_panel_close).waitFor({ state: "hidden", timeout: 2500 }).catch(() => {});
    } else await page.keyboard.press("Escape").catch(() => {});
  }
  return balance;
}
async function generatedItemKeys(page, selector) {
  return page.locator(selector).evaluateAll(elements => elements.map(element => {
    const primarySources = [
      element.querySelector("video")?.getAttribute("src"),
      element.getAttribute("data-id"),
      element.getAttribute("href"),
      element.querySelector("a[href]")?.getAttribute("href"),
    ].filter(Boolean).map(String);
    const imageSource = element.querySelector("img")?.getAttribute("src") || "";
    const uuidFrom = value => {
      const matches = String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
      return matches && matches.length ? matches[matches.length - 1].toLowerCase() : null;
    };
    // /image/<uuid> identifies a thumbnail image, not necessarily the video asset.
    // Never promote it into the baseline media identity without independent evidence.
    // Thumbnail routes are not video identities: /image/<uuid> can have a
    // different UUID from the underlying generated video.
    const mediaUuid = primarySources.filter(value => !/\/image\//i.test(value)).map(uuidFrom).find(Boolean)
      || (/\/image\//i.test(imageSource) ? null : uuidFrom(imageSource));
    if (mediaUuid) return `media:${mediaUuid}`;
    const textNode = element.cloneNode(true);
    textNode.querySelectorAll("a,button,[role=button],[aria-label]").forEach(node => node.remove());
    const tileText = String(textNode.innerText || textNode.textContent || "").replace(/\s+/g, " ").trim();
    return tileText ? `tile-text:${tileText.slice(0, 220)}` : "";
  }));
}

// Flow's media grid may virtualize its DOM. Sweep the grid's scroll container and
// union keys from every viewport instead of treating the first rendered batch as
// the complete project inventory. Restore the initial scroll position unless a
// target key was requested, in which case leave that tile in view for a safe click.
async function collectAllGeneratedItems(page, selector, { targetKey = null, maxScrolls = 120, uuidCache = new Map(), topLimit = null, selectors = {}, skipUuidResolution = false } = {}) {
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
  const resolveUuidByOpeningTile = async (index, identity = null, rowIdentities = [], expectedTileCount = null) => {
    const gridUrl = page.url();
    const scrollTop = await readScrollTop();
    let lastError = null;
    // Lazy thumbnails must load before attempting route-based tile re-identification.
    // Generic tile text is not a stable media identity and is never used as a key.
    if (!identity?.thumbnailSrc && Number.isInteger(index) && index >= 0) {
      const tokenRecaptureStartedAt = Date.now();
      // Read the existing DOM synchronously. Repeated locator.getAttribute() calls
      // can each consume Playwright's default timeout when the tile has no <img>,
      // turning this "8 x 250ms" probe into a multi-minute stall.
      const source = await page.locator(selector).evaluateAll((elements, tileIndex) =>
        elements[tileIndex]?.querySelector("img")?.getAttribute("src") || null, index
      ).catch(() => null);
      if (source && thumbnailIdentityToken(source)) {
        identity = { ...(identity || {}), thumbnailSrc: source };
      }
      const hasStableUuid = Boolean(identity?.mediaUuid
        || String(identity?.key || "").match(/^media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1]);
      if (!identity?.thumbnailSrc && !hasStableUuid) {
        console.warn(JSON.stringify({ event: "media_tile_identity_recapture_skipped",
          tile_index: index, reason: "thumbnail_token_still_missing_and_no_stable_uuid",
          elapsed_ms: Date.now() - tokenRecaptureStartedAt, attempts: 0,
          next_step: "return_unresolved_for_bounded_inventory_recapture" }));
        return null;
      }
    }
    // Five editor round-trips per tile caused multi-minute preflight stalls when
    // signed thumbnail tokens rotated. Two bounded attempts are enough to gather
    // fresh UUID/network evidence; unresolved identity must fail closed.
    const maxIdentityAttempts = 2;
    for (let attempt = 1; attempt <= maxIdentityAttempts; attempt += 1) {
      const reidentificationAttemptStartedAt = Date.now();
      try {
        // Re-enter the project grid and Videos tab for each attempt, then re-find
        // Prefer UUID/network metadata; thumbnail URL tokens are a hint only because /asb/ signatures can rotate.
        // Avoid a needless route reload when already on the grid: Flow may rotate
        // signed /asb/ thumbnail tokens on every navigation. Snapshot and identify
        // the tile from the same live grid view whenever possible.
        const currentPageUrl = page.url();
        const alreadyOnGrid = currentPageUrl === gridUrl
          && await page.locator(selector).count().catch(() => 0) >= 3;
        if (!alreadyOnGrid) {
          await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});
        }
        const tabResult = await activateVideosTab(page, selectors).catch(error => `error:${error.message}`);
        if (/_click_failed|not_found_no_tab_switch|_not_found/.test(tabResult)) {
          throw new Error(`Videos tab activation could not be confirmed (${tabResult}); refusing tile identity lookup on an uncertain grid.`);
        }
        // Flow may briefly render All media (or an incomplete grid) after route entry.
        // Wait for at least three visible first-row thumbnails and a stable two-snapshot token list.
        let previousTokens = null;
        let currentTokens = [];
        // Do not treat three empty/lazy image elements as a stable grid. Require
        // at least three non-empty thumbnail URL tokens in two consecutive snapshots.
        for (let gridPoll = 0; gridPoll < 30; gridPoll += 1) {
          currentTokens = await page.locator(selector).evaluateAll(elements => elements.slice(0, 6).map(element => {
            // A tile can render its preview as img or video. Prefer active media
            // src, then nested source, then poster; all identify the visible preview.
            const sources = [
              element.querySelector("img")?.getAttribute("src"),
              element.querySelector("video")?.getAttribute("src"),
              element.querySelector("video source")?.getAttribute("src"),
              element.querySelector("video")?.getAttribute("poster"),
              element.querySelector("source")?.getAttribute("src"),
              element.querySelector("img")?.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0],
            ].filter(Boolean);
            for (const source of sources) {
              if (/\/image\//i.test(source)) continue;
              const asbMatch = String(source).match(/\/asb\/([^/?#]+)/i);
              if (asbMatch?.[1]) return `asb:${asbMatch[1].split("=", 1)[0]}`;
              try {
                const pathname = new URL(source, location.href).pathname;
                if (pathname) return pathname;
              } catch {}
            }
            return "";
          })).catch(() => []);
          const firstThreeTokens = currentTokens.slice(0, 3);
          const previousFirstThreeTokens = previousTokens?.slice(0, 3) || [];
          if (firstThreeTokens.length === 3 && firstThreeTokens.every(Boolean) && previousFirstThreeTokens.length === 3
            && previousFirstThreeTokens.every(Boolean) && currentTokens.length === previousTokens.length
            && firstThreeTokens.every((token, i) => token === previousFirstThreeTokens[i])) break;
          previousTokens = currentTokens;
          await page.waitForTimeout(250);
        }
        // If the grid never left this route, bind the lookup to the freshly
        // stabilized token at the requested index, not a stale signed token from
        // an earlier snapshot. This is only safe after the two-snapshot grid check.
        const expectedToken = alreadyOnGrid && currentTokens[index]
          ? currentTokens[index]
          : (identity?.thumbnailSrc ? thumbnailIdentityToken(identity.thumbnailSrc) : null);
        console.log(JSON.stringify({
          event: "media_tile_reidentification",
          attempt,
          tile_index: index,
          videos_tab_activation: tabResult,
          expected_thumbnail_token: expectedToken,
          visible_first_six_thumbnail_tokens: currentTokens.slice(0, 6),
          visible_tile_count: await page.locator(selector).count().catch(() => 0),
          elapsed_ms: Date.now() - reidentificationAttemptStartedAt,
        }));
        let currentIndex = -1;
        // Prefer the stable media UUID over a signed thumbnail URL. Flow's /asb/
        // thumbnail tokens can rotate when the project grid is re-entered.
        const expectedUuid = identity?.mediaUuid
          || String(identity?.key || "").match(/^media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1]
          || null;
        if (expectedUuid) {
          const candidates = await page.locator(selector).evaluateAll(elements => elements.map((element, candidateIndex) => {
            const nodes = [element, ...Array.from(element.querySelectorAll("*"))];
            const values = [];
            for (const node of nodes) {
              for (const attr of ["data-media-id", "data-asset-id", "data-uuid", "data-id", "href", "src"]) {
                const value = node.getAttribute?.(attr);
                if (value) values.push(String(value));
              }
            }
            const uuids = Array.from(new Set(values.flatMap(value =>
              value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig) || []
            ).map(value => value.toLowerCase())));
            const textNode = element.cloneNode(true);
            textNode.querySelectorAll("a,button,[role=button],[aria-label]").forEach(node => node.remove());
            const text = String(textNode.innerText || textNode.textContent || "").replace(/\s+/g, " ").trim();
            return { index: candidateIndex, uuids, text };
          })).catch(() => []);
          currentIndex = candidates.find(candidate => candidate.uuids.includes(expectedUuid.toLowerCase()))?.index ?? -1;
          // Some Flow builds expose UUIDs only in list JSON. Use its uniquely
          // matching text metadata as a second stable-identity source.
          if (currentIndex < 0) {
            const networkMatches = candidates.filter(candidate => resolveUuidFromNetwork({ text: candidate.text }) === expectedUuid.toLowerCase());
            if (networkMatches.length === 1) currentIndex = networkMatches[0].index;
          }
          if (currentIndex >= 0) {
            console.log(JSON.stringify({ event: "media_tile_reidentified_by_uuid", tile_index: index, expected_uuid: expectedUuid.toLowerCase(), matched_index: currentIndex, source: "dom_or_network_metadata" }));
          }
        }
        if (currentIndex < 0 && expectedToken) {
          currentIndex = await page.locator(selector).evaluateAll((elements, expected) =>
            elements.findIndex(element => {
              const source = element.querySelector("img")?.getAttribute("src") || "";
              const asb = source.match(/\/asb\/([^/?#]+)/i);
              let token;
              if (asb) token = `asb:${asb[1].split("=", 1)[0]}`;
              else { try { token = new URL(source, location.href).pathname; } catch { token = source.split(/[?#]/, 1)[0]; } }
              return token === expected;
            }), expectedToken).catch(() => -1);
        }
        // Text labels (e.g. generic play/duration text) are not identity.
        // Re-identification must use a loaded thumbnail token or validated neighbors.
        // A signed /asb/ token may rotate for the same media. For a middle tile,
        // permit index fallback only when both neighboring tile tokens and the
        // DOM tile count still match the original row snapshot.
        if (currentIndex < 0 && Number.isInteger(index) && index > 0 && index < 2 && rowIdentities.length >= 3) {
          const expectedRowTokens = rowIdentities.slice(0, 3).map(item => item?.thumbnailSrc ? thumbnailIdentityToken(item.thumbnailSrc) : null);
          const currentRowTokens = currentTokens.slice(0, 3);
          const currentTileCount = await page.locator(selector).count().catch(() => 0);
          const neighborsMatch = Boolean(expectedRowTokens[0] && expectedRowTokens[2]
            && currentRowTokens[0] === expectedRowTokens[0]
            && currentRowTokens[2] === expectedRowTokens[2]);
          const tileCountMatches = expectedTileCount === null || currentTileCount === expectedTileCount;
          if (neighborsMatch && tileCountMatches && currentRowTokens[index] && expectedRowTokens[index]
            && currentRowTokens.length === 3) {
            console.log(JSON.stringify({
              event: "token_changed_at_index",
              tile_index: index,
              old_thumbnail_token: expectedRowTokens[index],
              new_thumbnail_token: currentRowTokens[index],
              left_neighbor_match: true,
              right_neighbor_match: true,
              expected_tile_count: expectedTileCount,
              current_tile_count: currentTileCount,
              accepted_by_position_with_neighbor_validation: true,
            }));
            currentIndex = index;
          }
        }

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
          console.log(JSON.stringify({ event: "media_tile_uuid_resolution_timing", tile_index: index, attempt, elapsed_ms: Date.now() - reidentificationAttemptStartedAt, outcome: "resolved", uuid }));
          if (attempt > 1) console.log(`Resolved tile index ${index} UUID after retry ${attempt}: ${uuid}`);
          return uuid;
        }
        lastError = new Error(`clicked tile did not expose an /edit/<uuid> URL (current URL: ${currentUrl})`);
        console.warn(JSON.stringify({ event: "media_tile_uuid_resolution_timing", tile_index: index, attempt, elapsed_ms: Date.now() - reidentificationAttemptStartedAt, outcome: "unresolved", reason: lastError.message }));
      } catch (error) {
        lastError = error;
        console.warn(JSON.stringify({ event: "media_tile_uuid_resolution_timing", tile_index: index, attempt, elapsed_ms: Date.now() - reidentificationAttemptStartedAt, outcome: "retryable_error", reason: String(error?.message || error).slice(0, 300) }));
        if (/\/edit\//i.test(page.url())) {
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => {});
          await page.waitForFunction(pathname => location.pathname === pathname, new URL(gridUrl).pathname, { timeout: 10000 }).catch(() => {});
          await restoreScrollTop(scrollTop).catch(() => {});
        }
        if (attempt < maxIdentityAttempts) {
          console.warn(`Retrying media UUID lookup for tile index ${index} (attempt ${attempt}/${maxIdentityAttempts}): ${error.message}`);
          await page.waitForTimeout(400 * attempt);
        }
      }
    }
    console.warn(`Could not resolve media UUID by opening tile index ${index} after ${maxIdentityAttempts} bounded attempts: ${lastError?.message || "unknown error"}`);
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
      // Prefer explicit media IDs and the editor's /edit/<media UUID> route
      // over a video src: Flow can expose a poster/thumbnail UUID at /video/<id>.
      const explicitMediaSources = [
        element.getAttribute("data-media-id"),
        element.getAttribute("data-asset-id"),
        element.getAttribute("data-uuid"),
        element.getAttribute("data-id"),
      ].filter(Boolean).map(String);
      const hrefSources = [
        element.getAttribute("href"),
        element.querySelector("a[href]")?.getAttribute("href"),
      ].filter(Boolean).map(String);
      const primarySources = [
        ...explicitMediaSources,
        ...hrefSources.filter(value => /\/edit\//i.test(value)),
        ...hrefSources.filter(value => /\/video\//i.test(value)),
        element.querySelector("video")?.getAttribute("src"),
        ...hrefSources,
      ].filter(Boolean).map(String);
      const thumbnailSrc = element.querySelector("img")?.getAttribute("src") || null;
      const uuidFrom = value => {
        const matches = String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
        return matches && matches.length ? matches[matches.length - 1].toLowerCase() : null;
      };
      // Do not confuse /image/<uuid> thumbnail identifiers with video media UUIDs.
      // A /image/<uuid> href is a thumbnail ID, not the video's media UUID.
      const mediaUuid = primarySources.filter(value => !/\/image\//i.test(value)).map(uuidFrom).find(Boolean)
        || (thumbnailSrc && !/\/image\//i.test(thumbnailSrc) ? uuidFrom(thumbnailSrc) : null);
      const sources = [...primarySources, ...(thumbnailSrc ? [thumbnailSrc] : [])];
      const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
      const identityNode = element.cloneNode(true);
      identityNode.querySelectorAll("a,button,[role=button],[aria-label]").forEach(node => node.remove());
      const identityText = String(identityNode.innerText || identityNode.textContent || "").replace(/\s+/g, " ").trim();
      const hint = [text, ...sources].join("|");
      const key = mediaUuid ? `media:${mediaUuid}` : (thumbnailSrc ? `thumbnail:${thumbnailSrc.split(/[?#]/, 1)[0]}` : "");
      const state = [element.getAttribute("data-status"), element.getAttribute("data-state"),
        element.getAttribute("aria-label"), element.getAttribute("title")].filter(Boolean).join(" ");
      const progress = Boolean(element.querySelector('[role="progressbar"], progress, [aria-valuenow]'));
      const createdAt = element.querySelector("time[datetime]")?.getAttribute("datetime")
        || element.getAttribute("data-created-at") || element.getAttribute("data-createdat")
        || element.querySelector("[data-created-at]")?.getAttribute("data-created-at") || null;
      return { key: String(key).trim(), mediaUuid: mediaUuid ? mediaUuid.toLowerCase() : null, hint, text, thumbnailSrc, state, progress, index, createdAt };
    }));
    const domTileCount = visible.length;
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
      if (!item.mediaUuid && !skipUuidResolution) {
        const resolvedUuid = await resolveUuidByOpeningTile(item.index, item, visible, domTileCount);
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
      const knownPolicyRefusal = isKnownPolicyRefusalTile(item);
      if (!knownPolicyRefusal && (!item.key || !item.mediaUuid)) unkeyedItemsDetected = true;
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
  // A top-limited first-row snapshot must preserve DOM rows even when a tile has
  // no key yet. Dropping unkeyed rows shifts indexes and makes a neighbor's UUID
  // appear to belong to the missing tile. The full-grid inventory remains keyed.
  const topLimited = Number.isInteger(topLimit) && topLimit > 0;
  return { items: topLimited ? (topItems || []).slice(0, topLimit) : Array.from(all.values()), topItems: topItems || [], targetIndex: null, scrolledToTarget: false, unkeyedItemsDetected, duplicateVisibleKeyDetected, reachedBottom, topLimited };
}

function isGenerationFailureText(value) {
  // Match provider failures, including Flow's unusual-activity/browser-extension rejection.
  return /generation failed|failed to generate|couldn['’]?t generate|unable to generate|video failed|something went wrong|blocked by (?:policy|safety)|might violate|violate(?:s|d)? (?:our )?policies|violat(?:es|ed) (?:our )?(?:policy|policies|guidelines)|prominent people|you will be refunded|generation error|unusual activity|browser extensions? that modify the page/i.test(String(value || ""));
}

function isKnownPolicyRefusalTile(item) {
  if (!item || item.mediaUuid) return false;
  const text = String(item.text || "");
  const state = String(item.state || "");
  // Only an explicit provider refusal is a stable non-media baseline item.
  // Generic failures, empty cards, loading cards, and unknown states still fail closed.
  return /\bfailed\b/i.test(state + " " + text)
    && /prominent people/i.test(text)
    && /might violate our policies/i.test(text)
    && /you will be refunded/i.test(text);
}

function failedPolicyBaselineKey(item) {
  if (!isKnownPolicyRefusalTile(item)) return null;
  const normalized = String(item.text || "").replace(/\s+/g, " ").trim().toLowerCase();
  return normalized ? "failed-policy:" + normalized : null;
}

async function activateVideosTab(page, selectors) {
  const isSelected = async locator => locator.evaluate(element => {
    let node = element;
    for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
      const ariaSelected = node.getAttribute("aria-selected");
      const ariaCurrent = node.getAttribute("aria-current");
      const dataState = node.getAttribute("data-state");
      const className = typeof node.className === "string" ? node.className : "";
      if (ariaSelected === "true" || ariaCurrent === "page" || ariaCurrent === "true"
        || /^(active|selected)$/i.test(dataState || "")
        || /(^|\s)(active|selected|is-active|is-selected)(\s|$)/i.test(className)) return true;
    }
    return false;
  }).catch(() => false);
  const activateCandidate = async (getFresh, label) => {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const candidate = await getFresh();
      if (!candidate || !await candidate.isVisible().catch(() => false)) return null;
      if (await isSelected(candidate)) return label + "_already_selected";
      try {
        await candidate.waitFor({ state: "visible", timeout: 1800 });
        await candidate.scrollIntoViewIfNeeded({ timeout: 1800 }).catch(() => {});
        await page.waitForTimeout(120);
        // Reacquire the locator immediately before click; Flow may replace the tab
        // node during sidebar/grid re-rendering.
        const fresh = await getFresh();
        if (!fresh || !await fresh.isVisible().catch(() => false)) throw new Error("Videos tab became hidden during re-render");
        if (await isSelected(fresh)) return label + "_selected_during_wait";
        await fresh.click({ timeout: 4500 });
        await page.waitForTimeout(250);
        return label + "_clicked";
      } catch (error) {
        const afterFailure = await getFresh().catch(() => null);
        if (afterFailure && await isSelected(afterFailure)) return label + "_selected_after_click_recovery";
        console.warn(JSON.stringify({ event: "videos_tab_activation_retry", label, attempt, error: String(error?.message || error).slice(0, 240) }));
        if (attempt === 2) return label + "_click_failed";
        await page.waitForTimeout(250);
      }
    }
    return null;
  };

  if (selectors.videos_tab) {
    const result = await activateCandidate(
      async () => {
        try { return await exactVisibleLocator(page, selectors.videos_tab, "Videos tab"); }
        catch { return null; }
      },
      "configured_selector",
    );
    return result || "configured_selector_not_found";
  }

  const roleTab = page.getByRole("tab", { name: /^Videos$/i });
  const button = page.getByRole("button", { name: /^Videos$/i });
  // Flow may mount/recreate the sidebar during route transitions. Reacquire exact
  // role/name locators on each attempt and prefer detecting an already-selected tab.
  const deadline = Date.now() + 7000;
  let tabCount = 0;
  let buttonCount = 0;
  do {
    tabCount = await roleTab.count().catch(() => 0);
    for (let i = 0; i < tabCount; i += 1) {
      const result = await activateCandidate(async () => {
        const count = await page.getByRole("tab", { name: /^Videos$/i }).count().catch(() => 0);
        return i < count ? page.getByRole("tab", { name: /^Videos$/i }).nth(i) : null;
      }, "role=tab");
      if (result && !result.endsWith("_click_failed")) return result;
    }
    buttonCount = await button.count().catch(() => 0);
    for (let i = 0; i < buttonCount; i += 1) {
      const result = await activateCandidate(async () => {
        const count = await page.getByRole("button", { name: /^Videos$/i }).count().catch(() => 0);
        return i < count ? page.getByRole("button", { name: /^Videos$/i }).nth(i) : null;
      }, "role=button");
      if (result && !result.endsWith("_click_failed")) return result;
    }
    if (Date.now() < deadline) await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return "not_found_no_tab_switch (tabs=" + tabCount + ", buttons=" + buttonCount + ")";
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
  let message = String(value || "");
  const tileMarker = " reports failure: ";
  const tileIndex = message.indexOf(tileMarker);
  if (tileIndex >= 0) message = message.slice(tileIndex + tileMarker.length);
  const pageMarker = "Flow displayed a generation/policy failure: ";
  const pageIndex = message.indexOf(pageMarker);
  if (pageIndex >= 0) message = message.slice(pageIndex + pageMarker.length);
  message = message
    .replace(/\bTrack status here\b/ig, " ")
    .replace(/\b(?:refresh|undo|delete_forever|more_vert|download)\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
  return message || null;
}

function makeGenerationLedgerRecord({ scene, projectId, ledgerProjectId, prompt, estimatedCost, beforeBalance, afterBalance, resultStatus, mediaUri, downloadedFile, downloadError, timeoutError, actualResolution, downloadQualityLabel, verifiedMediaUuid = null, verificationState = "unverified", verificationEvidence = null, attemptNumber, attemptId, startedOn, variantIndex = 1, variantCount = 1 }) {
  const observedDelta = beforeBalance !== null && afterBalance !== null && beforeBalance >= afterBalance
    ? beforeBalance - afterBalance : null;
  const actualAmount = observedDelta !== null && observedDelta > 0 ? observedDelta : null;
  const refundPending = resultStatus === "failed" && /refund(?:ed)?(?: for this generation| may take| pending)?|you will be refunded/i.test(String(timeoutError || ""));
  const chargeStatus = refundPending ? "refunded_pending"
    : (actualAmount !== null ? "charged"
      : (["failed", "rejected_unusual_activity"].includes(resultStatus) && beforeBalance !== null && afterBalance !== null && beforeBalance === afterBalance ? "not_charged" : "unknown"));
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
        reference_language_mode: scene.reference_language_mode || "identity_preserving",
        reference_set_key: referenceSetKey,
        expression: scene.expression || null,
        other_reference_ids: otherReferenceIds,
      };
    })(),
    prompt: { text: prompt, sha256: createHash("sha256").update(prompt, "utf8").digest("hex"), template_version: null },
    rule_ids: [],
    result: {
      status: resultStatus,
      provider_message: ["failed", "rejected_unusual_activity"].includes(resultStatus) ? rawProviderMessage(timeoutError) : (timeoutError || null),
      failure: ["failed", "rejected_unusual_activity"].includes(resultStatus) ? {
        category: resultStatus === "rejected_unusual_activity" ? "provider_anti_abuse_rejection"
          : /prominent people|might violate our policies/i.test(String(timeoutError || "")) ? "provider_policy_prominent_people" : "browser_automation",
        failure_reason: resultStatus === "rejected_unusual_activity" ? "unusual_activity"
          : /prominent people|might violate our policies|you will be refunded/i.test(String(timeoutError || "")) ? "policy_prominent_people" : "provider_generation_failed",
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
      requested_resolution: scene.resolution || "360p",
      actual_resolution: actualResolution || null,
      resolution_match_status: (() => {
        const requested = String(scene.resolution || "360p").match(/(\d{3,4})p/i)?.[1];
        const actual = String(actualResolution || "").match(/^(\d{2,5})x(\d{2,5})$/i);
        if (!requested || !actual) return "unknown";
        return Number(actual[1]) === Number(requested) || Number(actual[2]) === Number(requested) ? "match" : "mismatch";
      })(),
      verification_state: verificationState,
      verified_media_uuid: verifiedMediaUuid || null,
      verification_evidence: verificationEvidence || null,
      download_quality_label: downloadQualityLabel || null,
      downloaded_file: downloadedFile || null,
      sha256: downloadedFile && fs.existsSync(downloadedFile) ? createHash("sha256").update(fs.readFileSync(downloadedFile)).digest("hex") : null,
      integrity_status: downloadedFile ? "verified" : (mediaUri ? "not_checked" : "missing"),
    },
    qc: { status: "not_reviewed", observed_defects: [], checks_passed: null, checks_total: null, reviewed_by: null, reviewed_on: null, notes: "Human QC has not been recorded.", watermark_status: scene.watermark_status || "not_reviewed" },
    created_by: "browser_automation",
    notes: [downloadError ? `Download failed: ${downloadError}` : null, timeoutError ? `Wait ended without verified completion: ${timeoutError}` : null].filter(Boolean).join(" "),
  };
}

function findNewCompletedMediaItems(items, beforeKeys) {
  const baseline = new Set(beforeKeys || []);
  return (items || []).filter(item => {
    if (!item?.mediaUuid || !item.key || baseline.has(item.key)) return false;
    const state = `${item.state || ""} ${item.text || ""}`;
    if (item.progress || /\b(?:generating|generation in progress|processing|in progress|queued|pending)\b/i.test(state)) return false;
    return true;
  });
}

function openedMediaUuidMatches(candidateMediaUuid, openedUrl, baselineKeys = []) {
  const route = /\/(?:edit|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
  let pathname = "";
  try { pathname = new URL(openedUrl).pathname; } catch { return false; }
  const openedUuid = pathname.match(route)?.[1]?.toLowerCase() || null;
  if (!openedUuid || !candidateMediaUuid || openedUuid !== String(candidateMediaUuid).toLowerCase()) return false;
  return !new Set(baselineKeys || []).has(`media:${openedUuid}`);
}

function orderedBaselineShiftIsVerified(first, shiftedItems, beforeKeys) {
  const baselineKeys = beforeKeys || [];
  if (!first || !Array.isArray(shiftedItems) || baselineKeys.length < 3) return false;
  const firstKey = failedPolicyBaselineKey(first) || first.key || "";
  const firstState = `${first.state || ""} ${first.text || ""}`;
  if (!firstKey || new Set(baselineKeys).has(firstKey) || first.mediaUuid || first.progress
    || /\bfailed\b/i.test(firstState) || isGenerationFailureText(firstState)) return false;
  // Match the three pre-Create first-row identities in order after the candidate.
  // A known policy-refusal tile has no media UUID, so its normalized text identity
  // must be reconstructed from its live tile text rather than its empty DOM key.
  return baselineKeys.slice(0, 3).every((baselineKey, index) => {
    const item = shiftedItems[index];
    if (!item) return false;
    const actualKey = failedPolicyBaselineKey(item) || item.key || "";
    if (baselineKey.startsWith("failed-policy:")) return actualKey === baselineKey;
    return actualKey === baselineKey && Boolean(item.mediaUuid);
  });
}

function readMp4VideoResolution(filename) {
  try {
    const buffer = fs.readFileSync(filename);
    // ISO-BMFF visual sample entries store width/height 24/26 bytes after the codec fourcc.
    // Only accept plausible dimensions and a recognized video codec marker.
    const codecs = ["avc1", "avc3", "hvc1", "hev1", "av01", "vp09", "mp4v"];
    for (const codec of codecs) {
      let offset = 0;
      while ((offset = buffer.indexOf(codec, offset, "ascii")) >= 0) {
        const widthOffset = offset + 28;
        if (widthOffset + 4 <= buffer.length) {
          const width = buffer.readUInt16BE(widthOffset);
          const height = buffer.readUInt16BE(widthOffset + 2);
          if (width >= 64 && width <= 16384 && height >= 64 && height <= 16384) return { width, height, label: `${width}x${height}`, codec };
        }
        offset += 4;
      }
    }
  } catch { /* Keep the download; record unknown metadata instead of guessing. */ }
  return null;
}

async function waitForGenerationAndDownload(page, selectors, { beforeKeys, beforeBalance, createClickedAt, uuidCache = new Map(), timeoutMs, downloadDir, sceneId, attemptId, timeoutScreenshot, onSubmissionEvidence = () => {}, variantIndex = 1, variantCount = 1, initialFailedTileTexts = [] }) {
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
      // media grid is stale. Give the newly charged generation one short, bounded
      // discovery extension; never click Create again.
      if (!chargedExtensionUsed && beforeBalance !== null) {
        const currentBalance = await readCreditBalance(page, selectors).catch(() => null);
        if (currentBalance !== null && currentBalance < beforeBalance) {
          chargedExtensionUsed = true;
          deadline = Date.now() + 30000;
          console.warn(`Flow credit balance decreased (${beforeBalance} -> ${currentBalance}) but the new video is not yet verified; extending result polling by 30000ms without resubmitting.`);
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
    // Some failed cards have no UUID/thumbnail/key, so inspect visible tile text directly.
    const visibleTileFailures = await page.locator(selectors.generated_video_items).evaluateAll(elements =>
      elements.slice(0, 6).map((element, index) => ({
        index, text: String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim(),
      }))).catch(() => []);
    const baselineFailedTexts = new Set(initialFailedTileTexts);
    const unusualActivityTile = visibleTileFailures.find(item =>
      /unusual activity|browser extensions? that modify the page/i.test(item.text)
      && !baselineFailedTexts.has(item.text.replace(/\s+/g, " ").trim().toLowerCase()));
    if (unusualActivityTile) {
      throw new Error(`FLOW_REJECTED_UNUSUAL_ACTIVITY: Flow rejected this submission at visible tile position ${unusualActivityTile.index}: ${unusualActivityTile.text}`);
    }
    const newlyFailedTileWithoutIdentity = visibleTileFailures.find(item => {
      const text = item.text.replace(/\s+/g, " ").trim().toLowerCase();
      return (/^failed\b/i.test(text) || isGenerationFailureText(text)) && !baselineFailedTexts.has(text);
    });
    if (newlyFailedTileWithoutIdentity) {
      throw new Error(`FLOW_GENERATION_FAILED: new Flow tile at position ${newlyFailedTileWithoutIdentity.index} reports failure without a stable media identity: ${newlyFailedTileWithoutIdentity.text}`);
    }
    const scan = await collectAllGeneratedItems(page, selectors.generated_video_items, {
      uuidCache, topLimit: 4, selectors, skipUuidResolution: true,
    }).catch(error => {
      console.warn(JSON.stringify({ event: "post_create_poll", poll_at: new Date().toISOString(),
        outcome: "inventory_scan_error", reason: String(error?.message || error).slice(0, 240) }));
      return { items: [], topItems: [], reachedBottom: false, topLimited: false };
    });
    if (!scan.topLimited || scan.duplicateVisibleKeyDetected) {
      console.warn(JSON.stringify({ event: "post_create_poll", poll_at: new Date().toISOString(),
        outcome: "inventory_not_ready", top_limited: Boolean(scan.topLimited),
        duplicate_visible_key_detected: Boolean(scan.duplicateVisibleKeyDetected),
        visible_item_count: (scan.items || scan.topItems || []).length,
        reason: !scan.topLimited ? "top_row_snapshot_not_complete" : "duplicate_visible_identity" }));
      await page.waitForTimeout(500);
      continue;
    }
    // Do not open a generating tile to resolve its UUID: its thumbnail/token can
    // rotate while rendering. Wait until Flow exposes a media UUID in DOM/network
    // metadata, then identify the new result strictly by set difference vs baseline.
    const topItemsNow = (scan.items || scan.topItems || []).map(item => ({
      ...item,
      // Reconstruct the exact baseline key for old explicit policy-refusal cards.
      key: failedPolicyBaselineKey(item) || item.key || "",
    }));
    const baselineKeys = new Set(beforeKeys || []);
    const baselineKeyCounts = new Map();
    for (const key of beforeKeys || []) baselineKeyCounts.set(key, (baselineKeyCounts.get(key) || 0) + 1);
    const newUuidItems = topItemsNow.filter(item => item?.mediaUuid && item.key && !baselineKeys.has(item.key));
    if (newUuidItems.length > 0) onSubmissionEvidence({ kind: "new_media_uuid", keys: newUuidItems.map(item => item.key) });
    const newItems = findNewCompletedMediaItems(topItemsNow, beforeKeys);
    // Failed cards may have no UUID and generic action links. Use cleaned tile-local
    // text as identity and occurrence counts so duplicate failures remain detectable.
    const newFailedTile = topItemsNow.find(item => {
      if (!item?.key) return false;
      const state = `${item.state || ""} ${item.text || ""}`;
      if (!(/\bfailed\b/i.test(state) || isGenerationFailureText(state))) return false;
      const occurrence = topItemsNow.slice(0, item.index + 1).filter(candidate => candidate?.key === item.key).length;
      return occurrence > (baselineKeyCounts.get(item.key) || 0);
    });
    if (newFailedTile) {
      const failureText = `${newFailedTile.text || ""} ${newFailedTile.state || ""}`.replace(/\s+/g, " ").trim();
      const failureReason = /prominent people|might violate our policies|you will be refunded/i.test(failureText)
        ? "policy_prominent_people" : "provider_generation_failed";
      throw new Error(`FLOW_GENERATION_FAILED: ${failureReason}: new Flow tile at position ${newFailedTile.index} [${newFailedTile.key}] reports failure: ${failureText}`);
    }
    // UUID-backed failures remain covered by this check; no failed item is eligible
    // for download even if Flow exposes it as a completed media record.
    let candidateItems = newItems.filter(item =>
      !(/\bfailed\b/i.test(`${item.state} ${item.text}`) || isGenerationFailureText(`${item.state} ${item.text}`)));
    // Fallback for Flow builds where the newly completed first tile exposes only
    // /image/<uuid> and no video UUID until its editor is opened. Infer insertion
    // only when the next two visible tiles match the first two pre-Create UUIDs
    // in order; position alone is never sufficient.
    if (candidateItems.length === 0 && topItemsNow.length >= 4) {
      const [first, ...shiftedItems] = topItemsNow;
      const shiftedBaselineConfirmed = orderedBaselineShiftIsVerified(first, shiftedItems, beforeKeys);
      if (shiftedBaselineConfirmed) {
        candidateItems = [{ ...first, inferredNewTile: true }];
        console.log(JSON.stringify({ event: "post_create_new_first_tile_inferred",
          method: "ordered_baseline_shift_with_non_media_baseline_support",
          first_tile_key: first.key || null,
          confirmed_baseline_keys: shiftedItems.slice(0, 3).map(item => item.key || null) }));
      }
    }
    const pollCandidates = candidateItems.map(item => ({
      index: item.index, key: item.key || null, media_uuid: item.mediaUuid || null,
      inferred_new_tile: Boolean(item.inferredNewTile),
    }));
    const pollRejectReasons = [];
    if (newUuidItems.length === 0 && candidateItems.length === 0) {
      pollRejectReasons.push(topItemsNow.length < 4 ? "insufficient_top_row_for_three_identity_shift_check"
        : "no_new_uuid_or_verified_ordered_baseline_shift");
    }
    if (candidateItems.length > 1) pollRejectReasons.push("multiple_new_candidates_ambiguous");
    console.log(JSON.stringify({ event: "post_create_poll", poll_at: new Date().toISOString(),
      outcome: candidateItems.length === 1 ? "candidate_found" : candidateItems.length > 1 ? "ambiguous_candidates" : "no_candidate",
      baseline_keys_first_three: (beforeKeys || []).slice(0, 3),
      top_row: topItemsNow.slice(0, 4).map(item => ({
        index: item.index, key: item.key || null, media_uuid: item.mediaUuid || null,
        state: String(item.state || "").slice(0, 100), text: String(item.text || "").replace(/\s+/g, " ").slice(0, 120),
        progress: Boolean(item.progress),
      })),
      candidates: pollCandidates, reject_reasons: pollRejectReasons }));
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
      const located = await collectAllGeneratedItems(page, selectors.generated_video_items, { targetKey: newKey, topLimit: 3, selectors, skipUuidResolution: true }).catch(() => ({ targetIndex: null }));
      if (located.targetIndex !== null) {
        newItem = itemLocator.nth(located.targetIndex);
        await newItem.click({ timeout: 5000 });
        if (candidate.inferredNewTile) {
          const editRoute = /\/edit\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
          await page.waitForURL(url => editRoute.test(new URL(url).pathname), { timeout: 8000 }).catch(() => {});
          const openedUrl = page.url();
          const openedUuid = openedUrl.match(editRoute)?.[1]?.toLowerCase() || null;
          const openedKey = openedUuid ? `media:${openedUuid}` : null;
          if (!openedKey || baselineKeys.has(openedKey)) {
            throw new Error(`FLOW_SUBMITTED_UNIDENTIFIED: New first-row tile was inferred from shifted neighbors, but opening it did not yield a verified non-baseline /edit/<uuid> URL (url=${openedUrl}). Do not retry automatically.`);
          }
          newKey = openedKey;
          onSubmissionEvidence({ kind: "ordered_baseline_shift_and_detail_uuid", media_uuid: openedUuid });
          console.log(JSON.stringify({ event: "post_create_new_first_tile_verified",
            media_uuid: openedUuid, url: openedUrl, method: "edit_route_after_ordered_baseline_shift" }));
        } else {
          const candidateUuid = candidate.mediaUuid || String(candidate.key || "").match(/^media:([0-9a-f-]{36})$/i)?.[1] || null;
          await page.waitForURL(url => /\/(?:edit|video)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)/i.test(new URL(url).pathname), { timeout: 8000 }).catch(() => {});
          const openedUrl = page.url();
          if (!openedMediaUuidMatches(candidateUuid, openedUrl, beforeKeys)) {
            throw new Error(`FLOW_SUBMITTED_UNIDENTIFIED: Opened detail route did not match the newly detected candidate media UUID (candidate=${candidateUuid || "missing"}, url=${openedUrl}). Refusing to download any media from this route; do not retry automatically.`);
          }
          console.log(JSON.stringify({ event: "post_create_opened_media_uuid_verified",
            candidate_media_uuid: candidateUuid.toLowerCase(), url: openedUrl,
            verification: "candidate_uuid_matches_opened_detail_route" }));
        }
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
                    deadline = Date.now() + 30000;
                    newItem = null;
                    newKey = null;
                    console.warn(`Flow credit balance decreased (${beforeBalance} -> ${currentBalance}) but Download media is not ready; extending result polling by 30000ms without resubmitting.`);
                    break;
                  }
                }
                await captureTimeout();
                throw new Error("FLOW_SUBMITTED_UNIDENTIFIED: New video detail opened, but generation did not expose Download media before the wait deadline.");
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
    throw new Error(`FLOW_SUBMITTED_UNIDENTIFIED: No verified new video UUID/detail/download became available within ${timeoutMs}ms. Completion remains unverified; do not retry automatically.`);
  }
  const remainingMs = Math.max(1000, deadline - Date.now());
  const downloadButtonLocator = page.locator(selectors.download_media_button);
  try { await downloadButtonLocator.waitFor({ state: "visible", timeout: remainingMs }); }
  catch {
    await failIfVisible();
    await captureTimeout();
    throw new Error("FLOW_SUBMITTED_UNIDENTIFIED: A new tile was opened but Download media did not become visible before the wait deadline; completion remains unverified.");
  }
  const downloadButton = await exactVisibleLocator(page, selectors.download_media_button, "Download media button");
  const mediaUri = page.url();
  try {
    await downloadButton.click({ timeout: 5000 });
    const qualityLocator = page.getByRole("menuitem", { name: /Original size/i }).filter({ hasNotText: /Upscaled/i });
    await qualityLocator.first().waitFor({ state: "visible", timeout: 10000 });
    const visibleOriginalOptions = [];
    const optionCount = await qualityLocator.count();
    for (let i = 0; i < optionCount; i += 1) {
      const option = qualityLocator.nth(i);
      if (await option.isVisible().catch(() => false)) visibleOriginalOptions.push(option);
    }
    if (visibleOriginalOptions.length !== 1) {
      throw new Error(`Expected exactly one visible non-upscaled Original size download option, found ${visibleOriginalOptions.length}; refusing ambiguous download choice.`);
    }
    const quality = visibleOriginalOptions[0];
    const selectedDownloadLabel = (await quality.innerText().catch(() => "Original size")).replace(/\s+/g, " ").trim();
    console.log(JSON.stringify({ event: "download_quality_option_selected", label: selectedDownloadLabel }));
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
    const actualResolution = readMp4VideoResolution(target);
    console.log(JSON.stringify({ event: "downloaded_media_metadata", file: target, selected_download_label: selectedDownloadLabel,
      actual_resolution: actualResolution?.label || null, codec: actualResolution?.codec || null, bytes: fs.statSync(target).size }));
    return { downloadedFile: target, mediaUri, downloadError: null,
      actualResolution: actualResolution?.label || null, downloadQualityLabel: selectedDownloadLabel,
      verifiedMediaUuid: String(newKey).replace(/^media:/i, "").toLowerCase(),
      verificationState: "verified_new_media_uuid",
      verificationEvidence: "new_media_uuid_set_difference_or_ordered_baseline_shift_plus_matching_detail_route" };
  } catch (error) {
    return { downloadedFile: null, mediaUri, downloadError: String(error.message || error),
      actualResolution: null, downloadQualityLabel: null,
      verifiedMediaUuid: String(newKey).replace(/^media:/i, "").toLowerCase(),
      verificationState: "verified_new_media_uuid",
      verificationEvidence: "new_media_uuid_set_difference_or_ordered_baseline_shift_plus_matching_detail_route" };
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
  const containerSelector = '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane';
  const hasVisiblePickerSurface = async () => page.locator(containerSelector).evaluateAll((containers, args) =>
    containers.some(container => {
      const visible = node => {
        if (!node || !node.isConnected) return false;
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden"
          && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      };
      if (!visible(container)) return false;
      return Array.from(container.querySelectorAll(args.tileSelector)).some(visible)
        || (args.addToPromptSelector && Array.from(container.querySelectorAll(args.addToPromptSelector)).some(visible));
    }), { tileSelector: selectors.ingredient_library_item, addToPromptSelector: selectors.ingredient_add_to_prompt }).catch(() => false);
  const hasVisibleBackdrop = async () => page.locator(backdropSelector).evaluateAll(nodes =>
    nodes.some(node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return node.isConnected && style.display !== "none" && style.visibility !== "hidden"
        && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    })).catch(() => false);
  // Escape first so the active, possibly rebuilt overlay gets the close action.
  await page.keyboard.press("Escape").catch(() => {});
  const escapeDeadline = Date.now() + 1800;
  while (Date.now() < escapeDeadline && (await hasVisiblePickerSurface() || await hasVisibleBackdrop())) {
    await page.waitForTimeout(100);
  }
  if (await hasVisiblePickerSurface() || await hasVisibleBackdrop()) {
    // Re-query the current backdrop after Escape; never retain a locator to an old overlay.
    const backdrops = page.locator(backdropSelector);
    const count = await backdrops.count().catch(() => 0);
    let clicked = false;
    for (let i = count - 1; i >= 0; i -= 1) {
      const backdrop = backdrops.nth(i);
      if (!(await backdrop.isVisible().catch(() => false))) continue;
      const bounds = await backdrop.boundingBox().catch(() => null);
      if (!bounds) continue;
      await backdrop.click({ position: { x: 5, y: 5 }, timeout: 2500, force: true }).catch(() => {});
      clicked = true;
      break;
    }
    if (!clicked && await hasVisiblePickerSurface()) {
      throw new Error("Ingredients picker is still visible, but no current visible backdrop could be resolved for closure.");
    }
  }
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline && (await hasVisiblePickerSurface() || await hasVisibleBackdrop())) {
    await page.waitForTimeout(100);
  }
  if (await hasVisiblePickerSurface() || await hasVisibleBackdrop()) {
    throw new Error("Ingredients picker closure verification failed; a current picker surface or backdrop remains visible.");
  }
}
async function resetIngredientsPicker(page, selectors) {
  const containerSelector = '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane';
  // A detail/preview pane may remain mounted after its library tiles disappear.
  // Treat either visible library tiles or a visible Add-to-prompt action as an open picker.
  const hasVisiblePickerSurface = async () => page.locator(containerSelector).evaluateAll((containers, args) =>
    containers.some(container => {
      const visible = node => {
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        return node.isConnected && style.display !== "none" && style.visibility !== "hidden"
          && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      };
      if (!visible(container)) return false;
      return Array.from(container.querySelectorAll(args.tileSelector)).some(visible)
        || (args.addToPromptSelector && Array.from(container.querySelectorAll(args.addToPromptSelector)).some(visible));
    }), { tileSelector: selectors.ingredient_library_item, addToPromptSelector: selectors.ingredient_add_to_prompt }).catch(() => false);
  if (!(await hasVisiblePickerSurface())) return;
  await page.keyboard.press("Escape").catch(() => {});
  const escapeDeadline = Date.now() + 1800;
  while (Date.now() < escapeDeadline && await hasVisiblePickerSurface()) await page.waitForTimeout(100);
  if (await hasVisiblePickerSurface()) await closeIngredientsPicker(page, selectors);
  const deadline = Date.now() + 3500;
  while (Date.now() < deadline && await hasVisiblePickerSurface()) await page.waitForTimeout(100);
  if (await hasVisiblePickerSurface()) {
    throw new Error("Ingredients picker/detail pane did not fully close after Escape/backdrop close; refusing to reuse a stale preview/Add to prompt action.");
  }
  console.log(JSON.stringify({ event: "ingredients_picker_reset_verified", closed: true, detail_pane_checked: true }));
}

async function inspectAddToPromptContext(button) {
  return button.evaluate(buttonNode => {
    const visible = node => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      return node.isConnected && style.display !== "none" && style.visibility !== "hidden"
        && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
    };
    const contexts = [];
    let node = buttonNode;
    for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
      const elements = [node, ...Array.from(node.querySelectorAll("*"))];
      const images = elements.filter(el => /^(IMG|VIDEO)$/.test(el.tagName) || el.matches("[style*='background-image']"))
        .filter(visible);
      const values = [];
      const imageSources = [];
      for (const el of elements) {
        for (const attr of Array.from(el.attributes || [])) {
          values.push(attr.value);
          if (/^(src|data-src|data-original|data-media-id|data-asset-id|aria-label|alt|title)$/i.test(attr.name)) {
            imageSources.push({ tag: el.tagName.toLowerCase(), attr: attr.name, value: String(attr.value).slice(0, 240) });
          }
        }
        if (el.tagName === "IMG") {
          values.push(el.currentSrc, el.src, el.alt, el.title);
          imageSources.push({ tag: "img", attr: "currentSrc", value: String(el.currentSrc || "").slice(0, 240) });
        }
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== "none") { values.push(bg); imageSources.push({ tag: el.tagName.toLowerCase(), attr: "background-image", value: bg.slice(0, 240) }); }
        values.push(el.innerText || el.textContent || "");
      }
      const uuids = Array.from(new Set(values.flatMap(value => String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig) || []).map(v => v.toLowerCase())));
      const previewLabels = Array.from(new Set(values.flatMap(value => {
        const match = String(value || "").match(/Preview of\s+(.+?\.(?:png|jpe?g|webp|gif|avif))/i);
        return match ? [match[1].trim().replace(/["'”’]+$/, "")] : [];
      })));
      const text = String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim();
      contexts.push({
        depth, visible_image_count: images.length, uuids, preview_labels: previewLabels,
        labels: Array.from(new Set(values.filter(v => /mai-face|ref-3|\.png|\.jpe?g/i.test(String(v || ""))).map(v => String(v).slice(0, 180)))).slice(0, 12),
        image_sources: imageSources.slice(0, 12), context_tag: node.tagName.toLowerCase(),
        context_role: node.getAttribute("role"), context_text: text.slice(0, 260)
      });
      // Prefer the actual preview's explicit filename, not a broad ancestor containing
      // the picker navigation and stale card thumbnails.
      if (previewLabels.length) return contexts[contexts.length - 1];
    }
    return contexts.sort((a, b) => {
      const score = c => (c.uuids.length ? 4 : 0) + (c.labels.length ? 2 : 0) + (c.visible_image_count ? 1 : 0);
      return score(b) - score(a) || a.depth - b.depth;
    })[0] || { depth: null, visible_image_count: 0, uuids: [], preview_labels: [], labels: [], image_sources: [], context_tag: null, context_role: null, context_text: "" };
  }).catch(error => ({ error: error.message, depth: null, visible_image_count: 0, uuids: [], preview_labels: [], labels: [], image_sources: [] }));
}

function isElementActuallyVisible(element) {
  if (!element || !element.isConnected) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden"
    && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
}

async function countVisibleMatches(page, selector) {
  return page.locator(selector).evaluateAll(nodes => nodes.filter(element => {
    if (!element.isConnected) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden"
      && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  }).length).catch(() => -1);
}

async function waitForStableVisibleChipCount(page, selector, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stableSince = Date.now();
  let current = -1;
  while (Date.now() < deadline) {
    current = await countVisibleMatches(page, selector);
    if (current === previous) {
      if (Date.now() - stableSince >= 300) return current;
    } else {
      previous = current;
      stableSince = Date.now();
    }
    await page.waitForTimeout(100);
  }
  return current;
}

async function resolveVisibleIngredientsPicker(page, selectors, filename, filenameStem) {
  const containerSelector = '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane';
  const containers = page.locator(containerSelector);
  const candidates = [];
  const count = await containers.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const container = containers.nth(i);
    if (!(await container.isVisible().catch(() => false))) continue;
    const tiles = container.locator(`${selectors.ingredient_library_item}:visible`);
    const tileCount = await tiles.count().catch(() => 0);
    if (!tileCount) continue;
    let exact = tiles.filter({ hasText: filename });
    let matching = exact;
    if (await matching.count().catch(() => 0) === 0 && filenameStem !== filename) {
      matching = tiles.filter({ hasText: filenameStem });
    }
    let visibleMatches = 0;
    const diagnostics = [];
    const matchCount = await matching.count().catch(() => 0);
    for (let j = 0; j < matchCount; j += 1) {
      const tile = matching.nth(j);
      const visible = await tile.isVisible().catch(() => false);
      if (visible) visibleMatches += 1;
      const box = visible ? await tile.boundingBox().catch(() => null) : null;
      diagnostics.push({
        index: j, visible, aria_selected: await tile.getAttribute("aria-selected").catch(() => null),
        box: box ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } : null,
        text: (await tile.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 140),
      });
    }
    candidates.push({ container, matching, tileCount, visibleMatches, diagnostics });
  }
  candidates.sort((a, b) => b.visibleMatches - a.visibleMatches);
  const chosen = candidates[0];
  console.log(JSON.stringify({
    event: "ingredients_picker_scoped_inventory", filename,
    candidate_containers: candidates.length,
    candidates: candidates.map(c => ({ tile_count: c.tileCount, visible_matching_tiles: c.visibleMatches, tiles: c.diagnostics })),
  }));
  if (!chosen) {
    throw new Error(`Could not find a visible Ingredients picker/dialog containing library tiles for ${filename}; refusing to click a same-name tile elsewhere on the page.`);
  }
  return { container: chosen.container, matching: chosen.matching, visibleMatches: chosen.visibleMatches };
}

async function clearPromptContentsVerified(prompt, selectors, timeout = 2500) {
  const page = prompt.page();
  const initialHandle = await prompt.elementHandle();
  if (!initialHandle) throw new Error("Prompt textbox disappeared before empty-state verification.");
  const initialValue = await initialHandle.evaluate(element => ("value" in element) ? element.value : (element.innerText || element.textContent || ""));
  let initialChipCount = await waitForStableVisibleChipCount(page, selectors.ingredient_reference_items, 2000);
  if (String(initialValue).trim() === "" && initialChipCount === 0) return;
  const clearButton = await exactVisibleLocator(page, selectors.clear_prompt, "Clear prompt button");
  try {
    await clearButton.click({ timeout: 2500 });
  } catch (clickError) {
    // A timeout can be reported after Flow already handled the click during an animation.
    await page.waitForTimeout(250);
    const afterClickHandle = await prompt.elementHandle();
    const afterClickValue = afterClickHandle
      ? await afterClickHandle.evaluate(element => ("value" in element) ? element.value : (element.innerText || element.textContent || ""))
      : "__PROMPT_MISSING__";
    const afterClickChips = await waitForStableVisibleChipCount(page, selectors.ingredient_reference_items, 2000);
    if (String(afterClickValue).trim() !== "" || afterClickChips !== 0) {
      throw new Error(`Clear prompt click did not complete and visible state is not empty (prompt=${JSON.stringify(String(afterClickValue).trim())}, visible_chips=${afterClickChips}): ${clickError.message}`);
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

  // Flow may leave stale, hidden chip nodes mounted during the picker/prompt transition.
  // Count only visible chips and wait for the count to settle before reporting cleanup failure.
  let chipCount = await waitForStableVisibleChipCount(page, selectors.ingredient_reference_items, 2000);
  while (chipCount > 0) {
    const allChips = page.locator(selectors.ingredient_reference_items);
    let chip = null;
    for (let i = (await allChips.count().catch(() => 0)) - 1; i >= 0; i -= 1) {
      const candidate = allChips.nth(i);
      if (await candidate.isVisible().catch(() => false)) { chip = candidate; break; }
    }
    if (!chip) {
      chipCount = await waitForStableVisibleChipCount(page, selectors.ingredient_reference_items, 2000);
      if (chipCount === 0) break;
      throw new Error(`Visible Ingredients chip count is ${chipCount}, but no visible chip element could be located for cleanup.`);
    }
    const remove = chip.locator('button[aria-label*="remove" i], button[aria-label*="delete" i], button[aria-label*="close" i], button[title*="remove" i], button[title*="delete" i], [role="button"][aria-label*="remove" i], [role="button"][aria-label*="delete" i]').first();
    if (await remove.count().catch(() => 0) === 0 || !(await remove.isVisible().catch(() => false))) {
      throw new Error(`Clear prompt removed text but left ${chipCount} visible Ingredients chip(s), and no verified visible remove control was found. Remove chips manually before continuing.`);
    }
    let removeClickError = null;
    try { await remove.click({ timeout: 1500 }); } catch (error) { removeClickError = error; }
    const deadline = Date.now() + Math.max(timeout, 3000);
    let nextCount = chipCount;
    while (Date.now() < deadline) {
      nextCount = await countVisibleMatches(page, selectors.ingredient_reference_items);
      if (nextCount >= 0 && nextCount < chipCount) break;
      await page.waitForTimeout(100);
    }
    if (!(nextCount >= 0 && nextCount < chipCount)) {
      const stableCount = await waitForStableVisibleChipCount(page, selectors.ingredient_reference_items, 1000);
      if (!(stableCount >= 0 && stableCount < chipCount)) {
        throw new Error(`Visible Ingredients chip count did not decrease from ${chipCount}${removeClickError ? ` after remove click timeout: ${removeClickError.message}` : ""}; stop and inspect Flow manually.`);
      }
      nextCount = stableCount;
    }
    chipCount = await waitForStableVisibleChipCount(page, selectors.ingredient_reference_items, 2000);
  }
  if (chipCount !== 0) throw new Error(`Clear prompt verification failed; ${chipCount} visible Ingredients chip(s) remain after the DOM settled.`);
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
      let session = null;
      try {
        session = await item.page.context().newCDPSession(item.page);
        const contexts = [];
        session.on("Runtime.executionContextCreated", event => {
          const context = event.context || {};
          const auxData = context.auxData || {};
          contexts.push({
            id: context.id,
            name: context.name || "",
            origin: context.origin || "",
            isDefault: auxData.isDefault === true,
            frameId: auxData.frameId || null,
          });
        });
        await session.send("Runtime.enable");
        await item.page.waitForTimeout(250);
        const nonDefault = contexts.filter(context => !context.isDefault);
        const playwrightUtilityWorlds = nonDefault.filter(context => /^__playwright_utility_world(?:_|$)/i.test(context.name));
        const noteworthyWorlds = nonDefault.filter(context => !playwrightUtilityWorlds.includes(context));
        const extensionWorlds = noteworthyWorlds.filter(context => /^chrome-extension:\/\//i.test(context.origin));
        if (playwrightUtilityWorlds.length) {
          console.log(`    Playwright utility worlds (informational, excluded from warnings): ${playwrightUtilityWorlds.length}`);
        }
        if (noteworthyWorlds.length) {
          console.warn("    WARNING: non-default JavaScript execution contexts other than Playwright utility worlds are present on this Flow tab; inspect extensions or injected scripts before running. This is a diagnostic signal, not proof of the cause.");
          console.log("    noteworthy non-default execution contexts:", JSON.stringify(noteworthyWorlds));
        } else {
          console.log("    execution contexts: only default contexts and/or known Playwright utility worlds observed during inspection.");
        }
        if (extensionWorlds.length) {
          console.warn("    WARNING: extension-origin execution contexts detected on the Flow tab:", JSON.stringify(extensionWorlds));
        }
      } catch (error) {
        console.warn(`    execution-context inspection unavailable: ${error.message}`);
      } finally {
        if (session) await session.detach().catch(() => {});
      }
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
  const readChecked = async () => locator.getAttribute("aria-checked").catch(() => null);
  let checked = await readChecked();
  if (checked !== "true") {
    await locator.click({ timeout: 2500 });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      checked = await readChecked();
      if (checked === "true") return;
      await page.waitForTimeout(150);
    }
    throw new Error(`Could not verify ${label}=${value} after 3000ms polling; aria-checked is ${JSON.stringify(checked)}. Stopping safely.`);
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
  const source = String(value || "");
  const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  // Prefer the UUID attached to an actual media route. Flow URLs can include
  // /project/<project UUID>/edit/<media UUID>; returning the first UUID would
  // incorrectly identify the project itself as the generated asset.
  const routeMatch = source.match(new RegExp("\\/(?:video|edit)\\/(" + uuidPattern + ")(?:[/?#]|$)", "i"));
  if (routeMatch) return routeMatch[1].toLowerCase();

  const matches = Array.from(source.matchAll(new RegExp(uuidPattern, "ig")));
  if (!matches.length) return null;
  // If this is a project URL, exclude the UUID belonging to /project/<id>.
  const projectMatch = source.match(new RegExp("\\/project\\/(" + uuidPattern + ")(?:[/?#]|$)", "i"));
  const projectUuid = projectMatch?.[1]?.toLowerCase() || null;
  const assetMatch = matches.find(match => match[0].toLowerCase() !== projectUuid);
  return assetMatch?.[0]?.toLowerCase() || null;
}

function applyVerifiedRowUuidFallback(initialItems, refreshedItems, baselineTexts, refreshedTexts) {
  const verifiedIndexes = new Set();
  if (!Array.isArray(initialItems) || !Array.isArray(refreshedItems)
    || initialItems.length < 3 || initialItems.length !== refreshedItems.length) return verifiedIndexes;
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const initialLabels = (baselineTexts || []).map(normalize);
  const refreshedLabels = (refreshedTexts || []).map(normalize);
  const counts = values => {
    const result = new Map();
    for (const value of values) result.set(value, (result.get(value) || 0) + 1);
    return result;
  };
  const initialCounts = counts(initialLabels);
  const refreshedCounts = counts(refreshedLabels);
  const initialUuids = initialItems.map(item => item?.mediaUuid);
  const refreshedUuids = refreshedItems.map(item => item?.mediaUuid);
  for (let index = 0; index < initialItems.length; index += 1) {
    const original = initialItems[index];
    const refreshed = refreshedItems[index];
    const uuid = refreshed?.mediaUuid;
    const text = initialLabels[index];
    const uniqueRefreshedUuid = Boolean(uuid && refreshedUuids.filter(value => value === uuid).length === 1);
    const uniqueInitialUuid = Boolean(original?.mediaUuid
      && initialUuids.filter(value => value === original.mediaUuid).length === 1);
    // Strongest case: the same unique video UUID is present at the same position
    // in both independently collected row inventories. Text may be empty or change
    // because Flow does not always expose a stable accessible title for fresh clips.
    if (uniqueInitialUuid && uniqueRefreshedUuid && original.mediaUuid === uuid) {
      verifiedIndexes.add(index);
      continue;
    }
    // If a baseline UUID exists but differs from the refreshed row, fail closed.
    if (original?.mediaUuid) continue;
    // Only inherit a newly resolved UUID when a unique text fingerprint matches
    // at the same position in both snapshots. Never replace a conflicting UUID.
    if (!uuid || !text || text !== refreshedLabels[index]
      || initialCounts.get(text) !== 1 || refreshedCounts.get(text) !== 1
      || !uniqueRefreshedUuid
      || initialUuids.some((value, otherIndex) => otherIndex !== index && value === uuid)) continue;
    original.mediaUuid = uuid;
    verifiedIndexes.add(index);
  }
  return verifiedIndexes;
}

function verifiedFirstRowIdentityIndexes(initialItems, refreshedItems) {
  if (!Array.isArray(initialItems) || !Array.isArray(refreshedItems)
    || initialItems.length < 3 || initialItems.length !== refreshedItems.length) return null;
  const normalize = value => String(value || "").replace(/\\s+/g, " ").trim();
  const mediaSet = items => {
    const entries = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item?.mediaUuid) entries.push({ index, uuid: String(item.mediaUuid).toLowerCase() });
      else if (!isKnownPolicyRefusalTile(item)) return null;
    }
    const uuids = entries.map(item => item.uuid);
    if (new Set(uuids).size !== uuids.length) return null;
    return entries;
  };
  const initialMedia = mediaSet(initialItems);
  const refreshedMedia = mediaSet(refreshedItems);
  if (!initialMedia || !refreshedMedia) return null;
  const initialUuids = new Set(initialMedia.map(item => item.uuid));
  const refreshedUuids = new Set(refreshedMedia.map(item => item.uuid));
  if (initialUuids.size !== refreshedUuids.size
    || [...initialUuids].some(uuid => !refreshedUuids.has(uuid))) return null;
  const refusalTexts = items => items.filter(item => !item?.mediaUuid)
    .map(item => normalize(item?.text)).filter(Boolean);
  const initialRefusals = refusalTexts(initialItems);
  const refreshedRefusals = refusalTexts(refreshedItems);
  if (initialRefusals.length !== refreshedRefusals.length
    || new Set(initialRefusals).size !== initialRefusals.length
    || new Set(refreshedRefusals).size !== refreshedRefusals.length
    || initialRefusals.some(text => !refreshedRefusals.includes(text))) return null;
  if (initialMedia.length + initialRefusals.length !== initialItems.length
    || refreshedMedia.length + refreshedRefusals.length !== refreshedItems.length) return null;
  // UUID membership, not row position or thumbnail URL shape, proves identity.
  return new Set(initialMedia.map(item => item.index));
}


function verifiedResolvedMediaWithRefusalFallback(initialItems, refreshedItems) {
  if (!Array.isArray(initialItems) || !Array.isArray(refreshedItems)
    || initialItems.length !== 3 || refreshedItems.length !== 3) return null;
  const normalize = value => String(value || "").replace(/\\s+/g, " ").trim();
  const refusals = items => items.filter(item => isKnownPolicyRefusalTile(item));
  const initialRefusals = refusals(initialItems);
  const refreshedRefusals = refusals(refreshedItems);
  if (initialRefusals.length !== 1 || refreshedRefusals.length !== 1
    || normalize(initialRefusals[0].text) !== normalize(refreshedRefusals[0].text)) return null;
  const media = refreshedItems.map((item, index) => ({ item, index }))
    .filter(({ item }) => !isKnownPolicyRefusalTile(item));
  if (media.length !== 2 || media.some(({ item }) => !item?.mediaUuid
    || item.key !== `media:${String(item.mediaUuid).toLowerCase()}`)) return null;
  const uuids = media.map(({ item }) => String(item.mediaUuid).toLowerCase());
  if (new Set(uuids).size !== 2) return null;
  // The full-row retry's per-tile resolver supplied both media UUIDs. A stale
  // thumbnail/network UUID in the earlier snapshot must not override this fresh
  // resolved row; the known refusal is keyed by its exact stable text.
  return new Set(media.map(({ index }) => index));
}

function buildVerifiedThumbnailBaselineTokens(domTokens, items, domTexts, verifiedUuidIndexes = new Set()) {
  const tokens = [...(domTokens || [])];
  const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
  const baselineTexts = (items || []).slice(0, 3).map(item => normalize(item?.text));
  const visibleTexts = (domTexts || []).map(normalize);
  const countText = (values, target) => values.filter(value => value && value === target).length;
  for (let index = 0; index < 3; index += 1) {
    const item = items?.[index];
    const uuid = item?.mediaUuid;
    const uniqueUuid = Boolean(uuid && items.filter(candidate => candidate?.mediaUuid === uuid).length === 1);
    const text = baselineTexts[index];
    const samePositionText = Boolean(text && text === visibleTexts[index]
      && countText(baselineTexts, text) === 1 && countText(visibleTexts, text) === 1);
    if (!uuid && isKnownPolicyRefusalTile(item) && text
      && countText(baselineTexts, text) === 1 && countText(visibleTexts, text) === 1) {
      // The refusal was independently confirmed as the same unique non-media
      // tile across full-row inventories; do not require it to remain at index 0.
      tokens[index] = failedPolicyBaselineKey(item);
      continue;
    }
    // Independently verified media UUIDs outrank /image/ and /video/ thumbnail
    // route IDs, which can refer to posters or appear in a different row position.
    if (uniqueUuid && verifiedUuidIndexes.has(index)) {
      tokens[index] = `media:${uuid.toLowerCase()}`;
      continue;
    }
    // Unverified UUIDs may only fill a missing/image placeholder when the row's
    // unique text fingerprint is unchanged at the same position.
    if (uniqueUuid && (!tokens[index] || /\/image\//i.test(String(tokens[index])))
      && samePositionText) tokens[index] = `media:${uuid.toLowerCase()}`;
  }
  return tokens;
}

function thumbnailIdentityToken(value) {
  const mediaUuidHint = arguments.length > 1 ? arguments[1] : null;
  const source = String(value || "").trim();
  if (mediaUuidHint) return `media:${String(mediaUuidHint).toLowerCase()}`;
  // These are already-normalized identity tokens, not URLs. Handle them before
  // URL parsing: new URL("asb:<token>", base).pathname drops the "asb:" prefix.
  if (/^asb:/i.test(source)) return normalizeAsbIdentityToken(source);
  if (/^media:/i.test(source)) return `media:${source.slice("media:".length).toLowerCase()}`;
  // /image/<uuid> is a thumbnail-image identifier, not reliable proof of the
  // underlying video UUID. Keep it as a thumbnail identity token only.
  if (/\/image\//i.test(source)) {
    try { return new URL(source, "https://flow.google.com").pathname; }
    catch { return source.split(/[?#]/, 1)[0]; }
  }
  const videoRouteUuid = source.match(/\/video\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i)?.[1];
  if (videoRouteUuid) return `media:${videoRouteUuid.toLowerCase()}`;
  const mediaUuid = assetUuidFromUrl(source);
  if (mediaUuid) return `media:${mediaUuid}`;
  const asbToken = source.match(/\/asb\/([^/?#]+)/i);
  if (asbToken) return normalizeAsbIdentityToken(`asb:${asbToken[1]}`);
  try { return new URL(source, "https://flow.google.com").pathname; }
  catch { return source.split(/[?#]/, 1)[0]; }
}

function mediaUuidFromLocatorValues(values) {
  // /image/<uuid> identifies a thumbnail asset, not the generated video.
  // Never let an image-only placeholder become the tile's media UUID; continue
  // searching for a real video/edit route or stable media attribute instead.
  for (const value of values || []) {
    const source = String(value || "");
    if (/\/image\//i.test(source)) continue;
    const uuid = assetUuidFromUrl(source);
    if (uuid) return uuid;
  }
  return null;
}

async function assetUuidFromLocator(locator, timeoutMs = 1200) {
  const lookupStartedAt = Date.now();
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
  }, undefined, { timeout: timeoutMs }).catch(error => {
    console.log(JSON.stringify({ event: "asset_uuid_dom_lookup_timing", elapsed_ms: Date.now() - lookupStartedAt,
      timeout_ms: timeoutMs, outcome: "failed", error: String(error?.message || error).slice(0, 240) }));
    return [];
  });
  const uuid = mediaUuidFromLocatorValues(values);
  if (uuid) {
    console.log(JSON.stringify({ event: "asset_uuid_dom_lookup_timing", elapsed_ms: Date.now() - lookupStartedAt,
      timeout_ms: timeoutMs, outcome: "resolved" }));
    return uuid;
  }
  if (values.length) console.log(JSON.stringify({ event: "asset_uuid_dom_lookup_timing", elapsed_ms: Date.now() - lookupStartedAt,
    timeout_ms: timeoutMs, outcome: "no_uuid_in_dom" }));
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
  const verificationStartedAt = Date.now();
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
  console.log(JSON.stringify({ event: "ingredient_chip_uuid_verification", expected_count: expectedUuids.length, elapsed_ms: Date.now() - verificationStartedAt, passed: true }));
  return actualUuids;
}

async function openIngredientsPicker(page, selectors, filename = "reference asset") {
  const pickerOpenStartedAt = Date.now();
  let addButton = await exactVisibleLocator(page, selectors.ingredient_add_button, "add ingredients button");
  // Trial clicks wait for a stable hit target without dispatching a real click.
  let lastError = null;
  let stable = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await addButton.waitFor({ state: "visible", timeout: 10000 });
      await addButton.click({ trial: true, timeout: 10000 });
      stable = true;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await page.waitForTimeout(350);
        const refreshed = await exactVisibleLocator(page, selectors.ingredient_add_button, "add ingredients button retry").catch(() => null);
        if (refreshed) addButton = refreshed;
      }
    }
  }
  if (!stable) throw new Error(`Add-ingredients button did not stabilize after retries: ${lastError?.message || lastError}`);
  // Confirm a scoped dialog/overlay contains visible library tiles; a global
  // ingredient_library_item match can accidentally resolve against stale UI.
  await addButton.click({ timeout: 10000 });
  const containerSelector = '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane';
  const deadline = Date.now() + 12000;
  let scopedTileCount = 0;
  while (Date.now() < deadline) {
    scopedTileCount = await page.locator(containerSelector).evaluateAll((containers, tileSelector) =>
      containers.reduce((sum, container) => {
        const style = getComputedStyle(container), rect = container.getBoundingClientRect();
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || 1) <= 0 || !rect.width || !rect.height) return sum;
        return sum + Array.from(container.querySelectorAll(tileSelector)).filter(tile => {
          const tileStyle = getComputedStyle(tile), tileRect = tile.getBoundingClientRect();
          return tileStyle.display !== "none" && tileStyle.visibility !== "hidden"
            && Number(tileStyle.opacity || 1) > 0 && tileRect.width > 0 && tileRect.height > 0;
        }).length;
      }, 0), selectors.ingredient_library_item).catch(() => 0);
    if (scopedTileCount > 0) {
      console.log(JSON.stringify({ event: "ingredients_picker_open_verified", scoped_visible_tiles: scopedTileCount, filename, elapsed_ms: Date.now() - pickerOpenStartedAt }));
      return;
    }
    await page.waitForTimeout(150);
  }
  throw new Error(`Ingredients picker did not expose visible library tiles inside a scoped dialog/overlay within 12000ms for ${filename}; scoped_visible_tiles=${scopedTileCount}.`);
}

async function uploadSceneReferencesUnsafe(page, selectors, referenceImages, referenceAssetUuids = new Map()) {
  const batchStartedAt = Date.now();
  console.log(JSON.stringify({ event: "reference_upload_batch_start", reference_count: referenceImages.length }));
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
    const referenceTiming = { reset_picker: null, open_picker: null, resolve_picker: null, inventory_and_identity: null,
      select_asset_and_attach_chip: null, close_picker_and_verify_chips: null };
    const logReferencePhase = (phase, startedAt, extra = {}) => {
      const elapsedMs = Date.now() - startedAt;
      referenceTiming[phase] = elapsedMs;
      console.log(JSON.stringify({ event: "reference_step_phase_timing", filename, phase, elapsed_ms: elapsedMs, total_elapsed_ms: Date.now() - assetStartedAt, ...extra }));
    };
    console.log(JSON.stringify({ event: "reference_step_start", filename, image_path: imagePath, at_ms: assetStartedAt }));
    console.log(`Reference upload started: ${filename}`);
    // Reset/unmount any previous picker before each asset so a stale preview action
    // cannot remain bound to the prior reference.
    let phaseStartedAt = Date.now();
    await resetIngredientsPicker(page, selectors);
    logReferencePhase("reset_picker", phaseStartedAt);
    const filenameStem = path.parse(filename).name;
    phaseStartedAt = Date.now();
    await openIngredientsPicker(page, selectors, filename);
    logReferencePhase("open_picker", phaseStartedAt);
    phaseStartedAt = Date.now();
    const pickerResolution = await resolveVisibleIngredientsPicker(page, selectors, filename, filenameStem);
    logReferencePhase("resolve_picker", phaseStartedAt);
    phaseStartedAt = Date.now();
    // Prefer the matching locator produced by the scoped inventory. If the picker
    // re-rendered between inventory and matching, re-resolve the visible dialog once
    // rather than silently converting a locator error into a misleading zero count.
    let pickerResolutionCurrent = pickerResolution;
    let pickerContainer = pickerResolutionCurrent.container;
    let picker = pickerContainer.locator(`${selectors.ingredient_library_item}:visible`);
    let matchingAssets = pickerResolutionCurrent.matching;
    const readMatchCount = async (stage) => {
      try {
        const count = await matchingAssets.count();
        console.log(JSON.stringify({ event: "ingredients_picker_match_count", filename, stage, count,
          container_visible: await pickerContainer.isVisible().catch(error => false),
          tile_count: await picker.count().catch(error => -1) }));
        return count;
      } catch (error) {
        console.warn(JSON.stringify({ event: "ingredients_picker_match_count_error", filename, stage,
          error: String(error?.message || error).slice(0, 500) }));
        return -1;
      }
    };
    let matchCount = await readMatchCount("inventory_locator_initial");
    if (matchCount <= 0) {
      const previousContainerVisible = await pickerContainer.isVisible().catch(() => false);
      const previousContainerTileCount = await picker.count().catch(() => -1);
      console.warn(JSON.stringify({ event: "ingredients_picker_re_resolve", filename,
        reason: "inventory_match_locator_empty_or_failed", previous_container_visible: previousContainerVisible,
        previous_container_tile_count: previousContainerTileCount }));
      pickerResolutionCurrent = await resolveVisibleIngredientsPicker(page, selectors, filename, filenameStem);
      pickerContainer = pickerResolutionCurrent.container;
      picker = pickerContainer.locator(`${selectors.ingredient_library_item}:visible`);
      matchingAssets = pickerResolutionCurrent.matching;
      matchCount = await readMatchCount("after_picker_re_resolve");
    }
    // Some Flow library cards display the filename without its extension. The scoped
    // inventory already tries the exact filename then stem; keep a fresh-locator
    // fallback for cases where the picker updated during its re-render.
    if (matchCount <= 0 && filenameStem !== filename) {
      matchingAssets = picker.filter({ hasText: filename });
      matchCount = await readMatchCount("fresh_exact_filename");
      if (matchCount <= 0) {
        matchingAssets = picker.filter({ hasText: filenameStem });
        matchCount = await readMatchCount("fresh_filename_stem");
      }
    }
    // If the picker list does not expose the target yet, use a visible search field
    // inside this picker only; never search or click a same-name tile elsewhere.
    if (matchCount <= 0) {
      const searchCandidates = pickerContainer.locator('input[type="search"], input[placeholder], input[aria-label]');
      const searchCount = await searchCandidates.count().catch(() => 0);
      let searchField = null;
      for (let i = 0; i < searchCount; i += 1) {
        const candidate = searchCandidates.nth(i);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const meta = [
          await candidate.getAttribute("placeholder").catch(() => ""),
          await candidate.getAttribute("aria-label").catch(() => ""),
          await candidate.getAttribute("type").catch(() => ""),
        ].join(" ").toLowerCase();
        if (/search|find|filter|library|media/.test(meta) || (searchCount === 1 && /^(search)?$/.test(meta.trim()))) {
          searchField = candidate;
          break;
        }
      }
      if (searchField) {
        await searchField.fill(filename, { timeout: 2000 }).catch(error => {
          console.warn(JSON.stringify({ event: "ingredients_picker_search_fill_error", filename,
            error: String(error?.message || error).slice(0, 400) }));
        });
        const searchDeadline = Date.now() + 2500;
        while (Date.now() < searchDeadline) {
          matchingAssets = picker.filter({ hasText: filename });
          matchCount = await matchingAssets.count().catch(() => 0);
          if (matchCount === 0 && filenameStem !== filename) {
            matchingAssets = picker.filter({ hasText: filenameStem });
            matchCount = await matchingAssets.count().catch(() => 0);
          }
          if (matchCount > 0) break;
          await page.waitForTimeout(150);
        }
        console.log(JSON.stringify({ event: "ingredients_picker_search_fallback", filename,
          search_field_used: true, visible_matching_tiles: matchCount }));
      } else {
        console.log(JSON.stringify({ event: "ingredients_picker_search_fallback", filename,
          search_field_used: false, visible_matching_tiles: 0 }));
      }
    }
    logReferencePhase("match_picker_tile_and_search", phaseStartedAt, { matching_asset_count: matchCount, search_fallback_considered: true });
    const inventoryStartedAt = Date.now();
    const existingUuids = new Set();
    const existingCount = await matchingAssets.count().catch(() => 0);
    // Flow lazily upgrades old thumbnail URLs from /asb/<token> to flow-content/image/<uuid>.
    // A unique same-name UUID in Flow's JSON is authoritative enough to skip that
    // slow thumbnail upgrade for a single card.
    const filenameNeedles = [filename.toLowerCase(), filenameStem.toLowerCase()];
    const networkNameUuids = Array.from(new Set(networkAssetRecords
      .filter(record => record.strings.some(value => filenameNeedles.some(needle => needle && value.includes(needle))))
      .map(record => record.uuid)));
    const requestedAssetUuid = referenceAssetUuids instanceof Map
      ? referenceAssetUuids.get(imagePath) : referenceAssetUuids?.[imagePath];
    // A job-pinned UUID found in Flow's JSON for this exact filename is stronger
    // evidence than unrelated same-name records in the response. This lets us skip
    // thumbnail polling even when the JSON also includes older duplicate entries.
    const pinnedUuidConfirmedByNetwork = Boolean(requestedAssetUuid && networkNameUuids.includes(requestedAssetUuid));
    const networkUuidShortcut = existingCount === 1
      && (networkNameUuids.length === 1 || pinnedUuidConfirmedByNetwork);
    if (networkUuidShortcut) existingUuids.add(pinnedUuidConfirmedByNetwork ? requestedAssetUuid : networkNameUuids[0]);
    // Only poll lazy thumbnail URLs when Flow JSON did not already identify the
    // unique existing card. This avoids a needless 6.75s wait per reference.
    // If the job explicitly pins a UUID and there is exactly one matching library card,
    // defer identity verification to the selected Ingredients chip. Avoid repeatedly
    // querying a lazy/stale thumbnail locator; chip UUID verification below is authoritative.
    const pinnedUniqueCardShortcut = Boolean(requestedAssetUuid && existingCount === 1);
    if (pinnedUniqueCardShortcut) existingUuids.add(requestedAssetUuid);
    const thumbnailDeadline = (networkUuidShortcut || pinnedUniqueCardShortcut) ? Date.now() : Date.now() + 7000;
    let thumbnailPolls = 0;
    do {
      if (!networkUuidShortcut && !pinnedUniqueCardShortcut) {
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
    let reusedExistingUuid = null;
    if (requestedAssetUuid) {
      // A single exact-name card is unambiguous by filename; verify the requested UUID
      // against the attached chip after selection instead of spending 1.2s on each DOM read.
      let requestedFound = false;
      if (existingCount !== 1) {
        for (let i = 0; i < existingCount; i += 1) {
          if (await assetUuidFromLocator(matchingAssets.nth(i)) === requestedAssetUuid) { requestedFound = true; break; }
        }
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
      if (existingCount > 0) throw new Error(`Found ${existingCount} existing Flow library asset(s) matching ${filename}, but could not read a stable UUID from their DOM attributes/URLs. Refusing to upload a duplicate; if this is the intended asset, add its verified UUID to reference_asset_uuids in the scene config, then rerun dry-run to verify the selected Ingredients chip UUID.`);
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
      let currentCount = 0;
      let stableUniqueCountReads = 0;
      let matchingLabels = [];
      let freshMatching = null;
      let refreshedPickerContainer = null;
      let reopenAttempted = false;
      let settleElapsedMs = 0;
      const inspectFreshPicker = async () => {
        // Read the whole visible picker inventory in one DOM round-trip. Repeated
        // Playwright count/visibility/text/attribute calls against Flow's rebuilt
        // overlay were taking tens of seconds per poll in some sessions.
        const scanStarted = Date.now();
        const snapshot = await page.evaluate(({ tileSelector, name, stem, pinnedUuid }) => {
          const visible = element => {
            const style = getComputedStyle(element), rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden"
              && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
          };
          const uuidFrom = value => String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]?.toLowerCase() || null;
          const overlays = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane'));
          let best = { containerIndex: -1, matches: [], visibleTileCount: 0 };
          overlays.forEach((overlay, containerIndex) => {
            if (!visible(overlay)) return;
            const tiles = Array.from(overlay.querySelectorAll(tileSelector)).filter(visible);
            const matching = tiles.filter(tile => {
              const text = String(tile.innerText || tile.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
              return text.includes(name.toLowerCase()) || (stem !== name && text.includes(stem.toLowerCase()));
            }).map((tile, index) => {
              const values = [];
              const add = node => {
                if (!node) return;
                for (const attr of ["href", "src", "id", "data-id", "data-uuid", "data-asset-id", "data-media-id", "aria-label", "title", "alt"]) {
                  const value = node.getAttribute?.(attr); if (value) values.push(value);
                }
              };
              add(tile);
              for (const node of [tile, ...tile.querySelectorAll("*")]) {
                add(node);
                for (const attr of Array.from(node.attributes || [])) values.push(attr.value);
              }
              const uuids = values.map(uuidFrom).filter(Boolean);
              const uniqueUuids = Array.from(new Set(uuids));
              return {
                index,
                label: String(tile.innerText || tile.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
                aria_label: tile.getAttribute("aria-label"),
                uuid: uniqueUuids.includes(pinnedUuid) ? pinnedUuid : (uniqueUuids[0] || null),
              };
            });
            if (matching.length > best.matches.length || best.containerIndex < 0) {
              best = { containerIndex, matches: matching, visibleTileCount: tiles.length };
            }
          });
          return { ...best, overlayCount: overlays.length };
        }, { tileSelector: selectors.ingredient_library_item, name: filename, stem: filenameStem, pinnedUuid: reusedExistingUuid });
        const elapsedMs = Date.now() - scanStarted;
        currentCount = snapshot.matches.length;
        matchingLabels = snapshot.matches;
        reuseIndex = snapshot.matches.findIndex(item => item.uuid === reusedExistingUuid);
        refreshedPickerContainer = snapshot.containerIndex >= 0
          ? page.locator('[role="dialog"], [aria-modal="true"], .cdk-overlay-pane').nth(snapshot.containerIndex)
          : null;
        const matchedByFullName = snapshot.matches.some(item => item.label.toLowerCase().includes(filename.toLowerCase()));
        freshMatching = snapshot.containerIndex >= 0
          ? refreshedPickerContainer.locator(selectors.ingredient_library_item + ':visible')
            .filter({ hasText: matchedByFullName ? filename : filenameStem })
          : null;
        // Use the exact observed matching index after the fast DOM scan. If the
        // picker matches the filename stem instead, the selection below falls back
        // to the unique matching tile rather than guessing among duplicate names.
        if (currentCount === 1 && reuseIndex < 0 && snapshot.matches[0]?.uuid === reusedExistingUuid) reuseIndex = 0;
        return { elapsedMs, overlayCount: snapshot.overlayCount, visibleTileCount: snapshot.visibleTileCount };
      };
      const settleFreshPicker = async (durationMs) => {
        const started = Date.now();
        const deadline = started + durationMs;
        let previousSignature = null;
        stableUniqueCountReads = 0;
        let slowestScanMs = 0;
        let polls = 0;
        while (Date.now() < deadline) {
          let scan = { elapsedMs: 0, overlayCount: 0, visibleTileCount: 0 };
          try { scan = await inspectFreshPicker(); }
          catch { currentCount = 0; matchingLabels = []; freshMatching = null; reuseIndex = -1; }
          polls += 1;
          slowestScanMs = Math.max(slowestScanMs, scan.elapsedMs || 0);
          const signature = currentCount === 1 ? JSON.stringify(matchingLabels.map(item => ({ label: item.label, uuid: item.uuid }))) : null;
          const exactFilenameMatch = currentCount === 1 && matchingLabels[0]?.label?.toLowerCase().includes(filename.toLowerCase());
          const identitySignalAvailable = reuseIndex >= 0 || exactFilenameMatch;
          if (currentCount === 1 && identitySignalAvailable && signature && signature === previousSignature) {
            stableUniqueCountReads += 1;
            if (stableUniqueCountReads >= 1) {
              const elapsedMs = Date.now() - started;
              console.log(JSON.stringify({ event: "asset_library_picker_settle_timing", filename, elapsed_ms: elapsedMs, polls, slowest_scan_ms: slowestScanMs, final_count: currentCount, uuid_match: reuseIndex >= 0, exact_filename_match: exactFilenameMatch, stable_unique_count_reads: stableUniqueCountReads, timeout: false }));
              return elapsedMs;
            }
          } else stableUniqueCountReads = 0;
          previousSignature = signature;
          await page.waitForTimeout(250);
        }
        const elapsedMs = Date.now() - started;
        console.log(JSON.stringify({ event: "asset_library_picker_settle_timing", filename, elapsed_ms: elapsedMs, polls, slowest_scan_ms: slowestScanMs, final_count: currentCount, uuid_match: reuseIndex >= 0, exact_filename_match: currentCount === 1 && Boolean(matchingLabels[0]?.label?.toLowerCase().includes(filename.toLowerCase())), stable_unique_count_reads: stableUniqueCountReads, timeout: true }));
        return elapsedMs;
      };
      settleElapsedMs += await settleFreshPicker(4500);
      if ((currentCount !== 1 || (reuseIndex < 0 && !matchingLabels[0]?.label?.toLowerCase().includes(filename.toLowerCase()))) && !reopenAttempted) {
        reopenAttempted = true;
        const reopenStartedAt = Date.now();
        console.warn(JSON.stringify({ event: "asset_library_reuse_picker_reopen", filename, pinned_uuid: reusedExistingUuid, reason: "fresh picker inventory did not settle to one exact matching tile", first_inventory_count: currentCount, first_inventory_uuid_match: reuseIndex >= 0, first_inventory_exact_filename_match: currentCount === 1 && Boolean(matchingLabels[0]?.label?.toLowerCase().includes(filename.toLowerCase())) }));
        await resetIngredientsPicker(page, selectors);
        await openIngredientsPicker(page, selectors, filename);
        settleElapsedMs += await settleFreshPicker(4500);
        console.log(JSON.stringify({ event: "asset_library_picker_reopen_timing", filename, elapsed_ms: Date.now() - reopenStartedAt, second_inventory_count: currentCount, second_inventory_uuid_match: reuseIndex >= 0 }));
      }
      console.log(JSON.stringify({ event: "asset_library_reuse_recheck", filename, pinned_uuid: reusedExistingUuid,
        currentCount, matching_labels: matchingLabels, stable_unique_count_reads: stableUniqueCountReads,
        fresh_container_resolved: Boolean(refreshedPickerContainer), reopen_attempted: reopenAttempted, settle_wait_ms: settleElapsedMs }));
      if (!freshMatching || currentCount !== 1 || (reuseIndex < 0 && !matchingLabels[0]?.label?.toLowerCase().includes(filename.toLowerCase()))) {
        throw new Error(`Reusable asset UUID ${reusedExistingUuid} is not readable from the refreshed picker; matching-name count did not settle to exactly one after fresh inventory${reopenAttempted ? " and one reopen" : ""}; currentCount=${currentCount}; matching_labels=${JSON.stringify(matchingLabels)}. Refusing to select an ambiguous item.`);
      }
      // A single exact-filename card may hide its UUID in the tile DOM; verify the pinned UUID against the attached chip after selection.
      asset = reuseIndex >= 0 ? freshMatching.nth(reuseIndex) : freshMatching.first();
    }
    const requestedAssetUuidForPin = requestedAssetUuid || null;
    const networkCandidates = networkAssetRecords.filter(record =>
      record.strings.some(value => value.includes(filename.toLowerCase()) || value.includes(filenameStem.toLowerCase()))
    );
    const networkUuids = Array.from(new Set(networkCandidates.map(record => record.uuid)));
    const uuidLookupStartedAt = Date.now();
    // A previously pinned/reused UUID is verified against the attached chip below.
    // Avoid querying a stale picker locator for up to Playwright's default 60s timeout.
    let assetUuid = reusedExistingUuid || await assetUuidFromLocator(asset, 1200);
    console.log(JSON.stringify({ event: "asset_uuid_resolution_timing", filename, elapsed_ms: Date.now() - uuidLookupStartedAt,
      reused_existing_uuid_shortcut: Boolean(reusedExistingUuid), dom_lookup_skipped: Boolean(reusedExistingUuid), resolved_from_dom_or_pin: Boolean(assetUuid) }));
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
    logReferencePhase("inventory_and_identity", inventoryStartedAt, { matching_asset_count: existingCount, reused_existing_uuid: Boolean(reusedExistingUuid), uuid_resolved: Boolean(assetUuid) });
    const selectionAndAttachStartedAt = Date.now();
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
    // Flow may render same-name library cards outside the picker; asset is deliberately
    // selected from the visible picker-scoped locator resolved above.
    const addToPromptSelector = selectors.ingredient_add_to_prompt;
    const addToPromptCandidates = pickerContainer.locator(addToPromptSelector);
    const selectionWaitStartedAt = Date.now();
    const selectionWaitTimeoutMs = 8000;
    const selectionDeadline = selectionWaitStartedAt + selectionWaitTimeoutMs;
    let selectedAssetAriaSelected = null;
    let addToPromptVisibleCount = 0;
    let referenceSelectionReady = false;
    let selectionRetried = false;
    let previewContext = null;
    let previewIdentitySignal = "unverified";
    const expectedPreviewUuid = (requestedAssetUuidForPin || assetUuid || "").toLowerCase();
    const targetFilename = filename.split(/[\\\\/]/).pop().toLowerCase();
    const pickerContainerSelector = '[role="dialog"], [aria-modal="true"], .cdk-overlay-pane';
    const readPickerDiagnostics = async (tileBox = null) => page.evaluate(({ containerSelector, tileSelector, filename, x, y }) => {
      const visible = node => {
        if (!node || !node.isConnected) return false;
        const style = getComputedStyle(node), rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
      };
      const containers = Array.from(document.querySelectorAll(containerSelector)).filter(visible);
      const tiles = containers.flatMap(container => Array.from(container.querySelectorAll(tileSelector)).filter(visible)
        .filter(tile => String(tile.innerText || tile.textContent || "").toLowerCase().includes(filename.toLowerCase())));
      const detailPanes = Array.from(document.querySelectorAll("flow-add-menu-detail-pane")).filter(visible);
      const paneNodes = Array.from(document.querySelectorAll("body *")).filter(visible);
      const previewNodes = paneNodes.filter(node => node.children.length < 8
        && /Preview of\s+.+\.(?:png|jpe?g|webp|gif|avif)/i.test(String(node.innerText || node.textContent || "")));
      const addNodes = paneNodes.filter(node => /add to prompt/i.test(String(node.innerText || node.getAttribute("aria-label") || ""))
        && /^(BUTTON|[A-Z0-9-]+)$/.test(node.tagName) && visible(node));
      const summarizeAncestors = node => {
        const out = [];
        for (let current = node, depth = 0; current && depth < 4; current = current.parentElement, depth += 1) {
          const text = String(current.innerText || current.textContent || "").replace(/\s+/g, " ").trim();
          const rect = current.getBoundingClientRect();
          out.push({ depth, tag: current.tagName.toLowerCase(), role: current.getAttribute("role"),
            class_name: String(current.className?.baseVal || current.className || "").slice(0, 100),
            box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
            has_preview_label: /Preview of\s+.+\.(?:png|jpe?g|webp|gif|avif)/i.test(text),
            has_add_button: Array.from(current.querySelectorAll("button,[role='button']")).some(el => visible(el)
              && /add to prompt/i.test(String(el.innerText || el.getAttribute("aria-label") || ""))),
            text: text.slice(0, 240) });
        }
        return out;
      };
      const pane = containers.map(container => {
        const text = String(container.innerText || "").replace(/\s+/g, " ").trim();
        return { role: container.getAttribute("role"), has_preview_label: /Preview of\s+.+\.(?:png|jpe?g|webp|gif|avif)/i.test(text),
          visible_add_button_count: Array.from(container.querySelectorAll("button,[role='button']")).filter(visible)
            .filter(el => /add to prompt/i.test(String(el.innerText || el.getAttribute("aria-label") || ""))).length,
          text: text.slice(0, 180) };
      });
      const hit = Number.isFinite(x) && Number.isFinite(y) ? document.elementFromPoint(x, y) : null;
      return {
        visible_picker_count: containers.length, matching_visible_tile_count: tiles.length,
        matching_tiles: tiles.slice(0, 4).map(tile => { const r = tile.getBoundingClientRect(); return {
          aria_selected: tile.getAttribute("aria-selected"),
          box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
          outer_html: tile.outerHTML.slice(0, 700),
          parent_html: tile.parentElement?.outerHTML.slice(0, 900) || "",
          grandparent_html: tile.parentElement?.parentElement?.outerHTML.slice(0, 1100) || "",
          selected_ancestors: [tile, tile.parentElement, tile.parentElement?.parentElement].filter(Boolean)
            .map(node => ({ tag: node.tagName.toLowerCase(), role: node.getAttribute("role"), aria_selected: node.getAttribute("aria-selected"), tabindex: node.getAttribute("tabindex") })),
          text: String(tile.innerText || tile.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120) }; }),
        detail_pane: detailPanes.map(node => ({ tag: node.tagName.toLowerCase(), text: String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240), preview_labels: Array.from(node.querySelectorAll("img[alt]")).map(img => img.getAttribute("alt")).filter(alt => /Preview of/i.test(alt || "")), image_sources: Array.from(node.querySelectorAll("img")).map(img => ({ src: img.getAttribute("src"), current_src: img.currentSrc, alt: img.getAttribute("alt") })).slice(0, 8), ancestors: summarizeAncestors(node) })),
        preview_nodes: previewNodes.slice(0, 3).map(node => ({ tag: node.tagName.toLowerCase(), text: String(node.innerText || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160) })),
        add_button_contexts: addNodes.slice(0, 3).map(node => ({ text: String(node.innerText || node.getAttribute("aria-label") || "").slice(0, 100), ancestors: summarizeAncestors(node) })),
        picker_container_diagnostics: pane,
        click_hit_inside_matching_tile: Boolean(hit && tiles.some(tile => tile === hit || tile.contains(hit))),
        click_hit_tag: hit?.tagName?.toLowerCase() || null,
        click_hit_text: String(hit?.innerText || hit?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100)
      };
    }, { containerSelector: pickerContainerSelector, tileSelector: selectors.ingredient_library_item, filename,
      x: tileBox ? tileBox.x + tileBox.width / 2 : null, y: tileBox ? tileBox.y + tileBox.height / 2 : null })
      .catch(error => ({ diagnostic_error: error.message }));
    const freshTile = async () => {
      const containers = page.locator(pickerContainerSelector);
      const containerCount = await containers.count().catch(() => 0);
      for (let i = 0; i < containerCount && Date.now() < selectionDeadline; i += 1) {
        const container = containers.nth(i);
        if (!(await container.isVisible({ timeout: 150 }).catch(() => false))) continue;
        const tiles = container.locator(`${selectors.ingredient_library_item}:visible`);
        let found = tiles.filter({ hasText: filename });
        if (await found.count().catch(() => 0) === 0 && filenameStem !== filename) found = tiles.filter({ hasText: filenameStem });
        if (await found.count().catch(() => 0) === 1 && await found.first().isVisible({ timeout: 150 }).catch(() => false)) return { container, tile: found.first() };
      }
      return null;
    };
    let activeAsset = asset;
    const initialAssetBox = await activeAsset.boundingBox({ timeout: 300 }).catch(() => null);
    console.log(JSON.stringify({
      event: "ingredients_picker_target_tile", filename,
      matching_tile_count: await matchingAssets.count().catch(() => 0),
      target_tile_box: initialAssetBox ? { x: Math.round(initialAssetBox.x), y: Math.round(initialAssetBox.y), width: Math.round(initialAssetBox.width), height: Math.round(initialAssetBox.height) } : null,
      target_tile_aria_selected_before_click: await activeAsset.getAttribute("aria-selected", { timeout: 300 }).catch(() => null),
      target_tile_text: (await activeAsset.innerText({ timeout: 300 }).catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 160),
    }));
    await activeAsset.scrollIntoViewIfNeeded({ timeout: 400 }).catch(() => {});
    let current = await freshTile();
    let targetPickerReopenAttempted = false;
    if (!current) {
      // A stale/ambiguous target and a picker that closed between inventory and
      // click get the same single safe recovery attempt. Reopen never clicks a tile
      // or Add: after reopening, require a unique filename match AND a pinned UUID.
      targetPickerReopenAttempted = true;
      const visiblePickerCount = await page.locator(pickerContainerSelector).evaluateAll(nodes =>
        nodes.filter(node => {
          const style = getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        }).length).catch(() => 0);
      console.warn(JSON.stringify({ event: "ingredients_picker_reopen_retry", filename,
        reason: visiblePickerCount === 0 ? "picker_closed_before_target_selection" : "target_tile_missing_or_ambiguous",
        visible_picker_count: visiblePickerCount, initial_matching_tile_count: matchCount,
        pinned_uuid: requestedAssetUuid || null }));
      await resetIngredientsPicker(page, selectors);
      await openIngredientsPicker(page, selectors, filename);
      pickerResolutionCurrent = await resolveVisibleIngredientsPicker(page, selectors, filename, filenameStem);
      pickerContainer = pickerResolutionCurrent.container;
      picker = pickerContainer.locator(`${selectors.ingredient_library_item}:visible`);
      matchingAssets = pickerResolutionCurrent.matching;
      const reopenedCount = await matchingAssets.count().catch(() => 0);
      const reopenedPickerVisible = await pickerContainer.isVisible().catch(() => false);
      console.log(JSON.stringify({ event: "ingredients_picker_reopen_retry_result", filename,
        matching_tile_count: reopenedCount, picker_visible: reopenedPickerVisible,
        pinned_uuid_required: true, pinned_uuid_available: Boolean(requestedAssetUuid) }));
      if (reopenedPickerVisible && reopenedCount === 1 && requestedAssetUuid) {
        activeAsset = matchingAssets.first();
        current = await freshTile();
      }
    }
    if (!current) {
      console.log(JSON.stringify({ event: "ingredients_picker_step_diagnostics", step: "before_initial_click", ...(await readPickerDiagnostics(initialAssetBox)) }));
      throw new Error(`Picker closed or target tile became ambiguous before selecting ${filename}${targetPickerReopenAttempted ? " even after one picker reopen" : ""}; stopping before Add/prompt fill/Create.`);
    }
    activeAsset = current.tile;
    const firstBox = await activeAsset.boundingBox({ timeout: 300 }).catch(() => null);
    if (firstBox) {
      const center = { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height / 2 };
      const targetMeta = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        const interactive = hit?.closest('[role="option"],[role="button"],button,[tabindex]');
        return { hit_tag: hit?.tagName?.toLowerCase() || null, hit_text: String(hit?.innerText || hit?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100),
          interactive_tag: interactive?.tagName?.toLowerCase() || null, interactive_role: interactive?.getAttribute("role") || null,
          interactive_tabindex: interactive?.getAttribute("tabindex") || null, interactive_text: String(interactive?.innerText || interactive?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 140),
          interactive_is_inside_tile: Boolean(interactive && hit && (interactive === hit || interactive.contains(hit))) };
      }, center).catch(() => ({}));
      console.log(JSON.stringify({ event: "ingredients_picker_click_target", step: "initial", filename, ...targetMeta }));
      const clickableAncestor = activeAsset.locator('xpath=ancestor-or-self::*[@role="option" or @role="button" or self::button or @tabindex][1]').first();
      const ancestorCount = await clickableAncestor.count().catch(() => 0);
      const initialActivationStartedAt = Date.now();
      if (ancestorCount === 1 && await clickableAncestor.isVisible({ timeout: 200 }).catch(() => false)) {
        const ancestorBox = await clickableAncestor.boundingBox({ timeout: 200 }).catch(() => null);
        if (ancestorBox) await clickableAncestor.click({ position: { x: Math.floor(ancestorBox.width / 2), y: Math.floor(ancestorBox.height / 2) }, timeout: 600 }).catch(() => {});
      } else {
        await activeAsset.click({ position: { x: Math.max(2, Math.floor(firstBox.width / 2)), y: Math.max(2, Math.floor(firstBox.height / 2)) }, timeout: 600 }).catch(() => {});
      }
      console.log(JSON.stringify({ event: "ingredients_picker_activation_timing", filename, step: "initial_click", elapsed_ms: Date.now() - initialActivationStartedAt, clicked_interactive_ancestor: ancestorCount === 1 }));
    }
    console.log(JSON.stringify({ event: "ingredients_picker_step_diagnostics", step: "after_initial_click", ...(await readPickerDiagnostics(firstBox)) }));
    while (Date.now() < selectionDeadline) {
      current = await freshTile();
      if (!current) {
        console.log(JSON.stringify({ event: "ingredients_picker_step_diagnostics", step: "target_missing_during_poll", ...(await readPickerDiagnostics()) }));
        break;
      }
      activeAsset = current.tile;
      selectedAssetAriaSelected = await activeAsset.getAttribute("aria-selected", { timeout: 200 }).catch(() => null);
      const addCandidates = current.container.locator(selectors.ingredient_add_to_prompt);
      const candidateCount = await addCandidates.count().catch(() => 0);
      addToPromptVisibleCount = 0;
      let visibleButton = null;
      for (let i = 0; i < candidateCount && Date.now() < selectionDeadline; i += 1) {
        if (await addCandidates.nth(i).isVisible({ timeout: 150 }).catch(() => false)) { addToPromptVisibleCount += 1; visibleButton = addCandidates.nth(i); }
      }
      previewContext = addToPromptVisibleCount === 1 && visibleButton ? await inspectAddToPromptContext(visibleButton) : null;
      if (previewContext) console.log(JSON.stringify({ event: "ingredients_picker_preview_context", filename,
        depth: previewContext.depth, context_tag: previewContext.context_tag, context_role: previewContext.context_role,
        context_text: previewContext.context_text, preview_labels: previewContext.preview_labels, uuids: previewContext.uuids,
        image_sources: previewContext.image_sources?.slice(0, 8) || [] }));
      const previewLabels = (previewContext?.preview_labels || []).map(label => String(label).trim().toLowerCase());
      const labelMatches = previewLabels.includes(targetFilename);
      const uuidMatches = Boolean(expectedPreviewUuid && previewContext?.uuids?.includes(expectedPreviewUuid));
      previewIdentitySignal = uuidMatches ? "uuid" : labelMatches ? "exact_preview_filename" : "unverified";
      if (addToPromptVisibleCount === 1 && (selectedAssetAriaSelected === "true" || labelMatches) && previewIdentitySignal !== "unverified") {
        referenceSelectionReady = true; break;
      }
      if (!selectionRetried && Date.now() - selectionWaitStartedAt >= 1000 && Date.now() < selectionDeadline) {
        selectionRetried = true;
        const box = await activeAsset.boundingBox({ timeout: 200 }).catch(() => null);
        await activeAsset.scrollIntoViewIfNeeded({ timeout: 300 }).catch(() => {});
        await activeAsset.hover({ timeout: 300 }).catch(() => {});
        console.log(JSON.stringify({ event: "ingredients_picker_step_diagnostics", step: "before_retry_click", ...(await readPickerDiagnostics(box)) }));
        current = await freshTile();
        if (!current || !box || Date.now() >= selectionDeadline) break;
        activeAsset = current.tile;
        const currentBox = await activeAsset.boundingBox({ timeout: 200 }).catch(() => null);
        if (!currentBox) break;
        const point = { x: Math.floor(currentBox.width / 2), y: Math.floor(currentBox.height / 2) };
        const ancestor = activeAsset.locator('xpath=ancestor-or-self::*[@role="option" or @role="button" or self::button or @tabindex][1]').first();
        const ancestorCount = await ancestor.count().catch(() => 0);
        const hitTest = await page.evaluate(({ x, y, tileSelector, filename }) => {
          const hit = document.elementFromPoint(x, y);
          const tiles = Array.from(document.querySelectorAll(tileSelector)).filter(tile => String(tile.innerText || tile.textContent || "").toLowerCase().includes(filename.toLowerCase()));
          return Boolean(hit && tiles.some(tile => tile === hit || tile.contains(hit)));
        }, { x: currentBox.x + point.x, y: currentBox.y + point.y, tileSelector: selectors.ingredient_library_item, filename }).catch(() => false);
        const retryActivationStartedAt = Date.now();
        if (hitTest && ancestorCount === 1 && await ancestor.isVisible({ timeout: 150 }).catch(() => false)) {
          const ancestorBox = await ancestor.boundingBox({ timeout: 150 }).catch(() => null);
          if (ancestorBox) await ancestor.click({ position: { x: Math.floor(ancestorBox.width / 2), y: Math.floor(ancestorBox.height / 2) }, timeout: 500 }).catch(() => {});
        } else if (hitTest) {
          await activeAsset.click({ position: point, timeout: 500 }).catch(() => {});
        }
        console.log(JSON.stringify({ event: "ingredients_picker_activation_timing", filename, step: "retry_click", elapsed_ms: Date.now() - retryActivationStartedAt, hit_test_inside_tile: hitTest, clicked_interactive_ancestor: ancestorCount === 1 }));
        console.log(JSON.stringify({ event: "ingredients_picker_click_target", step: "retry", filename, clicked_interactive_ancestor: ancestorCount === 1, ...await readPickerDiagnostics(currentBox) }));
        console.log(JSON.stringify({ event: "ingredients_picker_step_diagnostics", step: "after_retry_click", hit_test_inside_tile: hitTest, ...(await readPickerDiagnostics(currentBox)) }));
        const fallbackMethods = ["thumbnail_hover_click", "thumbnail_pointer_sequence", "option_double_click", "focus_space"];
        for (const method of fallbackMethods) {
          if (Date.now() >= selectionDeadline) break;
          const activationStartedAt = Date.now();
          const latest = await freshTile();
          if (!latest) {
            console.log(JSON.stringify({ event: "ingredients_picker_activation_attempt", filename, method, elapsed_ms: Date.now() - activationStartedAt, skipped: true, reason: "picker_closed_or_tile_missing" }));
            break;
          }
          activeAsset = latest.tile;
          const option = activeAsset.locator('xpath=ancestor-or-self::*[@role="option" or @role="button" or self::button or @tabindex][1]').first();
          const optionCount = await option.count().catch(() => 0);
          const target = optionCount === 1 ? option : activeAsset;
          const img = activeAsset.locator("img").first();
          try {
            if (method === "thumbnail_hover_click") {
              if (await img.count().catch(() => 0) === 1 && await img.isVisible({ timeout: 150 }).catch(() => false)) {
                await img.hover({ timeout: 250 });
                await img.click({ timeout: 300 });
              } else { await target.hover({ timeout: 250 }); await target.click({ timeout: 300 }); }
            } else if (method === "thumbnail_pointer_sequence") {
              const hasImg = await img.count().catch(() => 0) === 1 && await img.isVisible({ timeout: 150 }).catch(() => false);
              const eventTarget = hasImg ? img : target;
              await eventTarget.evaluate(node => {
                const r = node.getBoundingClientRect();
                const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse" };
                node.dispatchEvent(new PointerEvent("pointerover", { ...init, buttons: 0 }));
                node.dispatchEvent(new PointerEvent("pointerenter", { ...init, buttons: 0 }));
                node.dispatchEvent(new MouseEvent("mouseover", { ...init, buttons: 0 }));
                node.dispatchEvent(new MouseEvent("mouseenter", { ...init, buttons: 0 }));
                node.dispatchEvent(new PointerEvent("pointerdown", init));
                node.dispatchEvent(new MouseEvent("mousedown", init));
                node.dispatchEvent(new PointerEvent("pointerup", { ...init, buttons: 0 }));
                node.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0 }));
                node.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0 }));
              }, { timeout: 350 });
            } else if (method === "option_double_click") await target.dblclick({ timeout: 350 });
            else { await target.focus({ timeout: 250 }); await target.press("Space", { timeout: 250 }); }
          } catch (error) { console.log(JSON.stringify({ event: "ingredients_picker_activation_action_error", filename, method, elapsed_ms: Date.now() - activationStartedAt, action_error: String(error.message || error).slice(0, 180) })); }
          await page.waitForTimeout(Math.min(150, Math.max(0, selectionDeadline - Date.now())));
          const after = await freshTile();
          const afterSelected = after ? await after.tile.getAttribute("aria-selected", { timeout: 150 }).catch(() => null) : null;
          const afterAddCount = after ? await countVisibleMatches(after.container, selectors.ingredient_add_to_prompt) : 0;
          const afterAdd = after && afterAddCount === 1 ? after.container.locator(selectors.ingredient_add_to_prompt).first() : null;
          const afterPreview = afterAdd ? await inspectAddToPromptContext(afterAdd) : null;
          console.log(JSON.stringify({ event: "ingredients_picker_activation_attempt", filename, method, elapsed_ms: Date.now() - activationStartedAt, picker_still_open: Boolean(after),
            selected_aria_selected: afterSelected, add_to_prompt_visible_count: afterAddCount,
            preview_context: afterPreview ? { depth: afterPreview.depth, context_tag: afterPreview.context_tag, context_role: afterPreview.context_role,
              context_text: afterPreview.context_text, preview_labels: afterPreview.preview_labels, uuids: afterPreview.uuids, image_sources: afterPreview.image_sources?.slice(0, 8) } : null,
            ...(await readPickerDiagnostics(currentBox)) }));
          if (!after || afterSelected === "true" || (afterPreview?.preview_labels || []).some(label => label.toLowerCase() === targetFilename)) break;
        }
      }
      await page.waitForTimeout(Math.min(100, Math.max(0, selectionDeadline - Date.now())));
    }
    console.log(JSON.stringify({
      event: "reference_asset_selection_ready",
      filename,
      selected_asset_aria_selected: selectedAssetAriaSelected,
      add_to_prompt_visible_count: addToPromptVisibleCount,
      preview_labels: previewContext?.preview_labels || [],
      preview_uuids: previewContext?.uuids || [],
      preview_identity_signal: previewIdentitySignal,
      wait_ms: Date.now() - selectionWaitStartedAt,
      elapsed_ms: Date.now() - selectionWaitStartedAt,
      timeout_ms: selectionWaitTimeoutMs,
      selection_retried: selectionRetried,
      ready: referenceSelectionReady,
      readiness_signal: "unique_visible_add_button_plus_exact_preview_filename_or_uuid",
    }));
    if (!referenceSelectionReady && expectedPreviewUuid) {
      // One bounded picker-level recovery for the observed transient state where
      // clicks leave aria-selected=false and the preview/Add action never appears.
      // Do not attach anything until a fresh picker and the exact pinned identity
      // produce a matching preview signal.
      const pickerRetryStartedAt = Date.now();
      console.warn(JSON.stringify({ event: "ingredients_picker_selection_reopen_retry", filename,
        reason: "selection_not_verified_within_initial_budget", pinned_uuid: expectedPreviewUuid,
        initial_elapsed_ms: Date.now() - selectionWaitStartedAt }));
      await resetIngredientsPicker(page, selectors);
      await openIngredientsPicker(page, selectors, filename);
      const reopened = await resolveVisibleIngredientsPicker(page, selectors, filename, filenameStem);
      const reopenedCount = await reopened.matching.count().catch(() => 0);
      if (reopened.visibleMatches !== 1 || reopenedCount !== 1) {
        throw new Error(`Bounded picker retry requires exactly one visible matching tile for ${filename}; visible_matches=${reopened.visibleMatches}, matches=${reopenedCount}. Stopping before Add/prompt fill/Create.`);
      }
      pickerContainer = reopened.container;
      matchingAssets = reopened.matching;
      activeAsset = reopened.matching.first();
      const retryBox = await activeAsset.boundingBox({ timeout: 300 }).catch(() => null);
      if (!retryBox) throw new Error(`Bounded picker retry could not locate the target tile for ${filename}; stopping before Add/prompt fill/Create.`);
      await activeAsset.scrollIntoViewIfNeeded({ timeout: 400 }).catch(() => {});
      const retryAncestor = activeAsset.locator('xpath=ancestor-or-self::*[@role="option" or @role="button" or self::button or @tabindex][1]').first();
      const retryAncestorCount = await retryAncestor.count().catch(() => 0);
      if (retryAncestorCount === 1 && await retryAncestor.isVisible({ timeout: 200 }).catch(() => false)) {
        const retryAncestorBox = await retryAncestor.boundingBox({ timeout: 200 }).catch(() => null);
        if (retryAncestorBox) await retryAncestor.click({ position: { x: Math.floor(retryAncestorBox.width / 2), y: Math.floor(retryAncestorBox.height / 2) }, timeout: 600 }).catch(() => {});
      } else {
        await activeAsset.click({ position: { x: Math.max(2, Math.floor(retryBox.width / 2)), y: Math.max(2, Math.floor(retryBox.height / 2)) }, timeout: 600 }).catch(() => {});
      }
      const retryDeadline = Date.now() + 3500;
      while (Date.now() < retryDeadline) {
        const tileCountNow = await reopened.matching.count().catch(() => 0);
        const latestTile = tileCountNow === 1 ? reopened.matching.first() : null;
        const latestSelected = latestTile ? await latestTile.getAttribute("aria-selected", { timeout: 150 }).catch(() => null) : null;
        const scopedAddCandidates = reopened.container.locator(selectors.ingredient_add_to_prompt);
        const scopedAddCount = await scopedAddCandidates.count().catch(() => 0);
        let latestAdd = null;
        let latestAddCount = 0;
        for (let i = 0; i < scopedAddCount; i += 1) {
          const candidate = scopedAddCandidates.nth(i);
          if (await candidate.isVisible({ timeout: 100 }).catch(() => false)) {
            latestAddCount += 1;
            latestAdd = candidate;
          }
        }
        const latestPreview = latestAddCount === 1 && latestAdd ? await inspectAddToPromptContext(latestAdd) : null;
        const latestLabels = (latestPreview?.preview_labels || []).map(label => String(label).trim().toLowerCase());
        const labelMatchesRetry = latestLabels.includes(targetFilename);
        const uuidMatchesRetry = Boolean(latestPreview?.uuids?.includes(expectedPreviewUuid));
        if (latestTile && latestAddCount === 1 && (latestSelected === "true" || labelMatchesRetry)
          && (uuidMatchesRetry || labelMatchesRetry)) {
          pickerContainer = reopened.container;
          matchingAssets = reopened.matching;
          activeAsset = latestTile;
          selectedAssetAriaSelected = latestSelected;
          addToPromptVisibleCount = latestAddCount;
          previewContext = latestPreview;
          previewIdentitySignal = uuidMatchesRetry ? "uuid" : "exact_preview_filename";
          referenceSelectionReady = true;
          console.log(JSON.stringify({ event: "ingredients_picker_selection_reopen_retry_result", filename,
            ready: true, selected_asset_aria_selected: latestSelected, add_to_prompt_visible_count: latestAddCount,
            preview_identity_signal: previewIdentitySignal, elapsed_ms: Date.now() - pickerRetryStartedAt }));
          break;
        }
        await page.waitForTimeout(120);
      }
      if (!referenceSelectionReady) {
        console.warn(JSON.stringify({ event: "ingredients_picker_selection_reopen_retry_result", filename,
          ready: false, elapsed_ms: Date.now() - pickerRetryStartedAt,
          reason: "exact preview identity not verified; no Add to prompt click attempted" }));
      }
    }
    if (!referenceSelectionReady) {
      throw new Error(`Reference selection did not verify the target preview for ${filename}; configured wait budget=${selectionWaitTimeoutMs}ms, actual elapsed=${Date.now() - selectionWaitStartedAt}ms, aria-selected=${JSON.stringify(selectedAssetAriaSelected)}, visible Add to prompt buttons=${addToPromptVisibleCount}, preview labels=${JSON.stringify(previewContext?.preview_labels || [])}, preview UUIDs=${JSON.stringify(previewContext?.uuids || [])}, selection_retried=${selectionRetried}, picker_reopen_retried=${Boolean(expectedPreviewUuid)}. Stopping before Add/prompt fill/Create.`);
    }
    // Re-resolve the selected tile and action inside the current overlay. A reuse
    // recheck may have closed/reopened the picker, detaching pickerResolution.container.
    current = await freshTile();
    if (!current) {
      throw new Error("The current Ingredients picker no longer contains exactly one visible target tile; stopping before chip attach.");
    }
    const activePickerContainer = current.container;
    const addToPromptCandidatesFresh = activePickerContainer.locator(addToPromptSelector);
    const addToPromptCandidateCount = await addToPromptCandidatesFresh.count().catch(() => 0);
    let addToPrompt = null;
    let finalVisibleAddCount = 0;
    for (let i = 0; i < addToPromptCandidateCount; i += 1) {
      const candidate = addToPromptCandidatesFresh.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        finalVisibleAddCount += 1;
        addToPrompt = candidate;
      }
    }
    if (finalVisibleAddCount !== 1 || !addToPrompt) {
      throw new Error(`Ingredients picker Add to prompt must be uniquely visible in the current picker; visible count=${finalVisibleAddCount}, DOM matches=${addToPromptCandidateCount}. Stopping before chip attach.`);
    }
    // Re-read identity from the exact fresh action context immediately before click.
    previewContext = await inspectAddToPromptContext(addToPrompt);
    const immediatePreviewLabels = (previewContext?.preview_labels || []).map(label => String(label).trim().toLowerCase());
    const immediateLabelMatches = immediatePreviewLabels.includes(targetFilename);
    const immediateUuidMatches = Boolean(expectedPreviewUuid && previewContext?.uuids?.includes(expectedPreviewUuid));
    console.log(JSON.stringify({
      event: "ingredients_picker_add_action_identity",
      filename,
      expected_asset_uuid: expectedPreviewUuid || null,
      target_filename: targetFilename,
      preview_context: previewContext,
      identity_verified: immediateUuidMatches || immediateLabelMatches,
      identity_signal: immediateUuidMatches ? "uuid" : immediateLabelMatches ? "exact_preview_filename" : "unverified",
      final_visible_add_button_count: finalVisibleAddCount,
      action_clicked: false,
    }));
    if (!immediateUuidMatches && !immediateLabelMatches) {
      throw new Error(`Cannot verify Add to prompt preview identity for ${filename}; target filename=${targetFilename}, preview labels=${JSON.stringify(previewContext?.preview_labels || [])}, preview UUIDs=${JSON.stringify(previewContext?.uuids || [])}. Refusing to click Add to prompt.`);
    }
    let attachedAfterClick = false;
    let lastClickError = null;
    const chipAttachStartedAt = Date.now();
    let addClickAttemptTimings = [];
    for (let clickAttempt = 0; clickAttempt < 3; clickAttempt += 1) {
      const addClickStartedAt = Date.now();
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
      addClickAttemptTimings.push({ attempt: clickAttempt + 1, elapsed_ms: Date.now() - addClickStartedAt, attached: attachedAfterClick, click_error: lastClickError ? String(lastClickError.message || lastClickError).slice(0, 140) : null });
      console.log(JSON.stringify({ event: "ingredient_add_to_prompt_attempt_timing", filename, ...addClickAttemptTimings[addClickAttemptTimings.length - 1] }));
      if (attachedAfterClick) break;
      if (clickAttempt < 2) await page.waitForTimeout(350);
    }
    console.log(JSON.stringify({ event: "ingredient_add_to_prompt_chip_attach_timing", filename, elapsed_ms: Date.now() - chipAttachStartedAt, attempts: addClickAttemptTimings, attached: attachedAfterClick }));
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
    logReferencePhase("select_asset_and_attach_chip", selectionAndAttachStartedAt, { selected_chip_uuid_verified: true });
    const closeAndVerifyStartedAt = Date.now();
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
    logReferencePhase("close_picker_and_verify_chips", closeAndVerifyStartedAt, { final_chip_count: finalChipCount, attached_uuid_count: attachedUuids.length });
    console.log(JSON.stringify({ event: "reference_step_end", filename, elapsed_ms: Date.now() - assetStartedAt, phases: referenceTiming, selected_asset_uuid_verified: true, total_references_so_far: expectedUuids.length }));
    console.log(`Verified Ingredients asset ${filename} -> UUID ${assetUuid}; total reference step ${Date.now() - assetStartedAt}ms`);
  }

  const finalCount = await chips.count();
  if (finalCount !== referenceImages.length) throw new Error(`Ingredients chip count mismatch: expected ${referenceImages.length}, observed ${finalCount}. Stopping before prompt fill/Create.`);
  const finalUuidVerifyStartedAt = Date.now();
  await verifyAttachedReferenceUuids(page, selectors, expectedUuids);
  console.log(JSON.stringify({ event: "reference_batch_final_uuid_verification_timing", elapsed_ms: Date.now() - finalUuidVerifyStartedAt, reference_count: finalCount }));
  console.log(JSON.stringify({ event: "reference_upload_batch_end", elapsed_ms: Date.now() - batchStartedAt, reference_count: finalCount, verified: true }));
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
  const referenceLanguageMode = scene.reference_language_mode ?? "identity_preserving";
  if (!["identity_preserving", "neutral_reference"].includes(referenceLanguageMode)) {
    throw new Error("reference_language_mode must be 'identity_preserving' or 'neutral_reference'.");
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
  // Set framing_helper=false when the scene prompt already defines its own framing.
  // Alternatively, provide framing_helper_text to replace the default helper sentence.
  // The custom sentence is only appended when the helper is enabled for this scene.
  scene.framing_helper_applied = scene.framing_helper === false ? false : (scene.framing_helper === true || seatedShot);
  if (scene.framing_helper_applied) {
    scene.prompt = scene.prompt.replace(/\\b(?:fills?|occupies?)\s+(?:about\s+)?\\d{1,3}\s*(?:percent|%)\s+of\s+(?:the\s+)?frame\s+width\\b/gi, "is framed from head to knees");
    const defaultFramingSentence = "Medium-wide full-body shot. The person and yoga mat fill most of the frame while keeping the entire head, both knees, feet, and mat visible with a modest, clear margin on every side. Keep the face large enough for facial features to remain readable; do not leave excessive empty floor or make the person appear small. Do not crop the body or mat. Locked-off tripod shot from the first frame: the camera does not move, pan, tilt, dolly, or zoom at any time.";
    const framingSentence = typeof scene.framing_helper_text === "string" && scene.framing_helper_text.trim()
      ? scene.framing_helper_text.trim()
      : defaultFramingSentence;
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
  const faceAnchorInstructions = referenceLanguageMode === "neutral_reference"
    ? "Use the character shown in the reference image as a visual guide."
    : faceReferenceImages.length > 1
      ? "The first attached image shows the character. Keep the same character as the reference image: facial structure, eye shape and spacing, nose, lips, cheeks, and jawline. The other selected face reference images show the same character from additional angles. Use them to understand the character's features; do not mix them with supporting references."
      : "The first attached image shows the character. Keep the same character as the reference image: facial structure, eye shape and spacing, nose, lips, cheeks, and jawline.";
  const characterDescriptionSection = faceDescriptionMode === "reference_only" || !scene.character_description
    ? "Use the reference image as the visual guide for the character's overall appearance."
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
  // The scene's expression is authoritative. The guard only enforces eye state;
  // it must not inject a conflicting fixed smile (e.g. toothy smile vs small smile).
  const openEyesGuard = openEyesRequested
    ? "Eyes remain clearly open throughout the entire shot, with natural brief blinks only. No prolonged eye closure or eyes-closed meditation."
    : "";
  const expressionContent = [normalizedExpression, openEyesGuard].filter(Boolean).join(normalizedExpression ? ". " : "");
  const expressionSection = expressionContent
    ? `\n\nEXPRESSION AND EYE STATE (follow throughout the entire shot): ${expressionContent}${/[.!?]$/.test(expressionContent) ? "" : "."} Keep this expression and eye state consistent from the first frame to the last; this instruction takes priority over breathing or other subtle motion.`
    : "";
  const supportingReferenceImages = referenceImages.filter(imagePath => !faceReferenceImages.includes(imagePath));
  const supportingReferenceSection = supportingReferenceImages.length
    ? "Use remaining attached images only as supporting references for clothing, body, or context."
    : "";
  const supportingReferencePrefix = supportingReferenceSection ? `${supportingReferenceSection} ` : "";
  scene.prompt = referenceLanguageMode === "neutral_reference"
    ? `${faceAnchorInstructions}\n\n${characterDescriptionSection}\n\nSCENE: ${scene.prompt.trim()}${expressionSection}\n\n${supportingReferencePrefix}Keep the overall visual design and clothing consistent with the reference images.`
    : `PRIMARY FACE REFERENCE: ${faceAnchorInstructions} Keep the same person throughout the clip.\n\n${characterDescriptionSection}\n\nSCENE: ${scene.prompt.trim()}${expressionSection}\n\n${supportingReferencePrefix}Keep the same character, hair, and skin tone throughout. Do not substitute a different person.`;
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


function firstThreeMediaKeysMatch(baselineKeys, currentKeys) {
  const isStableKey = value => typeof value === "string" && (
    /^media:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    || /^failed-policy:.{20,}$/i.test(value)
  );
  return Array.isArray(baselineKeys) && Array.isArray(currentKeys)
    && baselineKeys.length >= 3 && currentKeys.length >= 3
    && baselineKeys.slice(0, 3).every((key, index) => isStableKey(key)
      && isStableKey(currentKeys[index])
      && key.toLowerCase() === currentKeys[index].toLowerCase())
    && new Set(currentKeys.slice(0, 3).map(key => key.toLowerCase())).size === 3;
}

function firstTileMatchesByStableNeighbors({ expectedToken, currentToken, baselineTokens, currentTokens, baselineTileCount, currentTileCount }) {
  // The baseline is a thumbnail identity, not necessarily a media UUID. Flow can
  // expose the same tile as an "asb:" URL at capture and a "media:" UUID elsewhere.
  // Permit signed-thumbnail rotation when both adjacent thumbnail identities and
  // the overall tile count remain unchanged.
  const validToken = token => typeof token === "string" && token.length > 0;
  const secondNeighborMatches = validToken(baselineTokens?.[1]) && baselineTokens[1] === currentTokens?.[1];
  const thirdNeighborMatches = validToken(baselineTokens?.[2]) && validToken(currentTokens?.[2])
    && baselineTokens[2] === currentTokens[2];
  // Missing third-thumbnail data is not evidence of stable neighbors. Wait for
  // a complete row snapshot; if it never arrives, fail closed before Create.
  return Boolean((expectedToken?.startsWith("media:") || expectedToken?.startsWith("asb:"))
    && currentToken?.startsWith("asb:")
    && Array.isArray(baselineTokens) && baselineTokens.length >= 3
    && Array.isArray(currentTokens) && currentTokens.length >= 3
    && currentTokens.slice(0, 3).every(validToken)
    && Number.isInteger(baselineTileCount) && baselineTileCount === currentTileCount
    && secondNeighborMatches && thirdNeighborMatches);
}

async function waitForPreCreateThumbnailSnapshot(readSnapshot, wait, maxWaitMs = 10000) {
  const startedAt = Date.now();
  let previousTokens = null;
  let previousTileCount = null;
  let stableFirstToken = false;
  let lastSnapshot = { tokens: [], tileCount: 0 };
  while (Date.now() - startedAt < maxWaitMs) {
    lastSnapshot = await readSnapshot();
    const tokens = Array.isArray(lastSnapshot.tokens) ? lastSnapshot.tokens : [];
    const tileCount = Number(lastSnapshot.tileCount) || 0;
    const firstToken = tokens[0] || null;
    stableFirstToken = Boolean(firstToken && previousTokens?.[0] === firstToken
      && previousTileCount === tileCount);
    const fullyStable = tileCount >= 3 && tokens.length >= 3 && tokens.slice(0, 3).every(Boolean)
      && previousTokens?.length === tokens.length
      && tokens.every((token, index) => token === previousTokens[index])
      && previousTileCount === tileCount;
    if (fullyStable) {
      return { ...lastSnapshot, tokens, tileCount, stableFirstToken: true, fullyStable: true,
        acceptedByNeighborRule: false, waitMs: Date.now() - startedAt };
    }
    previousTokens = tokens.slice();
    previousTileCount = tileCount;
    if (Date.now() - startedAt < maxWaitMs) await wait(250);
  }
  const lastTokens = Array.isArray(lastSnapshot.tokens) ? lastSnapshot.tokens : [];
  return { ...lastSnapshot, tokens: lastTokens, tileCount: Number(lastSnapshot.tileCount) || 0,
    stableFirstToken, fullyStable: false,
    // Neighbor fallback is only eligible when the complete first row is present.
    // A null token cannot be treated as a matching neighbor.
    acceptedByNeighborRule: stableFirstToken && (Number(lastSnapshot.tileCount) || 0) >= 3
      && lastTokens.length >= 3 && lastTokens.slice(0, 3).every(token => typeof token === "string" && token.length > 0),
    waitMs: Date.now() - startedAt };
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
  // Diagnose image mode before video-only controls are queried.
  const visibleModelBeforeSettings = chosen.page.locator(selectors.model);
  if (await visibleModelBeforeSettings.count().catch(() => 0) === 1
    && await visibleModelBeforeSettings.isVisible().catch(() => false)) {
    const currentModelLabel = (await visibleModelBeforeSettings.innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ").trim();
    if (/nano banana|imagen|image generation/i.test(currentModelLabel)) {
      throw new Error(`Composer is in Image mode (current model: ${JSON.stringify(currentModelLabel)}); switch to Video mode and select ${scene.model} before rerunning. Prompt and references were not changed.`);
    }
  }
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
    let duration;
    try {
      duration = await exactVisibleLocator(chosen.page, selectors.duration, "8s duration radio");
    } catch (error) {
      const visibleModelLabel = (await model.innerText({ timeout: 1500 }).catch(() => "")).replace(/\s+/g, " ").trim();
      if (/nano banana|imagen|image generation/i.test(visibleModelLabel)) {
        throw new Error(`Composer is in Image mode (current model: ${JSON.stringify(visibleModelLabel)}); switch to Video mode and select ${scene.model} before rerunning.`);
      }
      throw error;
    }
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
  if (args.waitForResult || args.dryRun) {
    const waitPreflightStartedAt = Date.now();
    const baselineUuidCache = new Map();
    try {
      const balanceReadStartedAt = Date.now();
      // Dry-run is a pre-Create safety check too: actually read the live balance
      // instead of reporting a short-circuited "success" when --wait is absent.
      const requiresInitialBalance = args.waitForResult || args.dryRun;
      const initialBalance = requiresInitialBalance ? await readCreditBalance(chosen.page, selectors) : null;
      console.log(JSON.stringify({ event: "wait_preflight_phase_timing", phase: "read_initial_balance", elapsed_ms: Date.now() - balanceReadStartedAt, required: requiresInitialBalance, success: !requiresInitialBalance || (Number.isSafeInteger(initialBalance) && initialBalance >= 0), balance_read: Number.isSafeInteger(initialBalance) && initialBalance >= 0 }));
      if (requiresInitialBalance && (!Number.isSafeInteger(initialBalance) || initialBalance < 0)) {
        throw new Error("Could not read a valid non-negative integer credit balance; refusing to continue pre-Create.");
      }
      if (typeof selectors.generated_video_items !== "string" || !selectors.generated_video_items.trim()) throw new Error("Dry-run baseline scan requires a configured generated_video_items selector.");
      const videosTabStartedAt = Date.now();
      const videosTabState = await activateVideosTab(chosen.page, selectors);
      console.log(JSON.stringify({ event: "wait_preflight_phase_timing", phase: "activate_videos_tab", elapsed_ms: Date.now() - videosTabStartedAt, state: videosTabState }));
      const waitForFirstRowThumbnailTokens = async (reason, maxWaitMs = 15000) => {
        const startedAt = Date.now();
        let snapshot = [];
        let previousReadySnapshot = null;
        while (Date.now() - startedAt < maxWaitMs) {
          snapshot = await chosen.page.locator(selectors.generated_video_items).evaluateAll(elements => elements.slice(0, 3).map(element => {
            const source = element.querySelector("img")?.getAttribute("src") || "";
            // Flow's /image/<uuid> URL is a lazy-load placeholder, not a
            // ready tile thumbnail. Wait for /asb/ or another non-placeholder URL.
            if (!source || /\/image\//i.test(source)) return null;
            const asbIndex = source.toLowerCase().indexOf("/asb/");
            if (asbIndex >= 0) {
              const token = source.slice(asbIndex + 5).split(/[/?#]/, 1)[0];
              if (token) return `asb:${token.split("=", 1)[0]}`;
            }
            try {
              const url = new URL(source, location.href);
              return /^https?:$/.test(url.protocol) ? url.pathname : null;
            } catch { return null; }
          })).catch(() => []);
          // Lazy-loaded thumbnails can arrive one tile at a time. Require all three
          // tokens in two consecutive snapshots so we don't capture a transient null
          // just as Flow finishes painting the final tile.
          if (snapshot.length >= 3 && snapshot.every(Boolean)
            && previousReadySnapshot?.length === snapshot.length
            && snapshot.every((token, index) => token === previousReadySnapshot[index])) {
            console.log(JSON.stringify({
              event: "baseline_thumbnail_tokens_ready",
              reason,
              tile_count: snapshot.length,
              thumbnail_tokens: snapshot,
              wait_ms: Date.now() - startedAt,
              stable_snapshots: 2,
            }));
            return snapshot;
          }
          previousReadySnapshot = snapshot.length >= 3 && snapshot.every(Boolean) ? [...snapshot] : null;
          await chosen.page.waitForTimeout(250);
        }
        console.warn(JSON.stringify({
          event: "baseline_thumbnail_token_missing_at_capture",
          reason,
          tile_count: snapshot.length,
          thumbnail_tokens: snapshot,
          missing_indexes: snapshot.map((token, index) => token ? null : index).filter(index => index !== null),
          wait_ms: Date.now() - startedAt,
          max_wait_ms: maxWaitMs,
        }));
        return snapshot;
      };
      // Save the grid scroll before forcing lazy thumbnails into view; the inventory
      // helper restores its own entry position, which may already have been changed below.
      const preflightScrollPosition = await chosen.page.evaluate(selectorText => {
        const first = document.querySelector(selectorText);
        let node = first?.parentElement || null;
        while (node && node !== document.body) {
          const style = getComputedStyle(node);
          if (node.scrollHeight > node.clientHeight + 8 && /(auto|scroll|overlay)/.test(style.overflowY)) return { kind: "element", top: node.scrollTop };
          node = node.parentElement;
        }
        return { kind: "document", top: (document.scrollingElement || document.documentElement).scrollTop };
      }, selectors.generated_video_items).catch(() => null);
      const restorePreflightScrollPosition = async () => {
        if (!preflightScrollPosition) return { restored: false, reason: "initial_scroll_unavailable" };
        return chosen.page.evaluate(({ selectorText, saved }) => {
          const first = document.querySelector(selectorText);
          let node = first?.parentElement || null;
          while (node && node !== document.body) {
            const style = getComputedStyle(node);
            if (node.scrollHeight > node.clientHeight + 8 && /(auto|scroll|overlay)/.test(style.overflowY)) {
              if (saved.kind === "element") node.scrollTop = saved.top;
              return { restored: true, kind: "element", top: node.scrollTop };
            }
            node = node.parentElement;
          }
          const root = document.scrollingElement || document.documentElement;
          if (saved.kind === "document") root.scrollTop = saved.top;
          return { restored: true, kind: "document", top: root.scrollTop };
        }, { selectorText: selectors.generated_video_items, saved: preflightScrollPosition }).catch(error => ({ restored: false, error: String(error?.message || error).slice(0, 300) }));
      };
      // Force the first-row tile shells through the viewport so lazy image loading
      // has a chance to populate every thumbnail before the first baseline snapshot.
      const firstRowTiles = chosen.page.locator(selectors.generated_video_items);
      const firstRowCount = await firstRowTiles.count().catch(() => 0);
      const firstRowScrollStartedAt = Date.now();
      for (let tileIndex = 0; tileIndex < Math.min(3, firstRowCount); tileIndex += 1) {
        await firstRowTiles.nth(tileIndex).scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
        await chosen.page.waitForTimeout(100);
      }
      console.log(JSON.stringify({ event: "wait_preflight_phase_timing", phase: "scroll_first_row", elapsed_ms: Date.now() - firstRowScrollStartedAt, tile_count: firstRowCount }));
      const firstThumbnailWaitStartedAt = Date.now();
      await waitForFirstRowThumbnailTokens("before_initial_capture_after_scroll");
      console.log(JSON.stringify({ event: "wait_preflight_phase_timing", phase: "first_row_thumbnail_wait", elapsed_ms: Date.now() - firstThumbnailWaitStartedAt }));
      const initialInventoryStartedAt = Date.now();
      let initialScan = await collectAllGeneratedItems(chosen.page, selectors.generated_video_items, { uuidCache: baselineUuidCache, topLimit: 3, selectors });
      console.log(JSON.stringify({ event: "wait_preflight_phase_timing", phase: "initial_media_inventory", elapsed_ms: Date.now() - initialInventoryStartedAt, item_count: initialScan.items.length, uuid_count: initialScan.items.filter(item => item.mediaUuid).length }));
      // If a thumbnail token is missing but all three media UUIDs are already
      // resolved uniquely, refresh thumbnail URLs only. Re-opening every tile would
      // trigger three editor round-trips (~30s) and can rotate the very /asb/ tokens
      // this snapshot is meant to capture. Keep UUID resolution fail-closed.
      const verifiedUuidThumbnailIndexes = new Set();
      // Keep ASB tokens observed during the same refreshed first-row scan that
      // independently verifies each media UUID. Some cards expose the token in
      // the live DOM while collectAllGeneratedItems.item.thumbnailSrc is null.
      const verifiedAsbAliasesByIndex = new Map();
      for (let thumbnailRetry = 1; thumbnailRetry <= 2
        && initialScan.items.length >= 3
        && initialScan.items.some(item => !item.thumbnailSrc || !thumbnailIdentityToken(item.thumbnailSrc) || /\/image\//i.test(item.thumbnailSrc)); thumbnailRetry += 1) {
        const missingIndexes = initialScan.items
          .map((item, index) => !item.thumbnailSrc || !thumbnailIdentityToken(item.thumbnailSrc) || /\/image\//i.test(item.thumbnailSrc) ? index : null)
          .filter(index => index !== null);
        const initialUuids = initialScan.items.map(item => item.mediaUuid);
        const completeUniqueUuidBaseline = initialUuids.every(Boolean) && new Set(initialUuids).size === initialUuids.length;
        console.warn(JSON.stringify({
          event: "baseline_thumbnail_token_missing_at_capture",
          retry: thumbnailRetry,
          max_retries: 2,
          tile_count: initialScan.items.length,
          uuid_count: initialUuids.filter(Boolean).length,
          missing_tile_indexes: missingIndexes,
          missing_thumbnail_token_indexes: missingIndexes,
          retry_strategy: thumbnailRetry === 1 && completeUniqueUuidBaseline ? "thumbnail_only_snapshot" : "full_row_dom_inventory",
          wait_ms: 500,
        }));
        await chosen.page.waitForTimeout(500);
        // Explicitly bring each first-row tile into view on every bounded recapture;
        // lazy thumbnail loading can stall on the third tile even when UUID lookup succeeds.
        const retryTiles = chosen.page.locator(selectors.generated_video_items);
        const retryTileCount = await retryTiles.count().catch(() => 0);
        for (let tileIndex = 0; tileIndex < Math.min(3, retryTileCount); tileIndex += 1) {
          await retryTiles.nth(tileIndex).scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
          await chosen.page.waitForTimeout(150);
        }
        // Retry 1 is a cheap DOM snapshot; reserve the thumbnail wait for the
        // expensive full-row retry, which independently resolves video UUIDs.
        if (thumbnailRetry === 2) await waitForFirstRowThumbnailTokens(`recapture_retry_${thumbnailRetry}`);
        const retryInventoryStartedAt = Date.now();
        const refreshedScan = await collectAllGeneratedItems(chosen.page, selectors.generated_video_items, {
          // Do not reuse the first inventory's UUID cache on retry 2: the full pass
          // must independently re-identify each tile, not merely replay a cached UUID
          // for the same text/URL hint.
          uuidCache: thumbnailRetry === 1 ? baselineUuidCache : new Map(),
          topLimit: 3, selectors,
          // Retry 1 is a fast DOM-only recapture. Retry 2 repeats per-tile UUID
          // re-identification, as the initial inventory does, so each row can be
          // verified by its generated-video UUID even when /image/ placeholders persist.
          skipUuidResolution: thumbnailRetry === 1,
        });
        const refreshedDomAsbTokenCandidates = await chosen.page.locator(selectors.generated_video_items).evaluateAll(elements =>
          elements.slice(0, 3).map(element => {
            // Flow may keep the first <img> on an /image/ placeholder while a
            // sibling/later image or video source already carries the live /asb/ token.
            const nodes = [element, ...Array.from(element.querySelectorAll("*"))];
            const sources = [];
            for (const node of nodes) {
              for (const attr of ["src", "srcset", "poster", "data-src", "href"]) {
                const value = node.getAttribute?.(attr);
                if (value) sources.push(String(value));
              }
            }
            const tokens = [];
            for (const source of sources) {
              for (const match of source.matchAll(/\/asb\/([^/?#\s,]+)/ig)) {
                const token = "asb:" + match[1].split("=", 1)[0];
                if (!tokens.includes(token)) tokens.push(token);
              }
            }
            return tokens;
          })).catch(() => []);
        const refreshedDomAsbTokens = refreshedDomAsbTokenCandidates.map(tokens => tokens[0] || null);
        console.log(JSON.stringify({
          event: "refreshed_dom_asb_thumbnail_tokens",
          retry: thumbnailRetry,
          // Retain exact normalized tokens in logs to diagnose UUID-to-ASB mapping.
          captured_tokens_by_index: refreshedDomAsbTokenCandidates.map(tokens => tokens.map(token => token.slice(0, 100))),
        }));
        if (initialScan.items.length >= 3 && refreshedScan.items.length >= 3) {
          const normalizeTileText = value => String(value || "").replace(/\s+/g, " ").trim();
          const baselineTexts = initialScan.items.map(item => normalizeTileText(item.text));
          const refreshedTexts = refreshedScan.items.map(item => normalizeTileText(item.text));
          const baselineTextCounts = new Map();
          const refreshedTextCounts = new Map();
          for (const value of baselineTexts) baselineTextCounts.set(value, (baselineTextCounts.get(value) || 0) + 1);
          for (const value of refreshedTexts) refreshedTextCounts.set(value, (refreshedTextCounts.get(value) || 0) + 1);
          // Flow may reorder cards or swap /image/ and /video/ URL forms between
          // captures. Verify the unique resolved-media UUID set and exact refusal
          // text, not same-position thumbnail tokens.
          const verifiedRowIndexes = verifiedFirstRowIdentityIndexes(initialScan.items, refreshedScan.items);
          let effectiveVerifiedRowIndexes = verifiedRowIndexes;
          const sameVisibleRow = verifiedRowIndexes !== null;
          let rowVerifiedForBaseline = sameVisibleRow;
          // A known policy-refusal tile has no media UUID by design. If the earlier
          // scan contains a stale thumbnail-derived UUID, adopt the independently
          // re-resolved full-row inventory only when it contains the same unique
          // refusal text plus exactly two unique media:<UUID> items.
          if (!sameVisibleRow && thumbnailRetry === 2) {
            const refusalFallbackIndexes = verifiedResolvedMediaWithRefusalFallback(initialScan.items, refreshedScan.items);
            if (refusalFallbackIndexes !== null) {
              effectiveVerifiedRowIndexes = refusalFallbackIndexes;
              rowVerifiedForBaseline = true;
              initialScan = { ...refreshedScan, items: refreshedScan.items.map(item => ({ ...item })) };
              console.warn(JSON.stringify({
                event: "baseline_refusal_resolved_uuid_fallback",
                policy: "same_unique_refusal_text_and_two_fresh_unique_media_uuids",
                media_uuids: initialScan.items.filter(item => item.mediaUuid).map(item => item.mediaUuid),
              }));
            }
          }
          if (rowVerifiedForBaseline) {
            if (thumbnailRetry === 2) {
              // UUID equality across independent full inventories verifies each media
              // tile even if its DOM position changes. Only mark UUIDs that are unique
              // and present in both inventories; refusal remains a text-keyed non-media tile.
              for (const index of effectiveVerifiedRowIndexes) verifiedUuidThumbnailIndexes.add(index);
              // The independently resolved scan is now the authoritative baseline
              // order. This prevents a prior tile's thumbnail token from being
              // paired with a different tile after Flow reorders the gallery.
              initialScan = {
                ...refreshedScan,
                items: refreshedScan.items.map(item => ({ ...item })),
              };
              verifiedUuidThumbnailIndexes.clear();
              for (let index = 0; index < initialScan.items.length; index += 1) {
                const item = initialScan.items[index];
                if (item.mediaUuid) {
                  verifiedUuidThumbnailIndexes.add(index);
                  const observedAsb = refreshedDomAsbTokens[index];
                  if (observedAsb) verifiedAsbAliasesByIndex.set(index, observedAsb);
                  if (!item.thumbnailSrc || /\/image\//i.test(item.thumbnailSrc)) {
                    item.thumbnailSrc = `media:${item.mediaUuid.toLowerCase()}`;
                  }
                }
              }
            }
          }
          console.log(JSON.stringify({
            event: "wait_preflight_phase_timing",
            phase: thumbnailRetry === 1 && completeUniqueUuidBaseline ? "thumbnail_only_recapture" : "full_row_dom_inventory",
            retry: thumbnailRetry,
            elapsed_ms: Date.now() - retryInventoryStartedAt,
            item_count: refreshedScan.items.length,
            uuid_count: refreshedScan.items.filter(item => item.mediaUuid).length,
            row_identity_verified: rowVerifiedForBaseline,
            refreshed_indexes: sameVisibleRow ? missingIndexes.filter(index => initialScan.items[index]?.thumbnailSrc && thumbnailIdentityToken(initialScan.items[index].thumbnailSrc)) : [],
          }));
          if (!rowVerifiedForBaseline) {
            console.warn(JSON.stringify({ event: "thumbnail_recapture_row_identity_unverified", retry: thumbnailRetry,
              max_retries: 2, observed_items: refreshedScan.items.length,
              action: thumbnailRetry < 2 ? "retry_full_row_inventory" : "fail_closed_after_retries" }));
            // Do not return early: the next bounded retry performs a fresh full-row
            // inventory (including UUID resolution), rather than reusing partial rows.
            continue;
          }
        } else {
          baselineUuidCache.clear();
          initialScan = refreshedScan;
          console.log(JSON.stringify({ event: "wait_preflight_phase_timing", phase: "thumbnail_recapture_inventory", retry: thumbnailRetry, elapsed_ms: Date.now() - retryInventoryStartedAt, item_count: initialScan.items.length, uuid_count: initialScan.items.filter(item => item.mediaUuid).length }));
        }
      }
      // Flow may render the three tile shells before its media UUID metadata arrives.
      // Retry only the all-unresolved case; never accept partial/ambiguous identities.
      for (let baselineRetry = 1; baselineRetry <= 2
        && initialScan.items.length > 0
        && initialScan.items.every(item => !item.mediaUuid); baselineRetry += 1) {
        console.warn(JSON.stringify({
          event: "baseline_uuid_retry",
          retry: baselineRetry,
          max_retries: 2,
          tile_count: initialScan.items.length,
          uuid_count: initialScan.items.filter(item => item.mediaUuid).length,
          wait_ms: 600,
        }));
        await chosen.page.waitForTimeout(600);
        baselineUuidCache.clear();
        const retryInventoryStartedAt = Date.now();
        initialScan = await collectAllGeneratedItems(chosen.page, selectors.generated_video_items, {
          uuidCache: baselineUuidCache, topLimit: 3, selectors,
        });
        console.log(JSON.stringify({ event: "wait_preflight_phase_timing", phase: "uuid_recapture_inventory", retry: baselineRetry, elapsed_ms: Date.now() - retryInventoryStartedAt, item_count: initialScan.items.length, uuid_count: initialScan.items.filter(item => item.mediaUuid).length }));
      }
      const restoredPreflightScroll = await restorePreflightScrollPosition();
      console.log(JSON.stringify({ event: "wait_preflight_scroll_restored", saved: preflightScrollPosition, result: restoredPreflightScroll }));
      const baselineValidationStartedAt = Date.now();
      // Keep every stable media UUID in the baseline, including Failed tiles, so a
      // later disappearing/refunded tile cannot make another existing card look new.
      // Failed tiles are diagnostics only and never count as usable video candidates.
      if (!initialScan.topLimited || initialScan.items.length < 3) throw new Error(`Pre-Create first-row baseline requires at least three visible tiles; observed ${initialScan.items.length}. Refusing to Create with an incomplete baseline.`);
      const initialItems = initialScan.items.map(item => failedPolicyBaselineKey(item) || item.key);
      const baselineUuids = initialScan.items.map(item => item.mediaUuid).filter(Boolean);
      const failedBaselineItems = initialScan.items.filter(item =>
        /\bfailed\b/i.test(`${item.state} ${item.text}`) || isGenerationFailureText(`${item.state} ${item.text}`));
      const knownPolicyRefusalIndexes = new Set(initialScan.items
        .map((item, index) => isKnownPolicyRefusalTile(item) ? index : -1).filter(index => index >= 0));
      args._waitInitialFailedTileTexts = failedBaselineItems.map(item => String(item.text || "").replace(/\s+/g, " ").trim().toLowerCase());
      console.log(JSON.stringify({
        event: "baseline_media_inventory_summary",
        baseline_strategy: "visible_first_row_min_3",
        reached_bottom: initialScan.reachedBottom,
        tile_count: initialScan.items.length,
        uuid_count: baselineUuids.length,
        baseline_media_uuids: baselineUuids,
        uuid_sample_first_5: baselineUuids.slice(0, 5),
        unkeyed_items_detected: initialScan.unkeyedItemsDetected,
        duplicate_visible_key_detected: initialScan.duplicateVisibleKeyDetected,
      }, null, 2));
      const unresolvedBaselineIndexes = initialScan.items
        .map((item, index) => item.mediaUuid && initialItems[index] ? -1
          : knownPolicyRefusalIndexes.has(index) && initialItems[index]?.startsWith("failed-policy:") ? -1 : index)
        .filter(index => index >= 0);
      if (initialScan.unkeyedItemsDetected || initialScan.duplicateVisibleKeyDetected
        || unresolvedBaselineIndexes.length > 0 || initialItems.some(key => !key) || new Set(initialItems).size !== initialItems.length) {
        // An explicit provider refusal is a known non-media card. Its exact normalized
        // text is the baseline key; all other unresolved tiles remain safety-critical.
        console.warn(JSON.stringify({
          event: "baseline_unresolved_tile_classification",
          phase: "pre_create_existing_baseline",
          policy: "explicit_policy_refusal_is_stable_non_media_other_unknowns_fail_closed",
          tiles: initialScan.items.map((item, index) => ({
            index,
            media_uuid_resolved: Boolean(item.mediaUuid),
            key_resolved: Boolean(initialItems[index]),
            classification: item.mediaUuid && initialItems[index] ? "stable_existing_baseline_tile"
              : knownPolicyRefusalIndexes.has(index) && initialItems[index]?.startsWith("failed-policy:") ? "known_policy_refusal_non_media_baseline"
                : "unknown_identity_fail_closed",
            text: String(item.text || "").replace(/\s+/g, " ").trim().slice(0, 160),
            thumbnail_token: item.thumbnailSrc ? thumbnailIdentityToken(item.thumbnailSrc) : null,
            state: String(item.state || "").slice(0, 100),
          })),
        }));
        throw new Error(`First-row baseline requires unique, stable media UUIDs/keys (tiles=${initialScan.items.length}, UUIDs=${baselineUuids.length}, sample=${baselineUuids.slice(0, 6).join(",") || "none"}).`);
      }
      args._waitInitialBalance = initialBalance;
      args._waitInitialItemKeys = initialItems;
      args._waitInitialItemTexts = initialScan.items.slice(0, 3).map(item => String(item.text || "").replace(/\s+/g, " ").trim());
      args._waitInitialDomTileCount = await chosen.page.locator(selectors.generated_video_items).count();
      // Capture visible DOM thumbnail tokens, rejecting /image/<uuid> placeholders.
      // A verified video UUID may fill a missing token only when its same-position
      // row text is unique and unchanged in both the inventory and visible DOM.
      const domThumbnailBaseline = await chosen.page.locator(selectors.generated_video_items).evaluateAll(elements => ({
        tileCount: elements.length,
        texts: elements.slice(0, 3).map(element => String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim()),
        // Keep the thumbnail image UUID as a separate alias. It is not the video
        // UUID, but Flow may expose this same image UUID as the tile's only token
        // during the immediate pre-Create snapshot.
        imageTokens: elements.slice(0, 3).map(element => {
          const source = element.querySelector("img")?.getAttribute("src") || "";
          const match = source.match(/\/image\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
          return match ? `image:${match[1].toLowerCase()}` : null;
        }),
        tokens: elements.slice(0, 3).map(element => {
          const dataValues = [
            element.getAttribute("data-media-id"),
            element.getAttribute("data-asset-id"),
            element.getAttribute("data-uuid"),
            element.getAttribute("data-id"),
            ...Array.from(element.querySelectorAll("[data-media-id], [data-asset-id], [data-uuid], [data-id]"))
              .flatMap(node => ["data-media-id", "data-asset-id", "data-uuid", "data-id"]
                .map(name => node.getAttribute(name))),
          ].filter(Boolean).map(String);
          for (const value of dataValues) {
            const uuid = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (uuid) return `media:${uuid[0].toLowerCase()}`;
          }
          const routeHrefs = Array.from(element.querySelectorAll('a[href*="/edit/"], a[href*="/video/"]'))
            .map(anchor => anchor.getAttribute("href")).filter(Boolean)
            .sort((a, b) => Number(/\/edit\//i.test(b)) - Number(/\/edit\//i.test(a)));
          const ownHref = element.getAttribute("href");
          if (ownHref && (ownHref.includes("/edit/") || ownHref.includes("/video/"))) {
            if (/\/edit\//i.test(ownHref)) routeHrefs.unshift(ownHref);
            else routeHrefs.push(ownHref);
          }
          for (const href of routeHrefs) {
            const parts = String(href).split("/").filter(Boolean);
            const routeIndex = parts.findIndex(part => part === "edit" || part === "video");
            const routeUuid = routeIndex >= 0 ? parts[routeIndex + 1] : null;
            if (routeUuid && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(routeUuid)) {
              return `media:${routeUuid.toLowerCase()}`;
            }
          }
          // Virtualized Flow tiles may swap img for video during playback.
          // Resolve thumbnail identity from img/video src, nested source, or poster.
          const sources = [
            element.querySelector("img")?.getAttribute("src"),
            element.querySelector("video")?.getAttribute("src"),
            element.querySelector("video source")?.getAttribute("src"),
            element.querySelector("video")?.getAttribute("poster"),
            element.querySelector("source")?.getAttribute("src"),
            element.querySelector("img")?.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0],
          ].filter(Boolean);
          if (!sources.length) {
            const tileText = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
            if (/\bfailed\b/i.test(tileText)
              && /prominent people/i.test(tileText)
              && /might violate our policies/i.test(tileText)
              && /you will be refunded/i.test(tileText)) {
              return "failed-policy:" + tileText.toLowerCase();
            }
            return null;
          }
          let source = sources[0];
          let pathname = "";
          let segments = [];
          let assetIndex = -1;
          for (const candidate of sources) {
            let candidatePath = candidate;
            try { candidatePath = new URL(candidate, location.href).pathname; } catch {}
            const candidateSegments = candidatePath.split("/").filter(Boolean);
            const candidateAssetIndex = candidateSegments.findIndex(part => part === "image" || part === "asb" || part === "video");
            if (candidateAssetIndex >= 0 && candidateSegments[candidateAssetIndex + 1]) {
              source = candidate;
              pathname = candidatePath;
              segments = candidateSegments;
              assetIndex = candidateAssetIndex;
              if (candidateSegments[candidateAssetIndex] === "asb") break;
            }
          }
          if (!pathname) {
            try { pathname = new URL(source, location.href).pathname; }
            catch { return source.split(/[?#]/, 1)[0] || null; }
          }
          if (!segments.length) segments = pathname.split("/").filter(Boolean);
          assetIndex = segments.findIndex(part => part === "image" || part === "asb" || part === "video");
          if (assetIndex < 0 || !segments[assetIndex + 1]) {
            try { return new URL(source, location.href).pathname; }
            catch { return source.split(/[?#]/, 1)[0] || null; }
          }
          const token = segments[assetIndex + 1];
          // /image/<uuid> is an image-resource ID, never the generated video's ID.
          if (segments[assetIndex] === "image") return null;
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
            return `media:${token.toLowerCase()}`;
          }
          return segments[assetIndex] === "asb" ? `asb:${token.split("=", 1)[0]}` : pathname;
        }),
      })).catch(() => ({ tileCount: 0, tokens: [] }));
      const baselineTokensWithUuidFallback = buildVerifiedThumbnailBaselineTokens(
        domThumbnailBaseline.tokens, initialScan.items, domThumbnailBaseline.texts, verifiedUuidThumbnailIndexes,
      );
      args._waitInitialThumbnailTokens = baselineTokensWithUuidFallback;
      args._waitInitialThumbnailImageTokens = domThumbnailBaseline.imageTokens || [];
      // Preserve the exact ASB thumbnail token that was observed while the tile's
      // generated-video UUID was independently verified. The pre-Create DOM reader
      // may expose that same ASB token but no media UUID after composer interaction.
      // Only these verified UUID-to-thumbnail aliases can bridge media:UUID to asb:token.
      args._waitInitialVerifiedThumbnailAliases = initialScan.items.slice(0, 3).map((item, index) => {
        if (!item?.mediaUuid || !verifiedUuidThumbnailIndexes.has(index)) return null;
        // Prefer the tile's own captured thumbnail URL, but also consult the final
        // first-row DOM snapshot. A UUID may only become verified on retry 2, while
        // its ASB URL is present in the DOM snapshot rather than item.thumbnailSrc.
        // This alias is safe only because the same row index was independently
        // verified against the refreshed unique media-UUID inventory.
        const candidates = [verifiedAsbAliasesByIndex.get(index), item.thumbnailSrc, domThumbnailBaseline.tokens?.[index]];
        for (const candidate of candidates) {
          if (!candidate) continue;
          const token = thumbnailIdentityToken(candidate);
          if (token?.startsWith("asb:")) return token;
        }
        return null;
      });
      if (domThumbnailBaseline.tileCount < 3 || args._waitInitialThumbnailTokens.length < 3
        || args._waitInitialThumbnailTokens.slice(0, 3).some(token => !token)) {
        throw new Error(`First-row baseline requires loaded DOM thumbnail identities for all three tiles; observed tile count=${domThumbnailBaseline.tileCount}, tokens=${JSON.stringify(args._waitInitialThumbnailTokens)}.`);
      }
      console.log(JSON.stringify({ event: "baseline_dom_thumbnail_identity", tile_count: domThumbnailBaseline.tileCount,
        first_three_tokens: args._waitInitialThumbnailTokens.slice(0, 3),
        verified_asb_thumbnail_aliases: args._waitInitialVerifiedThumbnailAliases,
        identity_sources: args._waitInitialThumbnailTokens.slice(0, 3).map((token, index) =>
          verifiedUuidThumbnailIndexes.has(index) && !domThumbnailBaseline.tokens[index] ? "verified_video_uuid" : "dom_thumbnail"),
        identity_source: verifiedUuidThumbnailIndexes.size ? "verified_video_uuid_with_dom_thumbnail_fallback" : "same_precreate_dom_precedence" }));
      args._waitUuidCache = baselineUuidCache;
      args._waitInitialItemCount = initialItems.length - failedBaselineItems.length;
      console.log(args.waitForResult
        ? "WAIT SELECTOR PREFLIGHT (read-only; no Create click; Videos tab selected when available; visible first row only; Failed tiles retained only as baseline UUIDs)"
        : "DRY-RUN MEDIA BASELINE (read-only; no Create click; Videos tab selected when available; visible first row only; no full-grid sweep)");
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
      console.log(JSON.stringify({ event: "wait_preflight_phase_timing", phase: "baseline_validation", elapsed_ms: Date.now() - baselineValidationStartedAt, tile_count: initialScan.items.length, uuid_count: baselineUuids.length }));
      console.log(JSON.stringify({ event: "wait_preflight_total_timing", elapsed_ms: Date.now() - waitPreflightStartedAt, outcome: "success" }));
      console.log(`Phase timing: wait selector preflight completed in ${Date.now() - waitPreflightStartedAt}ms.`);
    } catch (error) {
      console.log(JSON.stringify({ event: "wait_preflight_total_timing", elapsed_ms: Date.now() - waitPreflightStartedAt, outcome: "failure", error: String(error?.message || error).slice(0, 400) }));
      // The outer pre-submit failure handler owns cleanup and emits the only
      // authoritative success/failure message after verifying the actual state.
      throw new Error(`Wait selector preflight failed: ${error.message}`);
    }
  }

  const referenceUploadStartedAt = Date.now();
  console.log(`Phase timing: reference upload started (${referenceImages.length} image(s)); asset-ready timeout=${ASSET_READY_TIMEOUT_MS}ms per image.`);
  const attachedReferenceUuids = await uploadSceneReferences(chosen.page, selectors, referenceImages, prompt, referenceAssetUuids);
  console.log(`Phase timing: reference upload completed in ${Date.now() - referenceUploadStartedAt}ms.`);
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
      // Read-only pre-Create recheck: do not open tiles or resolve UUIDs again.
      // The Ingredients/prompt UI can change the visible grid; re-opening a tile can
      // also discard attached chips. Compare the first thumbnail token to the baseline.
      const expectedFirstToken = args._waitInitialThumbnailTokens?.[0];
      if (!expectedFirstToken) throw new Error("Pre-Create baseline has no first-tile thumbnail token; refusing to click Create.");
      const preCreateSnapshot = await waitForPreCreateThumbnailSnapshot(async () => {
        return chosen.page.locator(selectors.generated_video_items).evaluateAll((elements, baseline) => ({
          tileCount: elements.length,
          mediaKeys: elements.slice(0, 3).map((element, tileIndex) => {
            const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
            const dataValues = [
              element.getAttribute("data-media-id"), element.getAttribute("data-asset-id"),
              element.getAttribute("data-uuid"), element.getAttribute("data-id"),
              ...Array.from(element.querySelectorAll("[data-media-id], [data-asset-id], [data-uuid], [data-id]"))
                .flatMap(node => ["data-media-id", "data-asset-id", "data-uuid", "data-id"].map(name => node.getAttribute(name))),
            ].filter(Boolean).map(String);
            for (const value of dataValues) {
              const match = value.match(uuidPattern);
              if (match) return `media:${match[0].toLowerCase()}`;
            }
            const hrefs = Array.from(element.querySelectorAll('a[href*="/edit/"], a[href*="/video/"]'))
              .map(anchor => anchor.getAttribute("href")).filter(Boolean);
            const ownHref = element.getAttribute("href");
            if (ownHref && /\/(?:edit|video)\//i.test(ownHref)) hrefs.unshift(ownHref);
            for (const href of hrefs) {
              const match = String(href).match(/\/(?:edit|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
              if (match) return `media:${match[1].toLowerCase()}`;
            }
            const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
            const currentText = normalize(element.innerText || element.textContent || "");
            const texts = elements.slice(0, 3).map(node => normalize(node.innerText || node.textContent || ""));
            const baselineText = normalize(baseline?.texts?.[tileIndex]);
            const baselineKey = String(baseline?.keys?.[tileIndex] || "");
            const uuid = baselineKey.match(/^media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
            const isPolicyRefusal = /prominent people/i.test(currentText)
              && /might violate our policies/i.test(currentText)
              && /you will be refunded/i.test(currentText)
              && /\bfailed\b/i.test(currentText);
            const sameUniqueText = currentText && currentText === baselineText
              && texts.filter(value => value === currentText).length === 1
              && Array.isArray(baseline?.texts)
              && baseline.texts.filter(value => normalize(value) === currentText).length === 1;
            if (uuid && sameUniqueText) return `media:${uuid.toLowerCase()}`;
            if (baselineKey.startsWith("failed-policy:") && isPolicyRefusal && sameUniqueText) return baselineKey;
            return null;
          }),
          tokens: elements.slice(0, 3).map((element, tileIndex) => {
            // Prefer the tile's own media/edit URL or data ID; thumbnail src is
            // only a fallback because Flow can rotate /image/<uuid> to /asb/<token>.
            const dataValues = [
              element.getAttribute("data-media-id"),
              element.getAttribute("data-asset-id"),
              element.getAttribute("data-uuid"),
              element.getAttribute("data-id"),
              ...Array.from(element.querySelectorAll("[data-media-id], [data-asset-id], [data-uuid], [data-id]"))
                .flatMap(node => ["data-media-id", "data-asset-id", "data-uuid", "data-id"]
                  .map(name => node.getAttribute(name))),
            ].filter(Boolean).map(String);
            for (const value of dataValues) {
              const uuid = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
              if (uuid) return `media:${uuid[0].toLowerCase()}`;
            }
            const routeHrefs = Array.from(element.querySelectorAll('a[href*="/edit/"], a[href*="/video/"]'))
              .map(anchor => anchor.getAttribute("href")).filter(Boolean);
            const ownHref = element.getAttribute("href");
            if (ownHref && /\/(?:edit|video)\//i.test(ownHref)) routeHrefs.unshift(ownHref);
            for (const href of routeHrefs) {
              const routeUuid = String(href).match(/\/(?:edit|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
              if (routeUuid) return `media:${routeUuid[1].toLowerCase()}`;
            }
            const normalize = value => String(value || "").replace(/\s+/g, " ").trim();
            const currentText = normalize(element.innerText || element.textContent || "");
            const texts = elements.slice(0, 3).map(node => normalize(node.innerText || node.textContent || ""));
            const baselineText = normalize(baseline?.texts?.[tileIndex]);
            const baselineKey = String(baseline?.keys?.[tileIndex] || "");
            const uuid = baselineKey.match(/^media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
            // DOM scope may differ from the inventory sweep. Match by unique
            // same-position text, not total DOM count.
            if (uuid && currentText && currentText === baselineText
              && texts.filter(value => value === currentText).length === 1
              && Array.isArray(baseline?.texts)
              && baseline.texts.filter(value => normalize(value) === currentText).length === 1) return `media:${uuid.toLowerCase()}`;
            const isPolicyRefusal = /prominent people/i.test(currentText)
              && /might violate our policies/i.test(currentText)
              && /you will be refunded/i.test(currentText)
              && /\bfailed\b/i.test(currentText);
            if (baselineKey.startsWith("failed-policy:") && isPolicyRefusal
              && currentText === baselineText
              && texts.filter(value => value === currentText).length === 1
              && Array.isArray(baseline?.texts)
              && baseline.texts.filter(value => normalize(value) === currentText).length === 1) return baselineKey;
            // Match baseline's img/video reader: playback may replace an img
            // with a video element while the composer is open.
            const sources = [
              element.querySelector("img")?.getAttribute("src"),
              element.querySelector("video")?.getAttribute("src"),
              element.querySelector("video source")?.getAttribute("src"),
              element.querySelector("video")?.getAttribute("poster"),
              element.querySelector("source")?.getAttribute("src"),
              element.querySelector("img")?.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0],
            ].filter(Boolean);
            for (const source of sources) {
              const imageUuid = source.match(/\/image\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i)
                || source.match(/\/asb\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i);
              if (imageUuid) return `media:${imageUuid[1].toLowerCase()}`;
              const asb = source.match(/\/asb\/([^/?#]+)/i);
              if (asb) return `asb:${asb[1].split("=", 1)[0]}`;
              try {
                const pathname = new URL(source, location.href).pathname;
                if (pathname && pathname !== "/") return pathname;
              } catch {}
              const fallback = source.split(/[?#]/, 1)[0];
              if (fallback) return fallback;
            }
            return null;
          }),
        }), { tileCount: args._waitInitialDomTileCount,
          texts: args._waitInitialItemTexts || [], keys: args._waitInitialItemKeys || [] })
          .catch(() => ({ tileCount: 0, mediaKeys: [], tokens: [] }));
      }, ms => chosen.page.waitForTimeout(ms), 10000);
      const currentTokens = preCreateSnapshot.tokens;
      const currentFirstToken = currentTokens[0] || null;
      const baselineTokens = args._waitInitialThumbnailTokens || [];
      const sameFirstTileAfterThumbnailRotation = firstTileMatchesByStableNeighbors({
        expectedToken: expectedFirstToken, currentToken: currentFirstToken, baselineTokens, currentTokens,
        baselineTileCount: args._waitInitialDomTileCount, currentTileCount: preCreateSnapshot.tileCount,
      });
      // Do not open any media tile after prompt/references are attached: Flow
      // discards the composer when returning from an editor route. UUID resolution
      // already ran during wait-selector preflight, before attachment. At this stage
      // use only the read-only thumbnail/neighbor snapshot and preserve composer state.
      const baselineMediaKeys = args._waitInitialItemKeys || [];
      const currentMediaKeys = Array.isArray(preCreateSnapshot.mediaKeys) ? preCreateSnapshot.mediaKeys : [];
      const sameFirstRowMediaIdentity = firstThreeMediaKeysMatch(baselineMediaKeys, currentMediaKeys);
      // UUID-confirmed row identity can override a different virtualized DOM count
      // and a lazy third thumbnail, but never an absent/mismatched UUID.
      const sameFirstThreeThumbnailTokens = firstThreeThumbnailTokensMatch(
        baselineTokens, currentTokens, args._waitInitialThumbnailImageTokens || [],
        args._waitInitialVerifiedThumbnailAliases || [],
      );
      const stableCurrentGrid = preCreateSnapshot.fullyStable || preCreateSnapshot.acceptedByNeighborRule
        || (preCreateSnapshot.stableFirstToken && preCreateSnapshot.tileCount >= 3 && sameFirstRowMediaIdentity)
        || (preCreateSnapshot.stableFirstToken && preCreateSnapshot.tileCount >= 3 && sameFirstThreeThumbnailTokens);
      console.log(JSON.stringify({
        event: "pre_create_first_tile_identity_recheck",
        expected_first_thumbnail_token: expectedFirstToken,
        current_first_thumbnail_token: currentFirstToken,
        visible_first_three_thumbnail_tokens: currentTokens,
        baseline_first_three_thumbnail_image_tokens: (args._waitInitialThumbnailImageTokens || []).slice(0, 3),
        visible_tile_count: preCreateSnapshot.tileCount,
        stable_first_token: preCreateSnapshot.stableFirstToken || preCreateSnapshot.fullyStable,
        accepted_by_neighbor_rule: preCreateSnapshot.acceptedByNeighborRule,
        accepted_by_media_uuid_neighbor_identity: sameFirstRowMediaIdentity,
        accepted_by_thumbnail_row_identity: sameFirstThreeThumbnailTokens,
        baseline_first_three_media_keys: baselineMediaKeys.slice(0, 3),
        current_first_three_media_keys: currentMediaKeys.slice(0, 3),
        baseline_dom_tile_count: args._waitInitialDomTileCount,
        wait_ms: preCreateSnapshot.waitMs,
        read_only_dom_check: true,
      }, null, 2));
      if (!stableCurrentGrid || preCreateSnapshot.tileCount < 3 || !currentFirstToken) {
        throw new Error(`Pre-Create recheck could not confirm a stable first tile and three-tile row (observed ${preCreateSnapshot.tileCount}); refusing to click Create.`);
      }
      if (!sameFirstThreeThumbnailTokens && !sameFirstTileAfterThumbnailRotation && !sameFirstRowMediaIdentity) {
        throw new Error("Pre-Create first tile identity differs from the validated baseline; stable-neighbor identity check did not confirm a thumbnail-only change. Refusing to click Create.");
      }
      args._waitInitialItemCount = args._waitInitialItemKeys.length;
      console.log(sameFirstTileAfterThumbnailRotation || sameFirstRowMediaIdentity
        ? `Pre-Create first tile passed stable-neighbor identity check; preserving ${args._waitInitialItemKeys.length} baseline UUIDs.`
        : `Pre-Create first tile token matches baseline; preserving ${args._waitInitialItemKeys.length} baseline UUIDs.`);
    }
    args._waitCreateClickedAt = new Date().toISOString();
    console.log(`Pre-Create baseline UUID count: ${args._waitInitialItemKeys?.length ?? 0}. Create timestamp: ${args._waitCreateClickedAt}`);
    try {
      await finalButton.click({ timeout: 2500 });
      createMayHaveBeenClicked = true;
    } catch (clickError) {
      // A Playwright actionability timeout while disabled means no click was dispatched.
      const message = String(clickError?.message || clickError);
      const disabledBeforeDispatch = /waiting for element to be enabled|element is not enabled|button.*disabled|disabled.*button/i.test(message);
      if (disabledBeforeDispatch) {
        createMayHaveBeenClicked = false;
        appendEvent(args.log, { event: "create_click_blocked_disabled", scene_id: scene.scene_id,
          status: "not_submitted", error: message });
      } else {
        createMayHaveBeenClicked = true; // Other click errors can be ambiguous.
      }
      throw clickError;
    }
    appendEvent(args.log, { event: "create_click_returned", scene_id: scene.scene_id, model: scene.model,
      resolution: scene.resolution, status: "click_returned_unconfirmed",
      note: "The UI click returned; this is not proof that Flow accepted a generation." });
    console.log(`Create click returned once; submission is NOT confirmed until a new media UUID or credit decrease is observed. Receipt: ${path.resolve(args.log)}`);
    if (args.waitForResult) {
      let resultStatus = "unknown";
      let mediaUri = chosen.page.url();
      let downloadedFile = null;
      let downloadError = null;
      let actualResolution = null;
      let downloadQualityLabel = null;
      let timeoutError = null;
      let afterBalance = null;
      let submissionEvidence = false;
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
          initialFailedTileTexts: args._waitInitialFailedTileTexts || [],
          timeoutScreenshot: `${screenshot}.wait-timeout.png`,
          onSubmissionEvidence: evidence => {
            submissionEvidence = true;
            appendEvent(args.log, { event: "submission_confirmed_by_new_media_uuid", scene_id: scene.scene_id, evidence });
          },
          variantIndex,
          variantCount,
        });
        downloadedFile = result.downloadedFile;
        mediaUri = result.mediaUri || chosen.page.url();
        downloadError = result.downloadError;
        actualResolution = result.actualResolution || null;
        downloadQualityLabel = result.downloadQualityLabel || null;
        var verifiedMediaUuid = result.verifiedMediaUuid || null;
        var verificationState = result.verificationState || "unverified";
        var verificationEvidence = result.verificationEvidence || null;
        resultStatus = downloadError ? "download_failed" : "succeeded";
      } catch (error) {
        timeoutError = String(error.message || error);
        mediaUri = chosen.page.url();
        if (timeoutError.startsWith("FLOW_REJECTED_UNUSUAL_ACTIVITY:")) resultStatus = "rejected_unusual_activity";
        else if (timeoutError.startsWith("FLOW_GENERATION_FAILED:")) resultStatus = "failed";
        else if (timeoutError.startsWith("FLOW_SUBMITTED_UNIDENTIFIED:")) resultStatus = "submitted_unidentified";
        appendEvent(args.log, {
          event: resultStatus === "rejected_unusual_activity" ? "flow_rejected_unusual_activity"
            : resultStatus === "failed" ? "generation_failed_detected"
              : resultStatus === "submitted_unidentified" ? "submitted_unidentified" : "generation_wait_unverified",
          scene_id: scene.scene_id,
          status: resultStatus === "rejected_unusual_activity" ? "FLOW_REJECTED_UNUSUAL_ACTIVITY_DO_NOT_RETRY"
            : resultStatus === "failed" ? "failed_do_not_retry"
              : resultStatus === "submitted_unidentified" ? "submitted_unidentified_do_not_retry" : "unknown_do_not_retry",
          error: timeoutError,
        });
        console.error(`WAIT STOPPED SAFELY: ${timeoutError}`);
      }
      // Detail pages do not expose credits; return to the original project before polling.
      if (chosen.page.url() !== originalUrl) {
        await chosen.page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      }
      // A confirmed provider failure needs one balance snapshot for the ledger, not
      // another 30-second submission-evidence poll. Keep polling only ambiguous outcomes.
      if (["failed", "rejected_unusual_activity"].includes(resultStatus)) {
        try { afterBalance = await readCreditBalance(chosen.page, selectors); } catch {}
      } else {
        const balanceDeadline = Date.now() + 30000;
        do {
          try { afterBalance = await readCreditBalance(chosen.page, selectors); } catch {}
          if (afterBalance !== null && args._waitInitialBalance !== null && afterBalance < args._waitInitialBalance) {
            submissionEvidence = true;
            appendEvent(args.log, { event: "submission_confirmed_by_credit_decrease", scene_id: scene.scene_id,
              before_balance: args._waitInitialBalance, after_balance: afterBalance });
            break;
          }
          await chosen.page.waitForTimeout(1000);
        } while (Date.now() < balanceDeadline);
      }
      if (!submissionEvidence && !["failed", "rejected_unusual_activity"].includes(resultStatus)) {
        resultStatus = "create_not_confirmed";
        args._stopVariants = true;
        timeoutError = "CREATE_NOT_CONFIRMED: No new media UUID and no credit decrease were observed after Create; do not resubmit automatically without manual inspection.";
        appendEvent(args.log, { event: "create_not_confirmed", scene_id: scene.scene_id,
          status: "create_not_confirmed_do_not_retry", before_balance: args._waitInitialBalance, after_balance: afterBalance });
        console.error(`CREATE NOT CONFIRMED: ${timeoutError}`);
      }
      const ledgerRecord = makeGenerationLedgerRecord({
        scene, projectId: chosen.projectId, ledgerProjectId: args.ledgerProjectId, prompt: scene.prompt, estimatedCost: creditCost,
        beforeBalance: args._waitInitialBalance ?? null, afterBalance,
        resultStatus, mediaUri, downloadedFile, downloadError, timeoutError, actualResolution, downloadQualityLabel,
        verifiedMediaUuid: typeof verifiedMediaUuid === "undefined" ? null : verifiedMediaUuid,
        verificationState: typeof verificationState === "undefined" ? "unverified" : verificationState,
        verificationEvidence: typeof verificationEvidence === "undefined" ? null : verificationEvidence,
        attemptNumber, attemptId: args._waitAttemptId, startedOn: args._waitStartedOn,
        variantIndex, variantCount,
      });
      try {
        const ledgerPath = appendGenerationLedger(args.ledgerOutput, ledgerRecord);
        appendEvent(args.log, { event: "generation_ledger_recorded", scene_id: scene.scene_id, attempt_id: ledgerRecord.attempt_id, status: ledgerRecord.result.status, ledger_path: ledgerPath, before_balance: ledgerRecord.credits.before_balance, after_balance: ledgerRecord.credits.after_balance, actual_amount: ledgerRecord.credits.actual_amount, charge_status: ledgerRecord.credits.charge_status, media_uri: ledgerRecord.media.uri, downloaded_file: ledgerRecord.media.downloaded_file });
        console.log(`Generation ledger appended: ${ledgerPath}`);
        if (resultStatus === "create_not_confirmed") process.exitCode = 2;
      } catch (error) {
        appendEvent(args.log, { event: "generation_ledger_write_failed", scene_id: scene.scene_id, error: String(error) });
        console.error(`CRITICAL: generation completed/unknown but ledger write failed: ${error.message}`);
        process.exitCode = 2;
      }
      if (resultStatus === "succeeded") {
        console.log(`Generation result verified. Media URI: ${mediaUri}`);
        if (downloadedFile) console.log(`Downloaded clip: ${downloadedFile}`);
      } else if (resultStatus === "download_failed") {
        console.error(`New video UUID verified, but download failed; ledger status is download_failed: ${downloadError}`);
        process.exitCode = 2;
        args._stopVariants = true;
        return;
      } else if (resultStatus === "submitted_unidentified") {
        console.error("Create was submitted, but no new media UUID could be identified before timeout. Receipt and ledger recorded; do NOT resubmit automatically.");
        process.exitCode = 2;
        if (variantCount > 1) args._stopVariants = true;
      } else if (resultStatus === "rejected_unusual_activity") {
        console.error("FLOW_REJECTED_UNUSUAL_ACTIVITY: Flow rejected this submission. The distinct status was recorded in the ledger; do not retry automatically or bypass anti-abuse checks.");
        args._stopVariants = true;
        process.exitCode = 2;
        return;
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
    if (!createMayHaveBeenClicked) {
      appendEvent(args.log, { event: "submission_aborted_before_create", scene_id: scene.scene_id,
        status: "not_submitted", error: String(error) });
      console.error("No generation was submitted. Create was not clicked; safe to correct the preflight issue before trying again.");
    } else {
      appendEvent(args.log, { event: "submission_outcome_unknown", scene_id: scene.scene_id,
        status: "unknown_do_not_retry", error: String(error) });
      console.error("Submission outcome is unknown. Do NOT click again or retry automatically. Inspect Flow manually.");
    }
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


function readRecoveryEvidence(logPath, attemptId) {
  const absolute = path.resolve(logPath);
  if (!fs.existsSync(absolute)) throw new Error(\`Recovery log not found: \${absolute}\`);
  const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
  let ledgerEventIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.event === "generation_ledger_recorded" && event.attempt_id === attemptId) ledgerEventIndex = i;
    } catch {}
  }
  if (ledgerEventIndex < 0) throw new Error(\`Recovery log does not contain generation_ledger_recorded for \${attemptId}; refusing to infer which Create belongs to this ledger attempt.\`);
  let createClickedAt = null;
  let createLineIndex = -1;
  for (let i = 0; i < ledgerEventIndex; i += 1) {
    const match = lines[i].match(/Create timestamp:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/);
    if (match) { createClickedAt = match[1]; createLineIndex = i; }
  }
  if (!createClickedAt) throw new Error("Recovery log is missing the recorded Create timestamp; refusing recovery.");
  let baselineSummary = null, baselineClassification = null;
  for (let i = 0; i < createLineIndex; i += 1) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.event === "baseline_media_inventory_summary") baselineSummary = event;
      if (event.event === "baseline_unresolved_tile_classification") baselineClassification = event;
    } catch {}
  }
  if (!baselineSummary || !Array.isArray(baselineSummary.baseline_media_uuids) || !baselineClassification
    || !Array.isArray(baselineClassification.tiles)) {
    throw new Error("Recovery log lacks complete ordered baseline UUIDs plus non-media tile classification; refusing recovery.");
  }
  const uuids = baselineSummary.baseline_media_uuids.map(value => String(value).toLowerCase());
  let uuidIndex = 0;
  const beforeKeys = baselineClassification.tiles.slice(0, 3).map(tile => {
    if (tile.classification === "known_policy_refusal_non_media_baseline") {
      const text = String(tile.text || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!/prominent people/.test(text) || !/might violate our policies/.test(text) || !/you will be refunded/.test(text)) {
        throw new Error("Recovery baseline policy tile text is not a complete recognized refusal identity; refusing recovery.");
      }
      return "failed-policy:" + text;
    }
    if (tile.classification !== "stable_existing_baseline_tile" || !uuids[uuidIndex]) {
      throw new Error("Recovery baseline first row contains an unsupported or unresolved tile identity; refusing recovery.");
    }
    return "media:" + uuids[uuidIndex++];
  });
  if (beforeKeys.length !== 3 || new Set(beforeKeys).size !== 3) {
    throw new Error("Recovery requires three unique ordered first-row baseline identities.");
  }
  return { createClickedAt, beforeKeys,
    initialFailedTileTexts: beforeKeys.filter(key => key.startsWith("failed-policy:")).map(key => key.slice("failed-policy:".length)) };
}

function updateGenerationLedgerAttempt(pathname, attemptId, update) {
  const absolute = path.resolve(pathname);
  if (!fs.existsSync(absolute)) throw new Error(\`Generation ledger not found: \${absolute}\`);
  const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
  let matches = 0;
  const updated = lines.map(line => {
    if (!line.trim()) return line;
    let record;
    try { record = JSON.parse(line); } catch { return line; }
    if (record.attempt_id !== attemptId) return line;
    matches += 1;
    return JSON.stringify(update(record));
  });
  if (matches !== 1) throw new Error(\`Expected exactly one ledger record for \${attemptId}; found \${matches}. No ledger changes written.\`);
  const temp = absolute + ".recover-tmp";
  fs.writeFileSync(temp, updated.join("\n"), "utf8");
  fs.renameSync(temp, absolute);
  return absolute;
}

async function recoverAttempt(args, browser) {
  if (!args.scene || !args.selectors || args.tab === null || !args.expectedEmail || !args.expectedProject || !args.accountLabel) {
    throw new Error("--recover-attempt requires --tab, --scene, --selectors, --account-label, --expected-email, and --expected-project.");
  }
  const ledgerPath = path.resolve(args.ledgerOutput);
  if (!fs.existsSync(ledgerPath)) throw new Error(\`Generation ledger not found: \${ledgerPath}\`);
  const records = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const matches = records.filter(record => record.attempt_id === args.recoverAttempt);
  if (matches.length !== 1) throw new Error(\`Expected exactly one ledger attempt \${args.recoverAttempt}; found \${matches.length}.\`);
  const record = matches[0];
  if (record.result?.status !== "submitted_unidentified" || record.media?.verification_state !== "unverified"
    || record.media?.verified_media_uuid || !(Number(record.credits?.actual_amount) > 0)) {
    throw new Error("Recovery is limited to a charged submitted_unidentified attempt with no verified UUID; ledger state does not qualify.");
  }
  const { scene, selectors } = await loadInputs(args);
  if (scene.scene_id !== record.scene_id) throw new Error(\`Scene mismatch: supplied \${scene.scene_id}, ledger \${record.scene_id}. Refusing recovery.\`);
  const evidence = readRecoveryEvidence(args.log, args.recoverAttempt);
  waitForSelectors(selectors, { ...args, waitForResult: true });
  const chosen = await chooseFlowTab(browser, args);
  if (chosen.projectId !== args.expectedProject || (record.project_id && record.project_id !== args.expectedProject)) {
    throw new Error("Recovery project identity does not match the expected project and ledger.");
  }
  const account = await verifyAccount(chosen.page, selectors, args.expectedEmail);
  console.log(JSON.stringify({ event: "recovery_preflight_passed", attempt_id: args.recoverAttempt,
    project_id: chosen.projectId, account_email: account.observedEmail, create_clicked_at: evidence.createClickedAt,
    baseline_keys: evidence.beforeKeys, mode: "no_create_recovery" }));
  await activateVideosTab(chosen.page, selectors);
  const result = await waitForGenerationAndDownload(chosen.page, selectors, {
    beforeKeys: evidence.beforeKeys, beforeBalance: record.credits.before_balance,
    createClickedAt: evidence.createClickedAt, uuidCache: new Map(), timeoutMs: args.waitTimeoutMs,
    downloadDir: args.downloadDir, sceneId: record.scene_id, attemptId: args.recoverAttempt,
    timeoutScreenshot: args.screenshot || \`\${args.log}.recover-timeout.png\`,
    initialFailedTileTexts: evidence.initialFailedTileTexts,
    onSubmissionEvidence: item => appendEvent(args.log, { event: "recovery_submission_evidence", attempt_id: args.recoverAttempt, evidence: item }),
    variantIndex: record.variant_index || 1, variantCount: record.variant_count || 1,
  });
  const status = result.downloadError ? "download_failed" : "succeeded";
  const updatedPath = updateGenerationLedgerAttempt(args.ledgerOutput, args.recoverAttempt, current => {
    current.finished_on = new Date().toISOString();
    current.result = { ...(current.result || {}), status };
    current.media = { ...(current.media || {}),
      uri: result.mediaUri || current.media?.uri || null,
      verification_state: result.verificationState || "unverified",
      verified_media_uuid: result.verifiedMediaUuid || null,
      verification_evidence: result.verificationEvidence || null,
      downloaded_file: result.downloadedFile || null,
      download_quality_label: result.downloadQualityLabel || null,
      actual_resolution: result.actualResolution || null,
      resolution_match_status: (() => {
        const requested = String(current.configuration?.resolution || "").match(/\b(\d{2,5})p\b/i);
        const actual = String(result.actualResolution || "").match(/^(\d{2,5})x(\d{2,5})$/i);
        if (!requested || !actual) return "unknown";
        return Number(actual[1]) === Number(requested[1]) || Number(actual[2]) === Number(requested[1]) ? "match" : "mismatch";
      })(),
      sha256: result.downloadedFile && fs.existsSync(result.downloadedFile) ? createHash("sha256").update(fs.readFileSync(result.downloadedFile)).digest("hex") : null,
      integrity_status: result.downloadedFile ? "verified" : "not_checked",
    };
    const note = result.downloadError ? \`Recovery verified UUID but download failed: \${result.downloadError}\` : \`Recovered media UUID \${result.verifiedMediaUuid} without a new Create click.\`;
    current.notes = [current.notes, note].filter(Boolean).join(" ");
    return current;
  });
  appendEvent(args.log, { event: "recovery_ledger_updated", attempt_id: args.recoverAttempt, status,
    verified_media_uuid: result.verifiedMediaUuid, downloaded_file: result.downloadedFile || null, ledger_path: updatedPath });
  console.log(JSON.stringify({ event: "recovery_complete", attempt_id: args.recoverAttempt, status,
    verified_media_uuid: result.verifiedMediaUuid, downloaded_file: result.downloadedFile || null,
    download_error: result.downloadError || null, credits_spent_by_recovery: 0, create_clicks_by_recovery: 0 }));
  if (status !== "succeeded") process.exitCode = 2;
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
  if (args.recoverAttempt) {
    try { await recoverAttempt(args, browser); }
    finally { await browser.close(); }
    return;
  }
  const rl = createConfirmationReader();
  try {
    let variantCount = 1;
    if (args.scene) {
      const inputScene = JSON.parse(fs.readFileSync(path.resolve(args.scene), "utf8"));
      variantCount = inputScene.variants === undefined ? 2 : inputScene.variants;
      if (!Number.isInteger(variantCount) || variantCount < 1 || variantCount > 3) throw new Error("variants must be an integer from 1 to 3.");
    }
    args._variantCount = variantCount;
    if (args.variantIndex !== null && args.variantIndex > variantCount) {
      throw new Error(`--variant-index ${args.variantIndex} exceeds this job's variant count (${variantCount}).`);
    }
    if (args.execute && variantCount > 1 && !args.waitForResult) {
      throw new Error("Executing variants requires --wait so every submitted clip can be verified, downloaded, and recorded in the generation ledger.");
    }
    if (args.execute && variantCount > 1) {
      if (args.variantIndex !== null) {
        // Explicit single-variant execution avoids resubmitting variants already completed.
        args._variantIndex = args.variantIndex;
        console.log(`\\nPreparing selected variant ${args.variantIndex}/${variantCount} only.`);
        await prepare(args, browser, rl);
      } else {
        for (let index = 1; index <= variantCount; index += 1) {
          args._variantIndex = index;
          console.log(`\\nPreparing variant ${index}/${variantCount} for the same job and prompt.`);
          await prepare(args, browser, rl);
          if (args._stopVariants) break;
        }
      }
    } else {
      args._variantIndex = args.variantIndex || 1;
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
  // Playwright/CDP or Chromium background handles can keep Node alive after a
  // guarded pre-Create failure. All normal cleanup has already run through main's
  // finally block; force a non-zero exit so a safe-stop cannot hang indefinitely.
  process.exit(2);
});
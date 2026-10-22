#!/usr/bin/env node
/**
 * Summarize prominent-people policy refusals from the append-only JSONL ledger.
 * Usage: node scripts/summarize-policy-refusals.mjs path/to/ledger.jsonl
 * No network calls; compares reference-set fingerprints and exact prompt SHA-256.
 */
import fs from "node:fs";

const input = process.argv[2];
if (!input) {
  console.error("Usage: node scripts/summarize-policy-refusals.mjs path/to/ledger.jsonl");
  process.exit(2);
}
const rows = [];
for (const [index, line] of fs.readFileSync(input, "utf8").split(/\r?\n/).entries()) {
  if (!line.trim()) continue;
  let record;
  try { record = JSON.parse(line); }
  catch { console.warn(`Skipping malformed JSONL row ${index + 1}`); continue; }
  if (record.provider !== "google_flow") continue;
  const referenceSetKey = record.configuration?.reference_set_key;
  const promptHash = record.prompt?.sha256;
  if (!referenceSetKey || !promptHash) {
    console.warn(`Skipping row ${index + 1}: missing reference_set_key or prompt.sha256`);
    continue;
  }
  rows.push({
    attempt_id: record.attempt_id || null,
    reference_set_key: referenceSetKey,
    prompt_sha256: promptHash,
    result_status: record.result?.status || "unknown",
    is_prominent_people_refusal: record.result?.failure?.category === "provider_policy_prominent_people",
  });
}
function summarize(keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!groups.has(key)) groups.set(key, { key, submissions: 0, prominent_people_refusals: 0 });
    const group = groups.get(key);
    group.submissions += 1;
    if (row.is_prominent_people_refusal) group.prominent_people_refusals += 1;
  }
  return Array.from(groups.values()).map(group => ({
    ...group,
    refusal_rate: group.submissions ? group.prominent_people_refusals / group.submissions : 0,
  })).sort((a, b) => b.prominent_people_refusals - a.prominent_people_refusals || b.submissions - a.submissions);
}
const refusals = rows.filter(row => row.is_prominent_people_refusal).length;
console.log(JSON.stringify({
  ledger: input,
  scope: "Google Flow ledger entries with both reference_set_key and exact prompt SHA-256",
  total_submissions: rows.length,
  prominent_people_refusals: refusals,
  overall_refusal_rate: rows.length ? refusals / rows.length : 0,
  by_reference_set_and_prompt: summarize(row => `${row.reference_set_key}:${row.prompt_sha256}`),
  by_reference_set: summarize(row => row.reference_set_key),
  by_prompt_sha256: summarize(row => row.prompt_sha256),
}, null, 2));

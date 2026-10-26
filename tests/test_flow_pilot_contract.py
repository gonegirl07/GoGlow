"""Static safety contract checks for the human-gated Flow pilot runner."""
import re
import subprocess
import unittest
from pathlib import Path


class FlowPilotContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (Path(__file__).parents[1] / "scripts" / "flow-pilot.mjs").read_text(encoding="utf-8")
        cls.policy_stats_script = (Path(__file__).parents[1] / "scripts" / "summarize-policy-refusals.mjs").read_text(encoding="utf-8")

    def test_flow_pilot_script_passes_node_syntax_check(self):
        script_path = Path(__file__).parents[1] / "scripts" / "flow-pilot.mjs"
        result = subprocess.run(["node", "--check", str(script_path)], capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_uses_configured_local_cdp_and_only_reloads_the_current_flow_project_for_tile_lookup(self):
        self.assertIn('const CDP_ENDPOINT = "http://127.0.0.1:9224"', self.script)
        self.assertIn("chromium.connectOverCDP(CDP_ENDPOINT)", self.script)
        self.assertIn("await page.goto(gridUrl, { waitUntil: \"domcontentloaded\", timeout: 12000 }).catch(() => {});", self.script)
        self.assertNotIn('page.goto("http', self.script)

    def test_current_flow_project_urls_are_supported_and_404_is_rejected(self):
        self.assertIn('const FLOW_HOST = "flow.google.com"', self.script)
        self.assertIn('url.hostname !== FLOW_HOST', self.script)
        self.assertIn('url.pathname === "/404"', self.script)
        self.assertIn("PROJECT_PATH.exec(url.pathname)", self.script)
        self.assertIn("--expected-project", self.script)

    def test_dry_run_stops_before_create_and_execute_requires_second_confirmation(self):
        self.assertIn("if (!args.execute)", self.script)
        self.assertIn("DRY RUN COMPLETE: stopped before clicking Create", self.script)
        self.assertIn("CREATE ONE VIDEO FOR", self.script)
        self.assertIn('await finalButton.click({ timeout: 2500 })', self.script)

    def test_verifies_dom_email_not_just_operator_label(self):
        self.assertIn("--expected-email", self.script)
        self.assertIn('[role="button"][aria-label^="Google Account:"]', self.script)
        self.assertIn("Google account mismatch", self.script)
        self.assertIn("account_email_verified", self.script)

    def test_google_account_email_accepts_suffixes_and_newlines(self):
        # Mirror the JavaScript extraction pattern against the aria-label variants
        # reported by Google. The email is inside parentheses, not necessarily at end.
        self.assertIn(r"label.match(/\(([^()\s]+@[^()\s]+)\)/)", self.script)
        pattern = re.compile(r"\(([^()\s]+@[^()\s]+)\)")
        labels = [
            "Google Account: <name> (vudinhhuy11cdtm1@gmail.com), Google membership",
            "Google Account: <name> (vudinhhuy11cdtm1@gmail.com)\nGoogle membership",
            "Google Account: <name> (vudinhhuy11cdtm1@gmail.com)",
        ]
        for label in labels:
            with self.subTest(label=label):
                match = pattern.search(label)
                self.assertIsNotNone(match)
                self.assertEqual(match.group(1), "vudinhhuy11cdtm1@gmail.com")

    def test_waits_for_settings_model_selector_after_opening_settings(self):
        self.assertIn('chosen.page.locator(selectors.model).waitFor({ state: "visible", timeout: 5000 })', self.script)
        self.assertIn("Model selector did not become visible within 5000ms", self.script)

    def test_waits_for_model_option_after_opening_model_menu(self):
        self.assertIn('option.waitFor({ state: "visible", timeout: 8000 })', self.script)
        self.assertIn("Model option did not become stably visible within 8000ms", self.script)

    def test_dry_run_closes_readline_interface(self):
        self.assertIn("DRY RUN COMPLETE: stopped before clicking Create", self.script)
        self.assertIn("rl.close();", self.script)

    def test_waits_for_create_button_to_become_enabled(self):
        self.assertIn("waitForCreateEnabled(chosen.page, create, 5000)", self.script)
        self.assertIn("page.waitForFunction(element => element.isConnected", self.script)
        self.assertIn("Create button did not become enabled within", self.script)

    def test_prompt_cleanup_is_verified_after_failure_and_dry_run(self):
        self.assertIn("async function clearPromptVerified(prompt, selectors", self.script)
        self.assertIn("Prompt was cleared and verified empty.", self.script)
        self.assertIn("Clear prompt was clicked but textbox did not become empty within the verification timeout", self.script)
        self.assertIn("CRITICAL: prompt could not be verified empty", self.script)

    def test_every_prompt_cleanup_call_receives_selector_config(self):
        self.assertNotIn('clearPromptVerified(prompt, 2500)', self.script)
        self.assertIn('clearPromptVerified(prompt, selectors, 2500)', self.script)

    def test_asset_upload_wait_is_configurable_and_defaults_to_90_seconds(self):
        self.assertIn('process.env.FLOW_ASSET_READY_TIMEOUT_MS || 90000', self.script)
        self.assertIn('FLOW_ASSET_READY_TIMEOUT_MS must be an integer from 15000 to 180000', self.script)
        self.assertIn('{ timeout: ASSET_READY_TIMEOUT_MS }', self.script)
        self.assertIn('within " + ASSET_READY_TIMEOUT_MS + "ms', self.script)
        self.assertNotIn('within 15000ms', self.script)

    def test_picker_closure_clicks_backdrop_edge_and_verifies_closed(self):
        self.assertIn('position: { x: 5, y: 5 }', self.script)
        self.assertIn('Ingredients picker closure verification failed; a current picker surface or backdrop remains visible.', self.script)
        self.assertIn('Ingredients picker closure verification failed; a current picker surface or backdrop remains visible.', self.script)
        self.assertIn('await page.waitForFunction(selector => !Array.from(document.querySelectorAll(selector))', self.script)

    def test_upload_failure_closes_picker_and_leaves_one_cleanup_owner(self):
        self.assertIn('async function uploadSceneReferences(page, selectors, referenceImages, prompt, referenceAssetUuids = new Map())', self.script)
        upload_wrapper = self.script.split('async function uploadSceneReferences(page, selectors', 1)[1].split('function requiredSelectorConfig', 1)[0]
        self.assertIn('await closeIngredientsPicker(page, selectors)', upload_wrapper)
        self.assertIn('outer handler will verify prompt/chip cleanup', upload_wrapper)
        self.assertNotIn('clearPromptContentsVerified(prompt, selectors, 4000)', upload_wrapper)
        self.assertIn('await clearPromptVerified(promptForCleanup, selectors, 4000);', self.script)
        self.assertIn('chipCount !== 0', self.script)
        self.assertIn('async function waitForStableVisibleChipCount(page, selector, timeoutMs = 2000)', self.script)
        self.assertIn('visible Ingredients chip(s) remain after the DOM settled', self.script)
        self.assertIn('function isElementActuallyVisible(element)', self.script)

    def test_deduplicated_upload_can_reuse_a_verifiable_existing_asset(self):
        self.assertIn('event: "asset_library_reused_existing"', self.script)
        self.assertIn("Existing unique library asset found; skipping upload and UUID timeout wait.", self.script)
        self.assertIn('existing_uuids_before_upload: Array.from(existingUuids)', self.script)
        self.assertIn('matching_uuids_after_timeout: diagnostics', self.script)
        self.assertIn('selected_existing_uuid: reusedExistingUuid', self.script)
        self.assertIn('Reusing existing Flow library asset', self.script)
        self.assertIn('no reusable same-name asset UUID was verifiable', self.script)

    def test_chip_images_are_loaded_and_uuids_rechecked_before_create(self):
        self.assertIn('async function waitForChipImagesReady(page, selectors, timeout = 15000)', self.script)
        self.assertIn('image.complete && image.naturalWidth > 0', self.script)
        self.assertIn('async function verifyAttachedReferenceUuids(page, selectors, expectedUuids', self.script)
        self.assertIn('await verifyAttachedReferenceUuids(chosen.page, selectors, attachedReferenceUuids);', self.script)
        self.assertLess(self.script.index('await verifyAttachedReferenceUuids(chosen.page, selectors, attachedReferenceUuids);', self.script.index('This action may consume credit')), self.script.index('await finalButton.click({ timeout: 2500 })'))

    def test_account_panel_cleanup_runs_when_preflight_fails(self):
        self.assertIn('async function closeAccountMenuIfOpen(page, selectors, expectedEmail)', self.script)
        self.assertIn('await closeAccountMenuIfOpen(chosen.page, selectors, args.expectedEmail);', self.script)
        self.assertIn('Google account button for menu cleanup', self.script)

    def test_wait_mode_requires_execute_and_bounded_timeout(self):
        self.assertIn('if (args.waitForResult && !args.execute && !args.dryRun)', self.script)
        self.assertIn('--wait without --execute is preflight-only; pass --dry-run --wait explicitly.', self.script)
        self.assertIn('WAIT SELECTOR PREFLIGHT (read-only; no Create click; Videos tab selected when available; visible first row only; Failed tiles retained only as baseline UUIDs)', self.script)
        self.assertIn('--wait-timeout-ms must be an integer from 30000 to 1800000', self.script)
        self.assertIn('--wait requires a non-empty', self.script)
        self.assertIn('["credit_balance", "generated_video_items", "download_media_button", "download_360p_original_button", "account_panel_open", "account_panel_close"]', self.script)

    def test_wait_tracks_new_tile_by_stable_identity_and_never_retries(self):
        self.assertIn('collectAllGeneratedItems(page, selectors.generated_video_items, {\n      uuidCache, topLimit: 3, selectors, skipUuidResolution: true,', self.script)
        self.assertIn('candidateItems.length === 1', self.script)
        self.assertIn('refusing to guess which clip to download', self.script)
        self.assertIn('status: "unknown_do_not_retry"', self.script)
        self.assertIn('Do NOT retry automatically', self.script)

    def test_wait_downloads_original_360p_and_hashes_saved_file(self):
        self.assertIn('page.waitForEvent("download", { timeout: 30000 })', self.script)
        self.assertIn('getByRole("menuitem", { name: /Original size/i })', self.script)
        self.assertIn('await download.saveAs(target)', self.script)
        self.assertIn('createHash("sha256").update(fs.readFileSync(downloadedFile))', self.script)
        self.assertIn('if (!fs.statSync(target).size) throw new Error("Downloaded media file is empty.")', self.script)

    def test_wait_appends_schema_compatible_credit_ledger(self):
        self.assertIn('function appendGenerationLedger(pathname, record)', self.script)
        self.assertIn('attempt_id: attemptId', self.script)
        self.assertIn('actual_amount: actualAmount', self.script)
        self.assertIn('before_balance: beforeBalance', self.script)
        self.assertIn('after_balance: afterBalance', self.script)
        self.assertIn('evidence_source: beforeBalance !== null && afterBalance !== null ? "provider_display" : "unknown"', self.script)
        self.assertIn('created_by: "browser_automation"', self.script)
        self.assertIn('integrity_status: downloadedFile ? "verified" : (mediaUri ? "not_checked" : "missing")', self.script)
        self.assertIn('event: "generation_ledger_recorded"', self.script)
        self.assertIn('status: "unknown_do_not_retry"', self.script)
        self.assertIn('resultStatus, mediaUri, downloadedFile, downloadError, timeoutError, actualResolution, downloadQualityLabel, attemptNumber', self.script)
        self.assertIn('--ledger-project-id', self.script)
        self.assertIn('ledgerProjectId || scene.goglow_project_id || projectId', self.script)

    def test_wait_credit_reader_opens_and_closes_configured_account_panel(self):
        self.assertIn("async function readCreditBalance(page, selectors)", self.script)
        self.assertIn("selectors.account_panel_open", self.script)
        self.assertIn("selectors.account_panel_close", self.script)
        self.assertIn("span.credits-count", (Path(__file__).parents[1] / "examples" / "flow-pilot-selectors.example.json").read_text(encoding="utf-8"))

    def test_wait_returns_to_project_before_credit_polling_and_recovers_on_error(self):
        self.assertIn('chosen.page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 })', self.script)
        self.assertIn('chosen.page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 })', self.script)
        self.assertLess(self.script.index("chosen.page.goBack({ waitUntil: \"domcontentloaded\", timeout: 15000 })"), self.script.index("const balanceDeadline"))

    def test_download_filename_is_keyed_by_scene_and_attempt(self):
        self.assertIn('const safeScene = String(sceneId || "scene")', self.script)
        self.assertIn('const safeAttempt = String(attemptId || "attempt")', self.script)
        self.assertIn('${safeScene}__${safeAttempt}${extension}', self.script)
        self.assertIn('const targetName = `${safeScene}__${safeAttempt}${extension}`', self.script)
        self.assertIn("Refusing to overwrite an existing scene/attempt download", self.script)

    def test_virtualized_flow_grid_uses_new_stable_keys_not_tile_count(self):
        self.assertIn("const topItemsNow = scan.items || scan.topItems || [];", self.script)
        self.assertIn("const newItems = findNewCompletedMediaItems(topItemsNow, beforeKeys);", self.script)
        self.assertIn("Normalize media URLs to their stable UUID", self.script)
        self.assertIn("tileText.slice(0, 220)", self.script)
        self.assertIn("const mediaUuid = primarySources.filter(value => !/\\/image\\//i.test(value)).map(uuidFrom).find(Boolean)", self.script)
        self.assertIn("baseline_media_keys: initialItems", self.script)
        self.assertIn("ignored_failed_tile_keys: failedBaselineItems.map(item => item.key)", self.script)
        self.assertIn("let candidateItems = newItems.filter(item =>", self.script)
        self.assertIn("async function collectAllGeneratedItems(page, selector", self.script)
        self.assertNotIn("count > beforeCount", self.script)

    def test_confirmation_reader_buffers_piped_stdin(self):
        self.assertIn("function createConfirmationReader()", self.script)
        self.assertIn("const queued = [];", self.script)
        self.assertIn("interface_.on(\"line\"", self.script)
        self.assertIn("if (queued.length) return Promise.resolve(queued.shift());", self.script)

    def test_model_option_comparison_strips_icon_line_but_remains_exact(self):
        self.assertIn(r"rawText.split(/\r?\n/)", self.script)
        self.assertIn("if (text !== model)", self.script)

    def test_settings_failures_attempt_overlay_cleanup(self):
        self.assertIn("Settings preparation failed; attempted to close Flow overlays", self.script)
        self.assertIn('keyboard.press("Escape")', self.script)
        self.assertIn('settings_trigger).click({ timeout: 4000 })', self.script)

    def test_dry_run_clears_prompt_by_default(self):
        self.assertIn("clearAfterDryRun: true", self.script)
        self.assertIn("if (args.clearAfterDryRun)", self.script)
        self.assertIn("Dry-run prompt cleared.", self.script)
        self.assertIn("--keep-prompt-after-dry-run", self.script)

    def test_credit_cost_is_read_after_settings_are_applied(self):
        self.assertIn("creditCost = await readCreditCost(chosen.page)", self.script)
        self.assertLess(self.script.index('await checkedRadio(chosen.page, selectors.duration'), self.script.index("creditCost = await readCreditCost(chosen.page)"))

    def test_non_ascii_prompt_is_rejected_before_browser_mutation(self):
        self.assertIn(r"/^[\x00-\x7F]+$/", self.script)
        self.assertIn("Prompt must be ASCII/English only", self.script)
        self.assertLess(self.script.index("Prompt must be ASCII/English only"), self.script.index("await prompt.fill(scene.prompt"))

    def test_all_ui_controls_are_preflighted_before_prompt_fill(self):
        self.assertIn('"settings_trigger"', self.script)
        self.assertIn('"model_option"', self.script)
        self.assertIn('"ingredients_mode"', self.script)
        self.assertIn('"aspect_9_16"', self.script)
        self.assertIn('"duration"', self.script)
        self.assertLess(self.script.index('exactVisibleLocator(chosen.page, selectors.duration'), self.script.index("await prompt.fill(scene.prompt"))
        self.assertIn('role !== "radio"', self.script)
        self.assertIn('checked !== "true"', self.script)

    def test_model_selection_skips_menu_when_already_selected_and_waits_longer_when_needed(self):
        choose_model = self.script.split("async function chooseModel", 1)[1].split("function assetUuidFromUrl", 1)[0]
        self.assertIn("currentText.includes(model)", choose_model)
        self.assertIn("skipping model menu interaction", choose_model)
        self.assertIn("trigger.click({ timeout: 8000 })", choose_model)
        self.assertIn('option.waitFor({ state: "visible", timeout: 8000 })', choose_model)
        self.assertIn("await page.waitForTimeout(150)", choose_model)
        self.assertIn("stableBox = true", choose_model)
        self.assertIn("Model menu option layout did not stabilize", choose_model)
        self.assertIn("verifiedOption.click({ timeout: 8000 })", choose_model)

    def test_preflight_screenshot_failure_is_nonfatal(self):
        screenshot_block = self.script.split("// A screenshot is diagnostic only", 1)[1].split("} catch (error) {\n    let cleanupStatus;", 1)[0]
        self.assertIn("timeout: 10000", screenshot_block)
        self.assertIn("non-fatal", screenshot_block)
        self.assertIn("catch (screenshotError)", screenshot_block)
        self.assertIn("console.warn", screenshot_block)
        self.assertNotIn("throw new Error", screenshot_block)

    def test_credit_cost_is_reported_and_overlay_is_closed_before_prompt_fill(self):
        self.assertIn("Generating will use", self.script)
        self.assertIn("estimated_credit_cost", self.script)
        self.assertIn("settingsAgain.click({ timeout: 8000 })", self.script)
        self.assertLess(self.script.index("settingsAgain.click"), self.script.index("await prompt.fill(scene.prompt"))

    def test_ambiguous_submission_is_logged_without_retry(self):
        self.assertIn('event: "submission_intent"', self.script)
        self.assertIn('event: "submission_outcome_unknown"', self.script)
        self.assertIn('status: "unknown_do_not_retry"', self.script)
        self.assertEqual(self.script.count('await finalButton.click({ timeout: 2500 })'), 1)
        submission = self.script.split('await finalButton.click({ timeout: 2500 })', 1)[1].split('event: "create_click_returned"', 1)[0]
        self.assertNotIn("finalButton.click", submission)
        self.assertNotIn("CREATE ONE VIDEO FOR", submission)

    def test_requires_unique_visible_selectors(self):
        self.assertIn("expected exactly one", self.script)
        self.assertIn("isVisible", self.script)
        self.assertIn("create_button_enabled", self.script)

    def test_each_scene_supplies_its_own_reference_images_and_character_description(self):
        self.assertIn('scene.character_description', self.script)
        self.assertIn('scene.reference_images', self.script)
        self.assertIn('reference_images as an array of 1 to 3 local file paths', self.script)
        self.assertIn('Character description must be ASCII/English only', self.script)
        self.assertIn('Scene JSON must contain a non-empty character_description', self.script)
        self.assertIn('uploadSceneReferences(chosen.page, selectors, referenceImages, prompt, referenceAssetUuids)', self.script)
        self.assertLess(self.script.index('await uploadSceneReferences(chosen.page, selectors, referenceImages, prompt, referenceAssetUuids)'), self.script.index('await prompt.fill(scene.prompt'))
        self.assertIn('reference_image_count: referenceImages.length', self.script)
        self.assertIn('ingredient_reference_items', self.script)
        self.assertIn('Stopping before prompt fill/Create', self.script)
        self.assertNotIn('--character-profile', self.script)
        self.assertNotIn('character_id', self.script)

    def test_hybrid_face_description_and_expression_are_composed_near_prompt_end(self):
        self.assertIn('faceDescriptionMode === "hybrid"', self.script)
        self.assertIn("HYBRID FACE DESCRIPTION (brief matching traits only; reference images remain authoritative)", self.script)
        self.assertIn("const rawNormalizedExpression = scene.expression", self.script)
        self.assertIn('.replace(/(?:[,;.]?\\s*)natural brief blinks only\\b/ig, "")', self.script)
        self.assertIn("const openEyesRequested =", self.script)
        self.assertIn("const expressionContent = [normalizedExpression, openEyesGuard].filter(Boolean)", self.script)
        self.assertIn("const expressionSection = expressionContent", self.script)
        self.assertIn("EXPRESSION AND EYE STATE (follow throughout the entire shot)", self.script)
        self.assertIn("this instruction takes priority over breathing or other subtle motion", self.script)
        self.assertIn("Expression must be ASCII/English only", self.script)

    def test_generation_ledger_records_face_reference_configuration(self):
        self.assertIn("face_reference_ids: faceReferenceIds", self.script)
        self.assertIn('face_description_mode: scene.face_description_mode || "include"', self.script)
        self.assertIn('reference_language_mode: scene.reference_language_mode || "identity_preserving"', self.script)
        self.assertIn("expression: scene.expression || null", self.script)
        self.assertIn("reference_set_key: referenceSetKey", self.script)
        self.assertIn("other_reference_ids: otherReferenceIds", self.script)

    def test_media_grid_uses_top_six_and_stable_keys_before_tile_identity_comparison(self):
        self.assertIn("async function collectAllGeneratedItems(page, selector", self.script)
        self.assertIn("Flow's media grid may virtualize its DOM", self.script)
        self.assertIn("let initialScan = await collectAllGeneratedItems", self.script)
        self.assertIn("const videosTabState = await activateVideosTab", self.script)
        self.assertIn('page.getByRole("tab", { name: /^Videos$/i })', self.script)
        self.assertIn("unkeyedItemsDetected", self.script)
        self.assertIn("duplicateVisibleKeyDetected", self.script)
        self.assertIn("First-row baseline requires unique, stable media UUIDs/keys", self.script)
        self.assertIn("tileText.slice(0, 220)", self.script)

    def test_generation_failure_is_detected_and_logged_without_retry(self):
        self.assertIn("function isGenerationFailureText(value)", self.script)
        self.assertIn("FLOW_GENERATION_FAILED:", self.script)
        self.assertIn('event: resultStatus === "rejected_unusual_activity" ? "flow_rejected_unusual_activity"', self.script)
        self.assertIn('resultStatus === "failed" ? "generation_failed_detected"', self.script)
        self.assertIn('resultStatus === "submitted_unidentified" ? "submitted_unidentified"', self.script)
        self.assertIn('["failed", "rejected_unusual_activity"].includes(resultStatus) && beforeBalance !== null && afterBalance !== null && beforeBalance === afterBalance ? "not_charged" : "unknown"', self.script)
        self.assertIn('else if (resultStatus === "failed")', self.script)
        self.assertIn("Flow generation failure was detected and recorded in the ledger", self.script)
        self.assertIn("Wait-timeout screenshot saved", self.script)

    def test_hybrid_face_description_strips_trailing_period_before_adding_punctuation(self):
        self.assertIn(r'scene.character_description.trim().replace(/[.\s]+$/, "")', self.script)

    def test_credit_preflight_waits_for_render_and_retries_once(self):
        self.assertIn('waitFor({ state: "visible", timeout: 8000 })', self.script)
        self.assertIn("for (let attempt = 0; attempt < 3 && balance === null; attempt += 1)", self.script)
        self.assertIn("if (balance === null && attempt < 2)", self.script)

    def test_cleanup_does_not_click_clear_when_already_clean(self):
        self.assertIn("let initialChipCount = await waitForStableVisibleChipCount(page, selectors.ingredient_reference_items, 2000)", self.script)
        self.assertIn('String(initialValue).trim() === "" && initialChipCount === 0', self.script)


    def test_face_reference_is_selected_from_this_jobs_reference_images(self):
        self.assertIn("const requestedFaceReferences = scene.face_reference_ids;", self.script)
        self.assertIn("Every face_reference_ids entry must match a path in this job's reference_images.", self.script)
        self.assertIn("face_reference_id must match one of the image paths in this job's reference_images.", self.script)
        self.assertIn("Use either face_reference_ids or face_reference_id, not both.", self.script)
        self.assertIn("const orderedReferenceImages = [", self.script)
        self.assertIn("...faceReferenceImages,", self.script)
        self.assertIn("...referenceImages.filter(imagePath => !faceReferenceImages.includes(imagePath))", self.script)
        self.assertIn("referenceImages: orderedReferenceImages, faceReferenceImage: faceReferenceImages[0], faceReferenceImages", self.script)

    def test_multiple_face_references_are_described_as_same_character(self):
        self.assertIn("The other selected face reference images show the same character from additional angles.", self.script)
        self.assertIn("Use them to understand the character's features; do not mix them with supporting references.", self.script)
        self.assertIn("The first attached image shows the character.", self.script)
        self.assertIn("Keep the same character as the reference image:", self.script)
        self.assertNotIn("primary face identity anchor", self.script)
        self.assertNotIn("overall likeness", self.script)
        self.assertNotIn("Preserve the selected face identity", self.script)
        self.assertIn("face_reference_ids must contain distinct paths.", self.script)
        self.assertIn("face_reference_ids must be an array of 1 to 3 paths from this job's reference_images.", self.script)

    def test_reference_only_mode_can_omit_character_description(self):
        self.assertIn('const faceDescriptionMode = scene.face_description_mode ?? "include";', self.script)
        self.assertIn('["include", "hybrid", "reference_only"].includes(faceDescriptionMode)', self.script)
        self.assertIn('face_description_mode is \'reference_only\'', self.script)
        self.assertIn('faceDescriptionMode === "reference_only" || !scene.character_description', self.script)
        self.assertIn("Use the reference image as the visual guide for the character", self.script)

    def test_dry_run_reports_selected_face_reference_and_order(self):
        self.assertIn("face_reference_id: scene.face_reference_id", self.script)
        self.assertIn("face_reference_image: path.basename(faceReferenceImage)", self.script)
        self.assertIn('face_reference_ids: (scene.face_reference_ids || [scene.face_reference_id]).map(value => path.basename(value))', self.script)
        self.assertIn('face_description_mode: scene.face_description_mode || "include"', self.script)

    def test_face_reference_defaults_to_first_image_for_older_jobs(self):
        self.assertIn("singleFaceReference = referenceImages[0];", self.script)
        self.assertIn("scene.face_reference_id = scene.reference_images[0];", self.script)

    def test_prepare_destructures_face_reference_image_from_load_inputs(self):
        prepare = self.script.split("async function prepare(args, browser, rl) {", 1)[1].split(
            "async function main()", 1
        )[0]
        self.assertIn(
            "const { scene, selectors, referenceImages, faceReferenceImage, referenceAssetUuids } = await loadInputs(args);",
            prepare,
        )
        self.assertIn("face_reference_image: path.basename(faceReferenceImage)", prepare)
        self.assertIn("face_reference_id: scene.face_reference_id", prepare)

    def test_pre_submit_errors_run_verified_prompt_and_ingredients_cleanup(self):
        prepare = self.script.split("async function prepare(args, browser, rl) {", 1)[1].split(
            "async function main()", 1
        )[0]
        self.assertIn("let promptForCleanup = null;", prepare)
        self.assertIn("let createMayHaveBeenClicked = false;", prepare)
        self.assertIn("if (promptForCleanup && !createMayHaveBeenClicked)", prepare)
        self.assertIn("await clearPromptVerified(promptForCleanup, selectors, 4000);", prepare)
        self.assertIn("Failure cleanup: prompt and Ingredients chips cleared and verified.", prepare)
        self.assertIn("CRITICAL: failure cleanup could not verify prompt/chips empty", prepare)
        self.assertLess(
            prepare.index("await uploadSceneReferences(chosen.page, selectors, referenceImages, prompt, referenceAssetUuids)"),
            prepare.index("face_reference_image: path.basename(faceReferenceImage)"),
        )
        self.assertLess(
            prepare.index("await finalButton.click({ timeout: 2500 })"),
            prepare.index("createMayHaveBeenClicked = true;"),
        )


    def test_wait_reselects_videos_and_requires_new_media_id(self):
        wait_fn = self.script.split("async function waitForGenerationAndDownload", 1)[1].split(
            "function createConfirmationReader()", 1
        )[0]
        self.assertIn("Explicitly re-select Videos", wait_fn)
        self.assertIn("await activateVideosTab(page, selectors)", wait_fn)
        self.assertIn("let candidateItems = newItems.filter(item =>", wait_fn)
        self.assertNotIn("firstTileIsNew", wait_fn)
        self.assertIn("if (candidateItems.length > 1)", wait_fn)
        self.assertIn("if (candidateItems.length === 1 && !attemptedKeys.has(candidateItems[0].key))", wait_fn)

    def test_wait_extends_polling_when_credit_was_charged_but_result_is_late(self):
        wait_fn = self.script.split("async function waitForGenerationAndDownload", 1)[1].split(
            "function createConfirmationReader()", 1
        )[0]
        self.assertIn("beforeBalance", wait_fn)
        self.assertIn("currentBalance < beforeBalance", wait_fn)
        self.assertIn("deadline = Date.now() + 30000", wait_fn)
        self.assertIn("without resubmitting", wait_fn)
        self.assertIn('page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 })', wait_fn)
        self.assertIn("newItem = null", wait_fn)

    def test_add_to_prompt_retries_click_only_after_uuid_check(self):
        upload_fn = self.script.split("async function uploadSceneReferencesUnsafe", 1)[1].split(
            "async function uploadSceneReferences(", 1
        )[0]
        self.assertIn("for (let clickAttempt = 0; clickAttempt < 3; clickAttempt += 1)", upload_fn)
        self.assertIn("await addToPrompt.click({ timeout: 6000 })", upload_fn)
        self.assertIn("attachedAfterClick = await page.waitForFunction", upload_fn)
        self.assertIn("if (attachedAfterClick) break", upload_fn)
        self.assertIn("did not add a new Ingredients chip", upload_fn)



    def test_variants_are_limited_to_one_through_three_and_default_to_two(self):
        self.assertIn('const variants = scene.variants === undefined ? 2 : scene.variants;', self.script)
        self.assertIn('variantCount = inputScene.variants === undefined ? 2 : inputScene.variants;', self.script)
        self.assertIn('variants < 1 || variants > 3', self.script)
        self.assertIn('args._variantCount = variantCount', self.script)
        self.assertIn('for (let index = 1; index <= variantCount; index += 1)', self.script)

    def test_variant_execution_requires_wait_and_single_total_confirmation(self):
        self.assertIn('Executing variants requires --wait', self.script)
        self.assertIn('estimated total ${totalEstimate} credits', self.script)
        self.assertIn('if (!args._variantsConfirmed)', self.script)
        self.assertIn('args._variantsConfirmed = true', self.script)
        self.assertIn('Type CREATE ${variantCount} VARIANTS FOR ${scene.scene_id}', self.script)

    def test_variants_keep_same_job_and_log_each_variant(self):
        self.assertIn('job_id: scene.job_id || scene.scene_id', self.script)
        self.assertIn('variant_index: variantIndex', self.script)
        self.assertIn('variant_count: variantCount', self.script)
        self.assertIn('selected_variant: null', self.script)
        self.assertIn('variantIndex, variantCount,', self.script)
        self.assertIn('const targetName = `${safeScene}__${safeAttempt}${extension}`', self.script)
        self.assertIn('Refusing to overwrite an existing scene/attempt download', self.script)

    def test_seated_shots_get_head_to_knees_framing_and_wide_knee_margins(self):
        self.assertIn('scene.framing_helper_applied', self.script)
        self.assertIn('Locked-off tripod shot from the first frame: the camera does not move, pan, tilt, dolly, or zoom at any time', self.script)
        self.assertIn('Medium-wide full-body shot.', self.script)
        self.assertIn('The person and yoga mat fill most of the frame', self.script)
        self.assertIn('Keep the face large enough for facial features to remain readable', self.script)
        self.assertIn('Do not crop the body or mat.', self.script)
        self.assertIn('is framed from head to knees', self.script)
        self.assertIn('scene.framing_helper === false ? false', self.script)

    def test_supporting_reference_sentence_is_conditional(self):
        self.assertIn('const supportingReferenceImages = referenceImages.filter(imagePath => !faceReferenceImages.includes(imagePath));', self.script)
        self.assertIn('const supportingReferenceSection = supportingReferenceImages.length', self.script)
        self.assertIn('${supportingReferencePrefix}Keep the same character, hair, and skin tone throughout.', self.script)
        self.assertIn('const supportingReferencePrefix = supportingReferenceSection ?', self.script)

    def test_expression_punctuation_is_normalized_and_open_eyes_guard_is_added(self):
        self.assertIn('scene.expression.trim().replace(/[.!?]+\\s*$/, "")', self.script)
        self.assertIn('Eyes remain clearly open throughout the entire shot, with natural brief blinks only. No prolonged eye closure or eyes-closed meditation.', self.script)
        self.assertIn('Medium-wide full-body shot.', self.script)
        self.assertIn('The person and yoga mat fill most of the frame', self.script)
        self.assertIn('No prolonged eye closure or eyes-closed meditation.', self.script)
        self.assertIn('const expressionContent = [normalizedExpression, openEyesGuard].filter(Boolean)', self.script)
        self.assertIn('EXPRESSION AND EYE STATE (follow throughout the entire shot): ${expressionContent}', self.script)


    def test_open_eyes_guard_does_not_duplicate_natural_blinks_clause(self):
        self.assertIn('.replace(/(?:[,;.]?\\s*)natural brief blinks only\\b/ig, "")', self.script)
        self.assertIn('const openEyesRequested =', self.script)
        self.assertIn('const openEyesGuard = openEyesRequested', self.script)

    def test_composed_prompt_has_no_leading_space_before_final_character_guard(self):
        self.assertIn('const supportingReferencePrefix = supportingReferenceSection ?', self.script)
        self.assertIn('${supportingReferencePrefix}Keep the same character, hair, and skin tone throughout.', self.script)

    def test_reference_upload_emits_phase_timings_to_diagnose_slow_dry_runs(self):
        self.assertIn('Phase timing: reference upload started', self.script)
        self.assertIn('Phase timing: reference upload completed in', self.script)
        self.assertIn('Reference UUID ready:', self.script)
        self.assertIn('total reference step', self.script)

    def test_watermark_status_is_recorded_for_human_qc(self):
        self.assertIn('watermark_status: scene.watermark_status || "not_reviewed"', self.script)

    def test_flow_prominent_people_policy_failure_text_is_recognized(self):
        matcher = self.script.split("function isGenerationFailureText(value)", 1)[1].split(
            "async function activateVideosTab", 1
        )[0]
        self.assertIn("might violate", matcher)
        self.assertIn("violate(?:s|d)? (?:our )?policies", matcher)
        self.assertIn("prominent people", matcher)
        self.assertIn("you will be refunded", matcher)
        self.assertIn(r"/\bfailed\b/i.test", self.script)

    def test_failure_detection_checks_new_tiles_without_false_positive_from_old_grid_tiles(self):
        wait_fn = self.script.split("async function waitForGenerationAndDownload", 1)[1].split(
            "function createConfirmationReader()", 1
        )[0]
        self.assertIn("const failedTile = newItems.find", wait_fn)
        self.assertIn(r"if (!/\/(?:edit|video)\//i.test(page.url())) return;", wait_fn)
        self.assertIn("failedTile.text || failedTile.state", wait_fn)

    def test_failure_ledger_preserves_provider_message_without_automation_prefix(self):
        self.assertIn("function rawProviderMessage(value)", self.script)
        self.assertIn('const tileMarker = " reports failure: "', self.script)
        self.assertIn('provider_message: ["failed", "rejected_unusual_activity"].includes(resultStatus) ? rawProviderMessage(timeoutError)', self.script)
        self.assertNotIn('.slice(-700)', self.script)

    def test_failed_variant_stops_batch_and_records_refund_pending_when_provider_says_refund(self):
        self.assertIn("refundPending", self.script)
        self.assertIn('"refunded_pending"', self.script)
        self.assertIn('"provider_policy_prominent_people"', self.script)
        self.assertIn("POLICY REFUSAL: Flow flagged this request under its prominent-people policy", self.script)
        self.assertIn("no automatic retry or reference/prompt substitution", self.script)
        self.assertIn("args._stopVariants = true", self.script)
        self.assertIn("if (args._stopVariants) break", self.script)
        self.assertIn("later variants will NOT be submitted with the same prompt", self.script)

    def test_face_reference_prompt_uses_plain_character_wording(self):
        self.assertIn("The first attached image shows the character.", self.script)
        self.assertIn("Keep the same character as the reference image:", self.script)
        self.assertNotIn("primary face identity anchor", self.script)
        self.assertNotIn("overall likeness", self.script)
        self.assertNotIn("Preserve the selected face identity", self.script)

    def test_ledger_records_reference_set_fingerprint_for_policy_analysis(self):
        self.assertIn("const referenceSetKey = createHash(\"sha256\").update(JSON.stringify({", self.script)
        self.assertIn("reference_set_key: referenceSetKey", self.script)
        self.assertIn('prompt: { text: prompt, sha256: createHash("sha256").update(prompt, "utf8").digest("hex")', self.script)

    def test_expression_guard_removes_duplicate_short_eye_smile_clause(self):
        self.assertIn(r'eyes?\s+(?:stay|remain)\s+open', self.script)
        self.assertIn("standard guard below already states this full eye/smile requirement", self.script)

    def test_policy_refusal_report_groups_by_reference_set_and_prompt(self):
        self.assertIn("by_reference_set_and_prompt", self.policy_stats_script)
        self.assertIn("by_reference_set:", self.policy_stats_script)
        self.assertIn("by_prompt_sha256:", self.policy_stats_script)
        self.assertIn('record.result?.failure?.category === "provider_policy_prominent_people"', self.policy_stats_script)
        self.assertIn("refusal_rate:", self.policy_stats_script)


    def test_media_baseline_uses_only_first_six_tiles_and_result_checks_first_tile(self):
        self.assertIn("Always begin at the true top", self.script)
        self.assertIn("topLimit: 3, selectors", self.script)
        self.assertIn("Pre-Create first-row baseline requires at least three visible tiles", self.script)
        self.assertIn("First-row baseline requires unique, stable media UUIDs/keys", self.script)
        self.assertIn("topLimit: 3, selectors, skipUuidResolution: true", self.script)
        self.assertIn("baseline_strategy", self.script)
        self.assertIn("baseline_media_key_count: initialItems.length", self.script)
        self.assertIn("Pre-Create baseline UUID count:", self.script)
        self.assertNotIn("full virtualized-grid sweep", self.script)

    def test_result_must_be_new_top_tile_and_newer_than_create_when_timestamp_exists(self):
        wait_fn = self.script.split("async function waitForGenerationAndDownload", 1)[1].split(
            "function createConfirmationReader()", 1
        )[0]
        self.assertIn("const topItemsNow = scan.items || scan.topItems || [];", wait_fn)
        self.assertIn("findNewCompletedMediaItems(topItemsNow, beforeKeys)", wait_fn)
        self.assertIn("mediaUuid: mediaUuid ? mediaUuid.toLowerCase() : null", self.script)
        self.assertIn("!item.key || !item.mediaUuid", self.script)
        self.assertIn("!item?.mediaUuid || !item.key", self.script)
        self.assertIn("baseline.has(item.key)", self.script)
        self.assertIn("const createdAt = element.querySelector(\"time[datetime]\")", self.script)
        self.assertIn("createdMs <= createMs", wait_fn)
        self.assertIn("result remains unknown and will not be downloaded", wait_fn)
        self.assertIn("createClickedAt: args._waitCreateClickedAt", self.script)


    def test_flow_video_uuid_is_read_directly_from_edit_url_after_tile_click(self):
        resolver = self.script.split("const resolveUuidByOpeningTile = async (index, identity = null, rowIdentities = [], expectedTileCount = null) =>", 1)[1].split(
            "let stableBottomRounds = 0;", 1
        )[0]
        self.assertIn('await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 12000 }).catch(() => {});', resolver)
        self.assertIn('const expectedToken = alreadyOnGrid && currentTokens[index]\n          ? currentTokens[index]\n          : (identity?.thumbnailSrc ? thumbnailIdentityToken(identity.thumbnailSrc) : null);', resolver)
        self.assertIn('return token === expected;', resolver)
        self.assertIn('await activateVideosTab(page, selectors)', resolver)
        self.assertIn('visible_first_six_thumbnail_tokens: currentTokens.slice(0, 6)', resolver)
        self.assertIn('expected_thumbnail_token: expectedToken', resolver)
        self.assertIn("const firstThreeTokens = currentTokens.slice(0, 3)", resolver)
        self.assertIn("firstThreeTokens.every(Boolean)", resolver)
        self.assertIn("previousFirstThreeTokens.every(Boolean)", resolver)
        self.assertIn("await page.waitForTimeout(1000);", resolver)
        self.assertIn("await tile.click({ timeout: 4000, force: true });", resolver)
        self.assertIn("await page.waitForURL(url => editRoute.test(new URL(url).pathname)", resolver)
        self.assertIn("const currentUrl = page.url();", resolver)
        self.assertIn("const match = currentUrl.match(editRoute);", resolver)
        self.assertIn("await page.goBack({ waitUntil: \"domcontentloaded\", timeout: 10000 }).catch(() => {});", resolver)
        self.assertIn("uuidCache.set(item.hint, resolvedUuid)", self.script)
        self.assertIn("Could not resolve media UUID by opening tile index", self.script)
        self.assertNotIn("page.waitForFunction(() =>", resolver)

    def test_dry_run_runs_top_six_read_only_media_baseline(self):
        self.assertIn("if (args.waitForResult || args.dryRun)", self.script)
        self.assertIn('mode: args.waitForResult ? "wait-preflight" : "dry-run-baseline"', self.script)
        self.assertIn("DRY-RUN MEDIA BASELINE (read-only; no Create click", self.script)
        self.assertIn("visible first row only; no full-grid sweep", self.script)
        self.assertIn("Dry-run baseline scan requires a configured generated_video_items selector", self.script)

    def test_add_to_prompt_readiness_uses_exactly_one_visible_button_not_aria_selected(self):
        upload_fn = self.script.split("async function uploadSceneReferencesUnsafe", 1)[1].split(
            "async function uploadSceneReferences(", 1
        )[0]
        self.assertIn('const addToPromptSelector = selectors.ingredient_add_to_prompt;', upload_fn)
        self.assertIn('const selectionWaitTimeoutMs = 8000;', upload_fn)
        self.assertIn('const selectionDeadline = selectionWaitStartedAt + selectionWaitTimeoutMs;', upload_fn)
        self.assertIn('while (Date.now() < selectionDeadline)', upload_fn)
        self.assertIn('const freshTile = async () =>', upload_fn)
        self.assertIn('event: "ingredients_picker_step_diagnostics"', upload_fn)
        self.assertIn('document.elementFromPoint(x, y)', upload_fn)
        self.assertIn('hit_test_inside_tile: hitTest', upload_fn)
        self.assertIn('event: "ingredients_picker_click_target"', upload_fn)
        self.assertIn('closest(\'[role="option"],[role="button"],button,[tabindex]\')', upload_fn)
        self.assertIn('clicked_interactive_ancestor: ancestorCount === 1', upload_fn)
        self.assertIn('const previewNodes = paneNodes.filter', upload_fn)
        self.assertIn('const detailPanes = Array.from(document.querySelectorAll("flow-add-menu-detail-pane"))', upload_fn)
        self.assertIn('detail_pane: detailPanes.map(node =>', upload_fn)
        self.assertIn('add_button_contexts:', upload_fn)
        self.assertIn('await activeAsset.scrollIntoViewIfNeeded({ timeout: 400 })', upload_fn)
        self.assertIn('resolveVisibleIngredientsPicker(page, selectors, filename, filenameStem)', upload_fn)
        self.assertIn('const addToPromptCandidates = pickerContainer.locator(addToPromptSelector);', upload_fn)
        self.assertIn('event: "ingredients_picker_target_tile"', upload_fn)
        self.assertIn('target_tile_box: initialAssetBox', upload_fn)
        self.assertIn('event: "ingredients_picker_search_fallback"', upload_fn)
        self.assertIn('selection_retried: selectionRetried', upload_fn)
        self.assertIn('configured wait budget=${selectionWaitTimeoutMs}ms, actual elapsed=${Date.now() - selectionWaitStartedAt}ms', upload_fn)
        self.assertIn('if (addToPromptVisibleCount === 1 && (selectedAssetAriaSelected === "true" || labelMatches)', upload_fn)
        self.assertIn('selected_asset_aria_selected: selectedAssetAriaSelected', upload_fn)
        self.assertIn('readiness_signal: "unique_visible_add_button_plus_exact_preview_filename_or_uuid"', upload_fn)
        self.assertIn('event: "reference_asset_selection_ready"', upload_fn)
        self.assertIn('visible Add to prompt buttons=', upload_fn)
        self.assertIn('const addToPromptCandidates = pickerContainer.locator(addToPromptSelector);', upload_fn)
        self.assertIn("Refusing to click Add to prompt", upload_fn)
        self.assertNotIn('selectedAssetAriaSelected === "true" && addToPromptVisibleCount', upload_fn)
        self.assertLess(
            upload_fn.index('if (addToPromptVisibleCount === 1 && (selectedAssetAriaSelected === "true" || labelMatches)'),
            upload_fn.index('await addToPrompt.click({ timeout: 6000 });'),
        )

    def test_first_row_thumbnail_tokens_wait_and_recapture_when_missing(self):
        preflight = self.script.split('if (args.waitForResult || args.dryRun)', 1)[1].split(
            '// Only now modify the prompt.', 1
        )[0]
        self.assertIn('const waitForFirstRowThumbnailTokens = async (reason, maxWaitMs = 15000)', preflight)
        self.assertIn('await waitForFirstRowThumbnailTokens("before_initial_capture_after_scroll")', preflight)
        self.assertIn('event: "baseline_thumbnail_tokens_ready"', preflight)
        self.assertIn('event: "baseline_thumbnail_token_missing_at_capture"', preflight)
        self.assertIn('thumbnailRetry <= 2', preflight)
        self.assertIn('initialScan.items.some(item => !item.thumbnailSrc || !thumbnailIdentityToken(item.thumbnailSrc) || /\\/image\\//i.test(item.thumbnailSrc))', preflight)
        self.assertIn('missing_thumbnail_token_indexes: missingIndexes', preflight)
        self.assertIn("await waitForFirstRowThumbnailTokens(`recapture_retry_${thumbnailRetry}`)", preflight)
        self.assertIn('baselineUuidCache.clear()', preflight)

    def test_baseline_retries_when_tiles_exist_but_all_media_uuids_are_missing(self):
        preflight = self.script.split('if (args.waitForResult || args.dryRun)', 1)[1].split(
            '// Only now modify the prompt.', 1
        )[0]
        self.assertIn('event: "baseline_uuid_retry"', preflight)
        self.assertIn('baselineRetry <= 2', preflight)
        self.assertIn('initialScan.items.length > 0', preflight)
        self.assertIn('initialScan.items.every(item => !item.mediaUuid)', preflight)
        self.assertIn('baselineUuidCache.clear()', preflight)
        self.assertIn('await chosen.page.waitForTimeout(600)', preflight)

    def test_asset_reuse_checks_all_dom_attributes_and_never_duplicates_unreadable_match(self):
        self.assertIn("async function assetUuidFromLocator(locator, timeoutMs = 1200)", self.script)
        self.assertIn('"data-asset-id"', self.script)
        self.assertIn('"data-media-id"', self.script)
        self.assertIn("Refusing to upload a duplicate; if this is the intended asset", self.script)
        self.assertIn("let assetUuid = reusedExistingUuid || await assetUuidFromLocator(asset, 1200)", self.script)

    def test_clear_prompt_removes_ingredient_chips_and_verifies_each_removal(self):
        self.assertIn('button[aria-label*="remove" i]', self.script)
        self.assertIn("chip count did not decrease", self.script)
        self.assertIn("Remove chips manually before continuing", self.script)


    def test_media_inventory_prefers_flow_json_uuid_records_before_tile_click(self):
        self.assertIn("const networkMediaRecords = [];", self.script)
        self.assertIn('page.on("response", networkResponseListener)', self.script)
        self.assertIn("const resolveUuidFromNetwork = item =>", self.script)
        self.assertLess(
            self.script.index("const networkUuid = resolveUuidFromNetwork(item);"),
            self.script.index("const resolvedUuid = await resolveUuidByOpeningTile(item.index, item, visible, domTileCount);"),
        )

    def test_edit_route_fallback_waits_then_force_clicks_animated_tile(self):
        self.assertIn("await tile.scrollIntoViewIfNeeded({ timeout: 3500 })", self.script)
        self.assertIn("const maxIdentityAttempts = 2;", self.script)
        self.assertIn("for (let attempt = 1; attempt <= maxIdentityAttempts; attempt += 1)", self.script)
        self.assertIn("await tile.click({ timeout: 4000, force: true });", self.script)
        self.assertIn("timeout: 8000", self.script)
        self.assertIn("after ${maxIdentityAttempts} bounded attempts", self.script)
        self.assertIn('event: "media_tile_identity_recapture_skipped"', self.script)
        self.assertIn('reason: "thumbnail_token_still_missing_and_no_stable_uuid"', self.script)
        self.assertIn('next_step: "return_unresolved_for_bounded_inventory_recapture"', self.script)
        resolver = self.script.split("const resolveUuidByOpeningTile", 1)[1].split("let stableBottomRounds = 0;", 1)[0]
        self.assertIn("if (attempt < maxIdentityAttempts)", resolver)
        self.assertIn("(attempt ${attempt}/${maxIdentityAttempts})", resolver)
        self.assertNotIn("(attempt ${attempt}/5)", resolver)
        self.assertIn("const alreadyOnGrid = currentPageUrl === gridUrl", resolver)
        self.assertIn("const expectedToken = alreadyOnGrid && currentTokens[index]", resolver)
        self.assertIn('if (!source || /\\/image\\//i.test(source)) return "";', resolver)

    def test_first_row_wait_rejects_image_placeholder_until_thumbnail_is_ready(self):
        preflight = self.script.split('const waitForFirstRowThumbnailTokens = async (reason, maxWaitMs = 15000)', 1)[1].split(
            '// Save the grid scroll before forcing lazy thumbnails into view;', 1
        )[0]
        self.assertIn('if (!source || /\\/image\\//i.test(source)) return null;', preflight)
        self.assertIn('Wait for /asb/ or another non-placeholder URL.', preflight)

    def test_asset_uuid_lookup_waits_for_lazy_loaded_thumbnail_and_rejects_ambiguity(self):
        self.assertIn("const thumbnailDeadline = (networkUuidShortcut || pinnedUniqueCardShortcut) ? Date.now() : Date.now() + 7000;", self.script)
        self.assertIn("flow-content/image/<uuid>", self.script)
        self.assertIn("if (existingCount === 1 && existingUuids.size === 1)", self.script)
        self.assertIn("else if (existingUuids.size > 1 || existingCount > 1)", self.script)

    def test_job_can_pin_existing_flow_asset_uuids_by_path(self):
        self.assertIn("reference_asset_uuids", self.script)
        self.assertIn("flow_asset_uuid", self.script)
        self.assertIn("asset_library_reused_explicit_uuid", self.script)
        self.assertIn("Job explicitly requested Flow asset UUID", self.script)
        self.assertIn("Conflicting Flow asset UUID declarations", self.script)

    def test_asset_uuid_can_come_from_flow_json_or_attached_chip_when_thumbnail_is_tokenized(self):
        self.assertIn("const networkAssetRecords = [];", self.script)
        self.assertIn('page.on("response", assetResponseListener)', self.script)
        self.assertIn("walkAssetPayload(await response.json())", self.script)
        self.assertIn("const allowUniqueUnresolvedAsset = existingCount === 1 && !assetUuid;", self.script)
        self.assertIn("unique-name-plus-attached-chip-verification", self.script)
        self.assertIn("beforeAttachChipUuids", self.script)
        self.assertIn("const newChipUuids = afterAttachChipUuids.filter(uuid => uuid && !beforeAttachChipUuids.includes(uuid));", self.script)
        self.assertIn("document.querySelectorAll(selector).length > beforeCount", self.script)
        self.assertIn("Pinned Flow asset UUID mismatch after attach", self.script)
        self.assertIn("newly attached chip UUID", self.script)
        self.assertIn("Flow asset UUID mismatch after attach", self.script)

    def test_upload_uuid_detection_checks_all_same_name_cards(self):
        self.assertIn("Inspect every same-name card, not only the first one", self.script)
        self.assertIn("const cards = Array.from(document.querySelectorAll(selector)).filter(asset =>", self.script)
        self.assertIn("uuids.some(uuid => !oldUuids.includes(uuid))", self.script)

    def test_baseline_reports_uuid_count_sample_and_retries_tile_open(self):
        self.assertIn("baseline_media_inventory_summary", self.script)
        self.assertIn("uuid_count: baselineUuids.length", self.script)
        self.assertIn("uuid_sample_first_5: baselineUuids.slice(0, 5)", self.script)
        self.assertIn("visible_first_row_min_3", self.script)
        self.assertIn("reached_bottom: initialScan.reachedBottom", self.script)
        self.assertIn("Retrying media UUID lookup for tile index", self.script)

    def test_account_button_visibility_is_retried_without_changing_page_fields(self):
        self.assertIn("Google account button remained unavailable after 3 read-only visibility checks", self.script)
        self.assertIn("await page.keyboard.press(\"Escape\")", self.script)

    def test_preflight_cleanup_has_one_authoritative_outer_owner(self):
        preflight = self.script.split("if (args.waitForResult || args.dryRun)", 1)[1].split("// Only now modify the prompt.", 1)[0]
        self.assertNotIn("Prompt/Ingredients cleanup was not verified.", preflight)
        self.assertIn("Failure cleanup: prompt and Ingredients chips cleared and verified.", self.script)
        self.assertIn("CRITICAL: failure cleanup could not verify prompt/chips empty", self.script)

    def test_cleanup_uses_observed_empty_state_when_click_times_out(self):
        self.assertIn("afterClickChips !== 0", self.script)
        self.assertIn("afterClickValue", self.script)
        self.assertIn("let removeClickError = null;", self.script)
        self.assertIn("const deadline = Date.now() + Math.max(timeout, 3000)", self.script)
        self.assertIn("if (!(nextCount >= 0 && nextCount < chipCount))", self.script)




    def test_videos_tab_activation_uses_first_visible_exact_button_match(self):
        activate = self.script.split("async function activateVideosTab", 1)[1].split(
            "function appendGenerationLedger", 1
        )[0]
        self.assertIn('page.getByRole("button", { name: /^Videos$/i })', activate)
        self.assertIn("buttonCount = await button.count()", activate)
        self.assertIn("for (let i = 0; i < buttonCount; i += 1)", activate)
        self.assertIn("const isSelected = async locator => locator.evaluate(element =>", activate)
        self.assertIn("not_found_no_tab_switch (tabs=", activate)

    def test_baseline_uses_visible_first_row_with_minimum_three_tiles(self):
        self.assertIn("topLimit: 3, selectors", self.script)
        self.assertIn("initialScan.items.length < 3", self.script)
        self.assertIn('baseline_strategy: "visible_first_row_min_3"', self.script)
        self.assertIn("args._waitInitialThumbnailTokens = baselineTokensWithUuidFallback;", self.script)
        self.assertIn("args._waitInitialThumbnailTokens.slice(0, 3).some(token => !token)", self.script)

    def test_pre_create_recheck_is_read_only_and_uses_bounded_neighbor_fallback(self):
        self.assertIn('event: "pre_create_first_tile_identity_recheck"', self.script)
        self.assertIn("const expectedFirstToken = args._waitInitialThumbnailTokens?.[0];", self.script)
        self.assertIn("if (currentFirstToken !== expectedFirstToken && !sameFirstTileAfterThumbnailRotation && !sameFirstRowMediaIdentity)", self.script)
        self.assertIn("read_only_dom_check: true", self.script)
        self.assertIn("waitForPreCreateThumbnailSnapshot", self.script)
        self.assertIn('a[href*="/edit/"], a[href*="/video/"]', self.script)
        self.assertIn('thumbnailIdentityToken(item.thumbnailSrc) : null', self.script)
        self.assertIn("accepted_by_neighbor_rule: preCreateSnapshot.acceptedByNeighborRule", self.script)
        self.assertIn("acceptedByNeighborRule: stableFirstToken && (Number(lastSnapshot.tileCount) || 0) >= 3", self.script)
        self.assertIn("lastTokens.slice(0, 3).every(token => typeof token === \"string\" && token.length > 0)", self.script)
        self.assertIn("currentTokens.slice(0, 3).every(validToken)", self.script)
        self.assertIn("secondNeighborMatches && thirdNeighborMatches", self.script)
        self.assertNotIn("thirdNeighborStillLoading", self.script)
        self.assertIn("}, ms => chosen.page.waitForTimeout(ms), 10000);", self.script)
        self.assertNotIn("const currentScan = await collectAllGeneratedItems(chosen.page, selectors.generated_video_items", self.script)

    def test_neighbor_fallback_rejects_null_third_thumbnail_token(self):
        helper = "function firstTileMatchesByStableNeighbors" + self.script.split(
            "function firstTileMatchesByStableNeighbors", 1
        )[1].split("\n\nasync function waitForPreCreateThumbnailSnapshot", 1)[0]
        node_test = helper + r"""
const assert = await import('node:assert/strict');
const base = {
  expectedToken: 'asb:old-first',
  currentToken: 'asb:new-first',
  baselineTokens: ['asb:old-first', 'asb:middle', 'asb:third'],
  baselineTileCount: 3,
  currentTileCount: 3,
};
assert.equal(firstTileMatchesByStableNeighbors({
  ...base, currentTokens: ['asb:new-first', 'asb:middle', null],
}), false, 'missing third token must not establish neighbor identity');
assert.equal(firstTileMatchesByStableNeighbors({
  ...base, currentTokens: ['asb:new-first', 'asb:middle', 'asb:third'],
}), true, 'both stable neighbors and unchanged tile count may confirm rotation');
"""
        result = subprocess.run(["node", "--input-type=module", "-e", node_test],
                                capture_output=True, text=True, check=False, timeout=5)
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_pre_create_recheck_passes_when_third_thumbnail_loads_after_initial_nulls(self):
        helper = "async function waitForPreCreateThumbnailSnapshot" + self.script.split(
            "async function waitForPreCreateThumbnailSnapshot", 1
        )[1].split("\n\nasync function prepare", 1)[0]
        node_test = helper + r"""
const assert = await import('node:assert/strict');
let reads = 0;
const readSnapshot = async () => {
  reads += 1;
  return { tileCount: 3, tokens: ['asb:first', 'asb:middle', reads < 5 ? null : 'asb:third'] };
};
const result = await waitForPreCreateThumbnailSnapshot(
  readSnapshot, ms => new Promise(resolve => setTimeout(resolve, ms)), 10000
);
assert.equal(result.fullyStable, true);
assert.equal(result.acceptedByNeighborRule, false);
assert.deepEqual(result.tokens, ['asb:first', 'asb:middle', 'asb:third']);
assert.ok(reads >= 6, 'must poll after initial null thumbnail before accepting the row');
"""
        result = subprocess.run(["node", "--input-type=module", "-e", node_test],
                                capture_output=True, text=True, check=False, timeout=5)
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_abort_before_create_is_not_logged_as_unknown_submission(self):
        self.assertIn('event: "submission_aborted_before_create"', self.script)
        self.assertIn('status: "not_submitted"', self.script)
        self.assertIn('console.error("No generation was submitted.', self.script)
        self.assertIn('if (!createMayHaveBeenClicked)', self.script)
        self.assertIn('status: "click_returned_unconfirmed"', self.script)
        self.assertIn('event: "submission_confirmed_by_new_media_uuid"', self.script)
        self.assertIn('event: "submission_confirmed_by_credit_decrease"', self.script)
        self.assertIn('event: "create_not_confirmed"', self.script)
        self.assertIn('if (!submissionEvidence && !["failed", "rejected_unusual_activity"].includes(resultStatus))', self.script)
        self.assertIn('CREATE_NOT_CONFIRMED:', self.script)
        self.assertIn('resultStatus = "create_not_confirmed"', self.script)
    def test_post_create_uuid_set_difference_ignores_rotating_thumbnail_and_waits_for_completion(self):
        helper = "function findNewCompletedMediaItems" + self.script.split(
            "function findNewCompletedMediaItems", 1
        )[1].split("\n\nasync function waitForGenerationAndDownload", 1)[0]
        node_test = helper + r"""
const assert = await import('node:assert/strict');
const baseline = ['media:old-a', 'media:old-b', 'media:old-c'];
const rotatingNewTile = {
  key: 'media:new-uuid', mediaUuid: 'new-uuid', thumbnailSrc: 'asb:rotated-token',
  state: 'Generating', text: 'Generating', progress: true,
};
assert.deepEqual(findNewCompletedMediaItems([rotatingNewTile], baseline), []);
const completed = { ...rotatingNewTile, state: 'Complete', text: 'Mai seated breathing', progress: false };
assert.deepEqual(findNewCompletedMediaItems([completed], baseline), [completed]);
assert.deepEqual(findNewCompletedMediaItems([
  { key: 'media:old-a', mediaUuid: 'old-a', state: 'Complete', progress: false },
  completed,
], baseline), [completed]);
"""
        result = subprocess.run(["node", "--input-type=module", "-e", node_test],
                                capture_output=True, text=True, check=False, timeout=5)
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("skipUuidResolution: thumbnailRetry === 1", self.script)
        self.assertIn("if (thumbnailRetry === 2) await waitForFirstRowThumbnailTokens", self.script)
        self.assertIn("verifiedUuidThumbnailIndexes.add(index)", self.script)
        self.assertIn("thumbnailRetry === 2 && initialScan.items[missingIndex]?.mediaUuid", self.script)
        self.assertIn("verifiedUuidThumbnailIndexes.has(index)", self.script)
        self.assertIn("uuidCache: thumbnailRetry === 1 ? baselineUuidCache : new Map()", self.script)
        self.assertIn('phase: thumbnailRetry === 1 && completeUniqueUuidBaseline ? "thumbnail_only_recapture" : "full_row_dom_inventory"', self.script)
        self.assertIn("topLimit: 3", self.script)
        self.assertIn("FLOW_SUBMITTED_UNIDENTIFIED:", self.script)
        self.assertIn('resultStatus === "submitted_unidentified" ? "submitted_unidentified"', self.script)
        self.assertIn('resultStatus === "submitted_unidentified" ? "submitted_unidentified_do_not_retry"', self.script)

    def test_resolution_verification_polls_aria_checked_before_failing(self):
        self.assertIn("const deadline = Date.now() + 3000;", self.script)
        self.assertIn("while (Date.now() < deadline)", self.script)
        self.assertIn("after 3000ms polling", self.script)

    def test_media_tile_reidentification_reselects_videos_waits_for_stable_grid_and_logs_tokens(self):
        resolver = self.script.split("const resolveUuidByOpeningTile = async (index, identity = null, rowIdentities = [], expectedTileCount = null) =>", 1)[1].split(
            "let stableBottomRounds = 0;", 1
        )[0]
        self.assertIn('await page.goto(gridUrl, { waitUntil: "domcontentloaded", timeout: 12000 })', resolver)
        self.assertIn("const tabResult = await activateVideosTab(page, selectors)", resolver)
        self.assertIn("for (let gridPoll = 0; gridPoll < 30; gridPoll += 1)", resolver)
        self.assertIn("})).catch(() => [])", resolver)
        self.assertNotIn("}).filter(Boolean)).catch(() => [])", resolver)
        self.assertIn("currentTokens.length === previousTokens.length", resolver)
        self.assertIn('event: "media_tile_reidentification"', resolver)
        self.assertIn("expected_thumbnail_token: expectedToken", resolver)
        self.assertIn("visible_first_six_thumbnail_tokens: currentTokens.slice(0, 6)", resolver)
        self.assertIn("function thumbnailIdentityToken(value)", self.script)
        self.assertIn("const mediaUuid = assetUuidFromUrl(source);", self.script)
        self.assertIn('element.getAttribute("data-media-id")', self.script)
        self.assertIn('return `media:${uuid[0].toLowerCase()}`', self.script)
        self.assertIn(r"source.match(/\/asb\/([^/?#]+)/i)", self.script)

    def test_middle_tile_rotated_thumbnail_token_uses_neighbor_and_count_validation(self):
        resolver = self.script.split("const resolveUuidByOpeningTile", 1)[1].split(
            "let stableBottomRounds = 0;", 1
        )[0]
        self.assertIn("resolveUuidByOpeningTile(item.index, item, visible, domTileCount)", self.script)
        self.assertIn("const expectedRowTokens = rowIdentities.slice(0, 3).map", resolver)
        self.assertIn("const currentRowTokens = currentTokens.slice(0, 3)", resolver)
        self.assertIn("const neighborsMatch = Boolean(expectedRowTokens[0] && expectedRowTokens[2]", resolver)
        self.assertIn("currentRowTokens[0] === expectedRowTokens[0]", resolver)
        self.assertIn("currentRowTokens[2] === expectedRowTokens[2]", resolver)
        self.assertIn("const tileCountMatches = expectedTileCount === null || currentTileCount === expectedTileCount", resolver)
        self.assertIn("currentIndex = index;", resolver)
        self.assertIn('event: "token_changed_at_index"', resolver)
        self.assertIn("old_thumbnail_token: expectedRowTokens[index]", resolver)
        self.assertIn("new_thumbnail_token: currentRowTokens[index]", resolver)
        self.assertIn("accepted_by_position_with_neighbor_validation: true", resolver)
        self.assertIn("const resolvedUuid = await resolveUuidByOpeningTile(item.index, item, visible, domTileCount)", self.script)
        self.assertIn("First-row baseline requires unique, stable media UUIDs/keys", self.script)

    def test_unique_network_asset_uuid_skips_lazy_thumbnail_wait(self):
        upload_fn = self.script.split("async function uploadSceneReferencesUnsafe", 1)[1].split(
            "async function uploadSceneReferences(", 1
        )[0]
        self.assertIn("const pinnedUuidConfirmedByNetwork = Boolean(requestedAssetUuid && networkNameUuids.includes(requestedAssetUuid));", upload_fn)
        self.assertIn("const networkUuidShortcut = existingCount === 1", upload_fn)
        self.assertIn("(networkNameUuids.length === 1 || pinnedUuidConfirmedByNetwork)", upload_fn)
        self.assertIn("if (networkUuidShortcut) existingUuids.add(pinnedUuidConfirmedByNetwork ? requestedAssetUuid : networkNameUuids[0]);", upload_fn)
        self.assertIn("const thumbnailDeadline = (networkUuidShortcut || pinnedUniqueCardShortcut) ? Date.now() : Date.now() + 7000;", upload_fn)
        self.assertIn("Skipped Flow asset thumbnail UUID wait:", upload_fn)


    def test_picker_resets_between_assets_and_requires_preview_uuid_before_add(self):
        self.assertIn("async function resetIngredientsPicker(page, selectors)", self.script)
        self.assertIn('await page.keyboard.press("Escape")', self.script)
        self.assertIn("Ingredients picker/detail pane did not fully close after Escape/backdrop close", self.script)
        self.assertIn("await resetIngredientsPicker(page, selectors);", self.script)
        self.assertIn("async function inspectAddToPromptContext(button)", self.script)
        self.assertIn('event: "ingredients_picker_add_action_identity"', self.script)
        self.assertIn("expected_asset_uuid: expectedPreviewUuid || null", self.script)
        self.assertIn("previewContext?.preview_labels || []", self.script)
        self.assertIn("readiness_signal: \"unique_visible_add_button_plus_exact_preview_filename_or_uuid\"", self.script)
        self.assertIn("identity_signal: immediateUuidMatches ? \"uuid\" : immediateLabelMatches ? \"exact_preview_filename\" : \"unverified\"", self.script)
        self.assertIn("image_sources: imageSources.slice(0, 12)", self.script)
        self.assertIn('match(/Preview of\\s+(.+?\\.(?:png|jpe?g|webp|gif|avif))/i)', self.script)
        self.assertIn('const freshTile = async () =>', self.script)
        self.assertIn('const selectionDeadline = selectionWaitStartedAt + selectionWaitTimeoutMs;', self.script)
        self.assertIn('let targetPickerReopenAttempted = false;', self.script)
        self.assertIn('reason: visiblePickerCount === 0 ? "picker_closed_before_target_selection" : "target_tile_missing_or_ambiguous"', self.script)
        self.assertIn('await resetIngredientsPicker(page, selectors);', self.script)
        self.assertIn('if (reopenedPickerVisible && reopenedCount === 1 && requestedAssetUuid)', self.script)
        self.assertIn('targetPickerReopenAttempted = true;', self.script)
        self.assertIn('click_hit_inside_matching_tile', self.script)
        self.assertIn('if (hitTest && ancestorCount === 1', self.script)
        self.assertIn('const fallbackMethods = ["thumbnail_hover_click", "thumbnail_pointer_sequence", "option_double_click", "focus_space"]', self.script)
        self.assertNotIn('method === "focus_enter"', self.script)
        self.assertIn('new PointerEvent("pointerdown"', self.script)
        self.assertIn('picker_still_open: Boolean(after)', self.script)
        self.assertIn('event: "ingredients_picker_activation_attempt"', self.script)
        self.assertIn('event: "ingredients_picker_preview_context"', self.script)
        self.assertIn('outer_html: tile.outerHTML.slice(0, 700)', self.script)
        self.assertIn('grandparent_html: tile.parentElement?.parentElement?.outerHTML.slice(0, 1100)', self.script)
        self.assertIn('add_button_contexts:', self.script)
        self.assertIn('await ancestor.click({ position: { x: Math.floor(ancestorBox.width / 2), y: Math.floor(ancestorBox.height / 2) }, timeout: 500 })', self.script)
        self.assertIn('if (previewLabels.length) return contexts[contexts.length - 1];', self.script)
        self.assertIn("Refusing to click Add to prompt", self.script)
        self.assertIn("action_clicked: false", self.script)
        upload_fn = self.script.split("async function uploadSceneReferencesUnsafe", 1)[1].split(
            "async function uploadSceneReferences(", 1
        )[0]
        self.assertLess(
            upload_fn.index("if (!immediateUuidMatches && !immediateLabelMatches)"),
            upload_fn.index("await addToPrompt.click({ timeout: 6000 });"),
        )


    def test_new_failed_flow_tile_without_uuid_stops_polling_and_classifies_policy(self):
        waiter = self.script.split("async function waitForGenerationAndDownload", 1)[1].split(
            "function ", 1
        )[0]
        self.assertIn("const baselineKeyCounts = new Map();", waiter)
        self.assertIn("const newFailedTile = topItemsNow.find(item =>", waiter)
        self.assertIn("const occurrence = topItemsNow.slice(0, item.index + 1).filter(candidate => candidate?.key === item.key).length;", waiter)
        self.assertIn('failureReason = /prominent people|might violate our policies|you will be refunded/i.test(failureText)', waiter)
        self.assertIn("new Flow tile at position ${newFailedTile.index}", waiter)
        self.assertIn('textNode.querySelectorAll("a,button,[role=button],[aria-label]")', self.script)
        self.assertIn("Track status here", self.script)
        self.assertIn('"policy_prominent_people" : "provider_generation_failed"', waiter)
        self.assertIn('failure_reason: resultStatus === "rejected_unusual_activity" ? "unusual_activity"', self.script)
        self.assertIn('if (resultStatus === "failed") {', self.script)
        self.assertIn("another 30-second submission-evidence poll", self.script)

    def test_neutral_reference_mode_uses_short_non_identity_lock_language(self):
        self.assertIn('["identity_preserving", "neutral_reference"].includes(referenceLanguageMode)', self.script)
        self.assertIn('"Use the character shown in the reference image as a visual guide."', self.script)
        self.assertIn("Keep the overall visual design and clothing consistent with the reference images.", self.script)
        self.assertIn('reference_language_mode: scene.reference_language_mode || "identity_preserving"', self.script)

    def test_thumbnail_identity_keeps_image_uuid_separate_from_media_uuid(self):
        helper = self.script.split("function assetUuidFromUrl", 1)[1].split(
            "async function assetUuidFromLocator", 1
        )[0]
        node_test = "function assetUuidFromUrl" + helper + r"""
const assert = await import('node:assert/strict');
const uuid = '4d8c7d18-d76a-479a-8164-8414f9ddaff7';
assert.equal(assetUuidFromUrl('/image/' + uuid), uuid);
assert.equal(thumbnailIdentityToken('/image/' + uuid), '/image/' + uuid);
assert.equal(thumbnailIdentityToken('https://flow.google.com/asb/opaque-signed-token'), 'asb:opaque-signed-token');
assert.equal(thumbnailIdentityToken('https://flow.google.com/asb/' + uuid), 'media:' + uuid);
// A known media UUID hint remains authoritative when thumbnail URLs rotate.
assert.equal(thumbnailIdentityToken('https://flow.google.com/asb/ANqvLObmDmk_6XQl', uuid), 'media:' + uuid);
"""
        result = subprocess.run(["node", "--input-type=module", "-e", node_test],
                                capture_output=True, text=True, check=False, timeout=5)
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)

    def test_neutral_reference_open_eyes_does_not_override_neutral_expression_with_smile(self):
        self.assertIn("const openEyesRequested =", self.script)
        self.assertIn('EXPRESSION AND EYE STATE (follow throughout the entire shot): ${expressionContent}', self.script)

    def test_execute_usage_example_includes_required_wait_flag(self):
        usage = self.script.split("Actual one-scene submission", 1)[1].split(
            "Selector-only preflight", 1
        )[0]
        self.assertIn("--execute --wait --wait-timeout-ms 600000", usage)


    def test_missing_third_thumbnail_uses_uuid_only_after_same_position_row_verification(self):
        self.assertIn("const sameVisibleRow = refreshedScan.items.length === initialScan.items.length", self.script)
        self.assertIn("item.mediaUuid && refreshed.mediaUuid) return item.mediaUuid === refreshed.mediaUuid", self.script)
        self.assertIn("refreshed.mediaUuid === initialScan.items[missingIndex].mediaUuid", self.script)
        self.assertIn("initialScan.items[missingIndex].thumbnailSrc = `media:${initialScan.items[missingIndex].mediaUuid}`", self.script)
        self.assertIn("refreshedTextCounts.get(refreshedTexts[missingIndex]) === 1", self.script)
        self.assertIn("primarySources.filter(value => !/\\/image\\//i.test(value)).map(uuidFrom).find(Boolean)", self.script)
        self.assertIn("const mediaUuid = primarySources.filter(value => !/\\/image\\//i.test(value)).map(uuidFrom).find(Boolean)", self.script)
        self.assertIn("turning this \"8 x 250ms\" probe into a multi-minute stall", self.script)
        self.assertIn("if (!sameVisibleRow)", self.script)

    def test_two_item_recapture_retries_full_row_before_fail_closed(self):
        self.assertIn("thumbnailRetry <= 2", self.script)
        self.assertIn('action: thumbnailRetry < 2 ? "retry_full_row_inventory" : "fail_closed_after_retries"', self.script)
        self.assertIn("skipUuidResolution: true", self.script)
        self.assertIn("retry_strategy: thumbnailRetry === 1 && completeUniqueUuidBaseline ? \"thumbnail_only_snapshot\" : \"full_row_dom_inventory\"", self.script)
        self.assertIn("const topLimited = Number.isInteger(topLimit) && topLimit > 0", self.script)
        self.assertIn("items: topLimited ? (topItems || []).slice(0, topLimit) : Array.from(all.values())", self.script)
        self.assertIn("const retryTileCount = await retryTiles.count()", self.script)
        self.assertIn("continue;", self.script)

    def test_null_asb_null_thumbnail_pattern_uses_verified_video_uuids_and_not_image_uuid(self):
        helper = "function buildVerifiedThumbnailBaselineTokens" + self.script.split(
            "function buildVerifiedThumbnailBaselineTokens", 1
        )[1].split("\n\nfunction thumbnailIdentityToken", 1)[0]
        node_test = helper + r"""
const assert = await import('node:assert/strict');
const items = [
  { mediaUuid: '21770a37-08bc-493a-9b9c-5fdd8736f30e', text: 'Mai seated breathing' },
  { mediaUuid: '3926cb48-421c-48de-b8e5-5ec30aa5c8f8', text: 'Mai standing' },
  { mediaUuid: 'f5c80cba-1342-46bb-aaa4-eeb7fbd466b0', text: 'Mai kneeling' },
];
const tokens = buildVerifiedThumbnailBaselineTokens(
  [null, 'asb:ANqvLOa3xUpF', null],
  items,
  ['Mai seated breathing', 'Mai standing', 'Mai kneeling'],
);
assert.deepEqual(tokens, [
  'media:' + items[0].mediaUuid,
  'asb:ANqvLOa3xUpF',
  'media:' + items[2].mediaUuid,
]);
const ambiguous = buildVerifiedThumbnailBaselineTokens(
  [null, 'asb:ANqvLOa3xUpF', null],
  items,
  ['Mai seated breathing', 'Mai standing', 'different row'],
);
assert.equal(ambiguous[2], null, 'must not reuse UUID when same-position row fingerprint differs');
// Retry 2 independently resolved the same three unique video UUIDs at the same
// positions as the initial inventory (row_identity_verified=true).
const verified = buildVerifiedThumbnailBaselineTokens(
  [null, 'asb:ANqvLOa3xUpF', 'asb:ANqvLOaNiC06'],
  items,
  ['text may differ while the thumbnail is lazy', 'Mai standing', 'Mai kneeling'],
  new Set([0, 1, 2]),
);
assert.deepEqual(verified, [
  'media:' + items[0].mediaUuid,
  'asb:ANqvLOa3xUpF',
  'asb:ANqvLOaNiC06',
]);
"""
        result = subprocess.run(["node", "--input-type=module", "-e", node_test],
                                capture_output=True, text=True, check=False, timeout=5)
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn('if (segments[assetIndex] === "image") return null;', self.script)
        self.assertIn("skipUuidResolution: thumbnailRetry === 1", self.script)
        self.assertIn('phase: thumbnailRetry === 1 && completeUniqueUuidBaseline ? "thumbnail_only_recapture" : "full_row_dom_inventory"', self.script)

    def test_persistent_incomplete_recapture_fails_before_create(self):
        self.assertIn("First-row baseline requires loaded DOM thumbnail identities for all three tiles", self.script)
        self.assertIn("Refusing to Create with an incomplete baseline", self.script)
        self.assertLess(
            self.script.index("First-row baseline requires loaded DOM thumbnail identities for all three tiles"),
            self.script.index("await finalButton.click({ timeout: 2500 })"),
        )

    def test_tile_reorder_or_ambiguous_text_match_stops_before_create(self):
        self.assertIn("const baselineTextCounts = new Map()", self.script)
        self.assertIn("const refreshedTextCounts = new Map()", self.script)
        self.assertIn("baselineTextCounts.get(text) === 1 && refreshedTextCounts.get(text) === 1", self.script)
        self.assertIn("item.mediaUuid === refreshed.mediaUuid", self.script)
        self.assertIn("if (!sameVisibleRow)", self.script)
        self.assertIn("Pre-Create recheck could not confirm a stable first tile and three-tile row", self.script)


if __name__ == "__main__":
    unittest.main()
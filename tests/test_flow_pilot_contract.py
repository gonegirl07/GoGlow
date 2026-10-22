"""Static safety contract checks for the human-gated Flow pilot runner."""
import re
import unittest
from pathlib import Path


class FlowPilotContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (Path(__file__).parents[1] / "scripts" / "flow-pilot.mjs").read_text(encoding="utf-8")
        cls.policy_stats_script = (Path(__file__).parents[1] / "scripts" / "summarize-policy-refusals.mjs").read_text(encoding="utf-8")

    def test_uses_only_the_configured_local_cdp_endpoint_and_never_navigates(self):
        self.assertIn('const CDP_ENDPOINT = "http://127.0.0.1:9224"', self.script)
        self.assertIn("chromium.connectOverCDP(CDP_ENDPOINT)", self.script)
        self.assertNotIn("page.goto(", self.script)

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
        self.assertIn('Ingredients picker closure verification failed; backdrop remains visible', self.script)
        self.assertIn('Clicked the edge of the Ingredients picker backdrop, but the overlay is still open', self.script)
        self.assertIn('await page.waitForFunction(selector => !Array.from(document.querySelectorAll(selector))', self.script)

    def test_upload_failure_runs_verified_cleanup_in_finally(self):
        self.assertIn('async function uploadSceneReferences(page, selectors, referenceImages, prompt, referenceAssetUuids = new Map())', self.script)
        self.assertIn('finally {\n    if (uploadError)', self.script)
        self.assertIn('Upload failure cleanup (finally):', self.script)
        self.assertIn('await closeIngredientsPicker(page, selectors)', self.script)
        self.assertIn('await clearPromptContentsVerified(prompt, selectors, 4000)', self.script)
        self.assertIn('chipCount !== 0', self.script)

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
        self.assertIn('WAIT SELECTOR PREFLIGHT (read-only; no Create click; Videos tab selected when available; virtualized grid swept; Failed tiles retained only as baseline UUIDs)', self.script)
        self.assertIn('--wait-timeout-ms must be an integer from 30000 to 1800000', self.script)
        self.assertIn('--wait requires a non-empty', self.script)
        self.assertIn('["credit_balance", "generated_video_items", "download_media_button", "download_360p_original_button", "account_panel_open", "account_panel_close"]', self.script)

    def test_wait_tracks_new_tile_by_stable_identity_and_never_retries(self):
        self.assertIn('collectAllGeneratedItems(page, selectors.generated_video_items, { uuidCache })', self.script)
        self.assertIn('candidateItems.length === 1', self.script)
        self.assertIn('refusing to guess which clip to download', self.script)
        self.assertIn('status: "unknown_do_not_retry"', self.script)
        self.assertIn('Do NOT retry automatically', self.script)

    def test_wait_downloads_original_360p_and_hashes_saved_file(self):
        self.assertIn('page.waitForEvent("download", { timeout: 30000 })', self.script)
        self.assertIn('selectors.download_360p_original_button', self.script)
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
        self.assertIn('resultStatus, mediaUri, downloadedFile, downloadError, timeoutError, attemptNumber', self.script)
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
        self.assertIn("const topItem = scan.topItems?.[0] || null;", self.script)
        self.assertIn("const newItems = topItem?.mediaUuid && topItem.key && !beforeKeys.includes(topItem.key) ? [topItem] : [];", self.script)
        self.assertIn("Normalize media URLs to their stable UUID", self.script)
        self.assertIn("const mediaUuid = sources.map(uuidFrom).find(Boolean)", self.script)
        self.assertIn("baseline_media_keys: initialItems", self.script)
        self.assertIn("ignored_failed_tile_keys: failedBaselineItems.map(item => item.key)", self.script)
        self.assertIn("const candidateItems = newItems.filter(item =>", self.script)
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
        self.assertIn('after !== "true"', self.script)

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
        self.assertIn("expression: scene.expression || null", self.script)
        self.assertIn("reference_set_key: referenceSetKey", self.script)
        self.assertIn("other_reference_ids: otherReferenceIds", self.script)

    def test_virtualized_media_grid_is_swept_before_tile_identity_comparison(self):
        self.assertIn("async function collectAllGeneratedItems(page, selector", self.script)
        self.assertIn("Flow's media grid may virtualize its DOM", self.script)
        self.assertIn("const initialScan = await collectAllGeneratedItems", self.script)
        self.assertIn("const videosTabState = await activateVideosTab", self.script)
        self.assertIn('page.getByRole("tab", { name: /^Videos$/i })', self.script)
        self.assertIn("unkeyedItemsDetected", self.script)
        self.assertIn("duplicateVisibleKeyDetected", self.script)
        self.assertIn("Pre-Create media inventory is ambiguous", self.script)
        self.assertIn("full virtualized-grid sweep", self.script)

    def test_generation_failure_is_detected_and_logged_without_retry(self):
        self.assertIn("function isGenerationFailureText(value)", self.script)
        self.assertIn("FLOW_GENERATION_FAILED:", self.script)
        self.assertIn('event: resultStatus === "failed" ? "generation_failed_detected" : "generation_wait_unverified"', self.script)
        self.assertIn('resultStatus === "failed" && beforeBalance !== null && afterBalance !== null && beforeBalance === afterBalance ? "not_charged" : "unknown"', self.script)
        self.assertIn('else if (resultStatus === "failed")', self.script)
        self.assertIn("Flow generation failure was detected and recorded in the ledger", self.script)
        self.assertIn("Wait-timeout screenshot saved", self.script)

    def test_hybrid_face_description_strips_trailing_period_before_adding_punctuation(self):
        self.assertIn(r'scene.character_description.trim().replace(/[.\s]+$/, "")', self.script)

    def test_credit_preflight_waits_for_render_and_retries_once(self):
        self.assertIn('waitFor({ state: "visible", timeout: 8000 })', self.script)
        self.assertIn("for (let attempt = 0; attempt < 2; attempt += 1)", self.script)
        self.assertIn("retry opening the account panel once", self.script)

    def test_cleanup_does_not_click_clear_when_already_clean(self):
        self.assertIn("const initialChipCount = await page.locator(selectors.ingredient_reference_items)", self.script)
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
        self.assertIn("Use the attached reference images for all appearance details; do not invent or reinterpret facial features.", self.script)

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
            prepare.index("createMayHaveBeenClicked = true;"),
            prepare.index("await finalButton.click({ timeout: 2500 })"),
        )


    def test_wait_reselects_videos_and_requires_new_media_id(self):
        wait_fn = self.script.split("async function waitForGenerationAndDownload", 1)[1].split(
            "function createConfirmationReader()", 1
        )[0]
        self.assertIn("Explicitly re-select Videos", wait_fn)
        self.assertIn("await activateVideosTab(page, selectors)", wait_fn)
        self.assertIn("const candidateItems = newItems", wait_fn)
        self.assertNotIn("firstTileIsNew", wait_fn)
        self.assertIn("if (candidateItems.length > 1)", wait_fn)
        self.assertIn("if (candidateItems.length === 1 && !attemptedKeys.has(candidateItems[0].key))", wait_fn)

    def test_wait_extends_polling_when_credit_was_charged_but_result_is_late(self):
        wait_fn = self.script.split("async function waitForGenerationAndDownload", 1)[1].split(
            "function createConfirmationReader()", 1
        )[0]
        self.assertIn("beforeBalance", wait_fn)
        self.assertIn("currentBalance < beforeBalance", wait_fn)
        self.assertIn("deadline = Date.now() + 300000", wait_fn)
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
        self.assertIn("did not attach asset", upload_fn)



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
        self.assertIn('Eyes remain clearly open throughout the entire shot; she looks directly at the camera and smiles warmly with teeth visible from the first frame to the final frame; natural brief blinks only.', self.script)
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
        self.assertIn('provider_message: resultStatus === "failed" ? rawProviderMessage(timeoutError)', self.script)
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


    def test_media_grid_inventory_starts_at_top_and_must_reach_bottom_before_create(self):
        self.assertIn("Always begin at the true top", self.script)
        self.assertIn("let reachedBottom = false;", self.script)
        self.assertIn("if (!initialScan.reachedBottom)", self.script)
        self.assertIn("if (!currentScan.reachedBottom)", self.script)
        self.assertIn("baseline_media_key_count: initialItems.length", self.script)
        self.assertIn("Pre-Create baseline UUID count:", self.script)

    def test_result_must_be_new_top_tile_and_newer_than_create_when_timestamp_exists(self):
        wait_fn = self.script.split("async function waitForGenerationAndDownload", 1)[1].split(
            "function createConfirmationReader()", 1
        )[0]
        self.assertIn("const topItem = scan.topItems?.[0] || null;", wait_fn)
        self.assertIn("mediaUuid: mediaUuid ? mediaUuid.toLowerCase() : null", self.script)
        self.assertIn("!item.key || !item.mediaUuid", self.script)
        self.assertIn("topItem?.mediaUuid && topItem.key", wait_fn)
        self.assertIn("!beforeKeys.includes(topItem.key)", wait_fn)
        self.assertIn("const createdAt = element.querySelector(\"time[datetime]\")", self.script)
        self.assertIn("createdMs <= createMs", wait_fn)
        self.assertIn("result remains unknown and will not be downloaded", wait_fn)
        self.assertIn("createClickedAt: args._waitCreateClickedAt", self.script)


    def test_flow_video_uuid_is_read_directly_from_edit_url_after_tile_click(self):
        resolver = self.script.split("const resolveUuidByOpeningTile = async index =>", 1)[1].split(
            "let stableBottomRounds = 0;", 1
        )[0]
        self.assertIn("await tile.click({ timeout: 4000, force: true });", resolver)
        self.assertIn("await page.waitForURL(url => editRoute.test(new URL(url).pathname)", resolver)
        self.assertIn("const currentUrl = page.url();", resolver)
        self.assertIn("const match = currentUrl.match(editRoute);", resolver)
        self.assertIn("await page.goBack({ waitUntil: \"domcontentloaded\", timeout: 10000 }).catch(() => {});", resolver)
        self.assertIn("uuidCache.set(item.hint, resolvedUuid)", self.script)
        self.assertIn("Could not resolve media UUID by opening tile index", self.script)
        self.assertNotIn("page.waitForFunction(() =>", resolver)

    def test_dry_run_runs_full_read_only_media_baseline(self):
        self.assertIn("if (args.waitForResult || args.dryRun)", self.script)
        self.assertIn('mode: args.waitForResult ? "wait-preflight" : "dry-run-baseline"', self.script)
        self.assertIn("DRY-RUN MEDIA BASELINE (read-only; no Create click", self.script)
        self.assertIn("Dry-run baseline scan requires a configured generated_video_items selector", self.script)

    def test_asset_reuse_checks_all_dom_attributes_and_never_duplicates_unreadable_match(self):
        self.assertIn("async function assetUuidFromLocator(locator)", self.script)
        self.assertIn('"data-asset-id"', self.script)
        self.assertIn('"data-media-id"', self.script)
        self.assertIn("Refusing to upload a duplicate; inspect the asset entry DOM", self.script)
        self.assertIn("const assetUuid = await assetUuidFromLocator(asset)", self.script)

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
            self.script.index("const resolvedUuid = await resolveUuidByOpeningTile(item.index);"),
        )

    def test_edit_route_fallback_waits_then_force_clicks_animated_tile(self):
        self.assertIn("await tile.scrollIntoViewIfNeeded({ timeout: 3500 })", self.script)
        self.assertIn("for (let attempt = 1; attempt <= 3; attempt += 1)", self.script)
        self.assertIn("await tile.click({ timeout: 4000, force: true });", self.script)
        self.assertIn("timeout: 8000", self.script)
        self.assertIn("after 3 attempts", self.script)

    def test_asset_uuid_lookup_waits_for_lazy_loaded_thumbnail_and_rejects_ambiguity(self):
        self.assertIn("const thumbnailDeadline = Date.now() + 7000;", self.script)
        self.assertIn("flow-content/image/<uuid>", self.script)
        self.assertIn("if (existingCount === 1 && existingUuids.size === 1)", self.script)
        self.assertIn("else if (existingUuids.size > 1 || existingCount > 1)", self.script)

    def test_job_can_pin_existing_flow_asset_uuids_by_path(self):
        self.assertIn("reference_asset_uuids", self.script)
        self.assertIn("flow_asset_uuid", self.script)
        self.assertIn("asset_library_reused_explicit_uuid", self.script)
        self.assertIn("Job explicitly requested Flow asset UUID", self.script)
        self.assertIn("Conflicting Flow asset UUID declarations", self.script)

    def test_upload_uuid_detection_checks_all_same_name_cards(self):
        self.assertIn("Inspect every same-name card, not only the first one", self.script)
        self.assertIn("const cards = Array.from(document.querySelectorAll(selector)).filter(asset =>", self.script)
        self.assertIn("uuids.some(uuid => !oldUuids.includes(uuid))", self.script)

    def test_baseline_reports_uuid_count_sample_and_retries_tile_open(self):
        self.assertIn("baseline_media_inventory_summary", self.script)
        self.assertIn("uuid_count: baselineUuids.length", self.script)
        self.assertIn("uuid_sample_first_5: baselineUuids.slice(0, 5)", self.script)
        self.assertIn("reached_bottom: initialScan.reachedBottom", self.script)
        self.assertIn("Retrying media UUID lookup for tile index", self.script)

    def test_account_button_visibility_is_retried_without_changing_page_fields(self):
        self.assertIn("Google account button remained unavailable after 3 read-only visibility checks", self.script)
        self.assertIn("await page.keyboard.press(\"Escape\")", self.script)

    def test_cleanup_uses_observed_empty_state_when_click_times_out(self):
        self.assertIn("afterClickChips !== 0", self.script)
        self.assertIn("afterClickValue", self.script)
        self.assertIn("let removeClickError = null;", self.script)
        self.assertIn("State change, not click return, is decisive", self.script)

if __name__ == "__main__":
    unittest.main()

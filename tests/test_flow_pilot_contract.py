"""Static safety contract checks for the human-gated Flow pilot runner."""
import unittest
from pathlib import Path


class FlowPilotContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (Path(__file__).parents[1] / "scripts" / "flow-pilot.mjs").read_text(encoding="utf-8")

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

    def test_waits_for_settings_model_selector_after_opening_settings(self):
        self.assertIn('chosen.page.locator(selectors.model).waitFor({ state: "visible", timeout: 5000 })', self.script)
        self.assertIn("Model selector did not become visible within 5000ms", self.script)

    def test_waits_for_model_option_after_opening_model_menu(self):
        self.assertIn('option.waitFor({ state: "visible", timeout: 5000 })', self.script)
        self.assertIn("Model option did not become visible within 5000ms", self.script)

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
        self.assertIn('settings_trigger).click({ timeout: 1500 })', self.script)

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

    def test_credit_cost_is_reported_and_overlay_is_closed_before_prompt_fill(self):
        self.assertIn("Generating will use", self.script)
        self.assertIn("estimated_credit_cost", self.script)
        self.assertIn("settingsAgain.click({ timeout: 2500 })", self.script)
        self.assertLess(self.script.index("settingsAgain.click"), self.script.index("await prompt.fill(scene.prompt"))

    def test_ambiguous_submission_is_logged_without_retry(self):
        self.assertIn('event: "submission_intent"', self.script)
        self.assertIn('event: "submission_outcome_unknown"', self.script)
        self.assertIn('status: "unknown_do_not_retry"', self.script)
        self.assertNotIn("while (", self.script)
        self.assertNotIn("for (;;)", self.script)

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
        self.assertIn('uploadSceneReferences(chosen.page, selectors, referenceImages)', self.script)
        self.assertLess(self.script.index('await uploadSceneReferences(chosen.page, selectors, referenceImages)'), self.script.index('await prompt.fill(scene.prompt'))
        self.assertIn('reference_image_count: referenceImages.length', self.script)
        self.assertIn('ingredient_reference_items', self.script)
        self.assertIn('Stopping before prompt fill/Create', self.script)
        self.assertNotIn('--character-profile', self.script)
        self.assertNotIn('character_id', self.script)


if __name__ == "__main__":
    unittest.main()

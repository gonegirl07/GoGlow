"""Static safety contract checks for the human-gated Flow pilot runner."""
import unittest
from pathlib import Path


class FlowPilotContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = (Path(__file__).parents[1] / "scripts" / "flow-pilot.mjs").read_text(encoding="utf-8")

    def test_uses_only_the_configured_local_cdp_endpoint(self):
        self.assertIn('const CDP_ENDPOINT = "http://127.0.0.1:9224"', self.script)
        self.assertIn("chromium.connectOverCDP(CDP_ENDPOINT)", self.script)
        self.assertNotIn("page.goto(", self.script)

    def test_dry_run_is_default_and_does_not_reach_create_click(self):
        self.assertIn("if (!args.execute)", self.script)
        self.assertIn("DRY RUN COMPLETE: stopped before clicking Create", self.script)
        self.assertIn('if (!args.execute) {', self.script)
        self.assertIn('await finalButton.click({ timeout: 5000 })', self.script)

    def test_requires_account_credit_and_second_create_confirmation(self):
        self.assertIn("CONFIRM ACCOUNT ${args.accountLabel} HAS CREDIT", self.script)
        self.assertIn("CREATE ONE VIDEO FOR ${scene.scene_id}", self.script)
        self.assertIn('scene.model !== "Omni 1.1 Flash" || scene.resolution !== "360p"', self.script)

    def test_ambiguous_submission_is_logged_without_retry(self):
        self.assertIn('event: "submission_intent"', self.script)
        self.assertIn('event: "submission_outcome_unknown"', self.script)
        self.assertIn('status: "unknown_do_not_retry"', self.script)
        self.assertNotIn("while (", self.script)
        self.assertNotIn("for (;;)", self.script)

    def test_requires_unique_visible_selectors(self):
        self.assertIn("expected exactly one", self.script)
        self.assertIn("isVisible()", self.script)
        self.assertIn("create_button_enabled", self.script)


if __name__ == "__main__":
    unittest.main()

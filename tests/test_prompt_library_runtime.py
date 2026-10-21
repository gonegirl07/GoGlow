"""Contract tests for the Phase 1 prompt-library preview runtime."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PromptLibraryRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
        cls.runtime = (ROOT / "app" / "prompt-library.js").read_text(encoding="utf-8")
        cls.seed = (ROOT / "examples" / "prompt-library.seed.json").read_text(encoding="utf-8")

    def test_runtime_is_loaded_before_app_and_panel_is_present(self):
        self.assertIn('<script src="prompt-library.js"></script>', self.html)
        self.assertIn("function promptLibraryPanel(s,i)", self.html)
        self.assertIn("data-act='prompt-preview'", self.html)
        self.assertIn("data-act='prompt-apply'", self.html)

    def test_preview_is_explicit_and_never_applied_during_render(self):
        self.assertIn("Đã tạo preview; prompt gốc chưa thay đổi.", self.html)
        self.assertIn("if(!s.prompt_preview)", self.html)
        self.assertIn('s.prompt=s.prompt_preview', self.html)
        self.assertNotIn("s.prompt=window.GoGlowPromptLibrary.compose", self.html)

    def test_candidate_rules_are_warnings_and_not_auto_appended(self):
        self.assertIn('status: "candidate"', self.runtime)
        self.assertIn("Candidate", self.html)
        self.assertIn("include_candidate_realtime", self.runtime)
        self.assertIn('if (options && options.include_candidate_realtime === true)', self.runtime)
        self.assertIn('"behavior": "auto_append"', self.seed)
        self.assertIn("Candidate rules, including explicit-real-time, are warnings only here.", self.runtime)

    def test_warrior_rule_is_narrowly_scoped(self):
        for marker in (
            'String(project.character_name || "").trim().toLocaleLowerCase() === "mai"',
            'project.activity === "yoga"',
            '/warrior[\\s-]*ii|warrior 2/i.test(all)',
            '/omni\\s*1\\.1\\s*flash/i',
            'String(project.aspect_ratio || "") === "9:16"',
            'includes("warrior-still-v4")',
            'includes("mai-face")',
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.runtime)

    def test_prompt_composer_fills_outfit_and_room_placeholders(self):
        self.assertIn("Outfit matching the selected reference, chest and upper torso fully covered, SFW.", self.runtime)
        self.assertIn("A bright, uncluttered yoga studio.", self.runtime)
        self.assertIn("function uniqueLines(parts)", self.runtime)
        self.assertIn("return uniqueSentences(parts).join", self.runtime)
        self.assertIn('scene.prompt ? "Existing prompt details: " + scene.prompt : ""', self.runtime)

    def test_warnings_are_non_blocking_and_prompt_is_not_silently_rewritten(self):
        self.assertIn("warnings", self.runtime)
        self.assertIn("warn-weight-shift", self.runtime)
        self.assertIn("warn-time-coded-static-pose", self.runtime)
        self.assertIn("warn-shoulder-roll-ambiguity", self.runtime)
        self.assertIn("warn-platform-branding", self.runtime)
        self.assertIn("s.prompt_preview=result.text", self.html)
        self.assertIn("delete s.qc_report;s.qc_draft=blankQcDraft(s)", self.html)
        self.assertIn("s.status=\"QC_REVIEW\"", self.html)


if __name__ == "__main__":
    unittest.main()

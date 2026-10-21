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
        self.assertIn("s.prompt=s.prompt_preview", self.html)
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

    def test_prompt_composer_uses_english_fallbacks_without_using_brief_as_environment_fallback(self):
        self.assertIn("Outfit matching the selected reference, chest and upper torso fully covered, SFW.", self.runtime)
        self.assertIn("A bright, uncluttered yoga studio.", self.runtime)
        self.assertIn('String(scene.environment || "").trim()', self.runtime)
        self.assertNotIn("scene.environment || scene.location || project.brief", self.runtime)
        self.assertIn('environment:""', self.html)
        self.assertIn('"Hold the pose with only gentle breathing and a soft blink."', self.html)
        self.assertNotIn('"Di chuyển chậm vào tư thế bắt đầu, chuyển trọng lượng rõ ràng."', self.html)
        self.assertIn('s.prompt_origin="app-generated"', self.html)

    def test_reapplying_composed_prompt_does_not_nest_existing_prompt(self):
        self.assertIn('scene.prompt_origin === "app-generated" || scene.prompt_origin === "library-composed"', self.runtime)
        self.assertIn("scene.prompt_library_base_prompt !== undefined", self.runtime)
        self.assertIn('const priorPrompt=s.prompt;s.prompt=s.prompt_preview', self.html)
        self.assertIn('s.prompt_origin="library-composed"', self.html)
        self.assertIn('s.prompt_library_base_prompt=(s.prompt_origin==="app-generated"||s.prompt_origin==="library-composed")?"":(priorPrompt||"")', self.html)

    def test_applied_and_warning_rule_ids_are_distinct_and_deduplicated(self):
        self.assertIn("applied_rule_ids: Array.from(new Set(appliedRuleIds))", self.runtime)
        self.assertIn("warning_rule_ids: Array.from(new Set(analysis.warnings.map(w => w.rule_id)))", self.runtime)
        self.assertIn("prompt_preview_meta.applied_rule_ids", self.html)
        self.assertIn("prompt_preview_meta.warning_rule_ids", self.html)
        self.assertNotIn("prompt_preview_meta.rule_ids", self.html)
        self.assertIn("Applied rules:", self.html)
        self.assertIn("Warning rules:", self.html)

    def test_stale_preview_is_cleared_immediately_after_inputs_or_options_change(self):
        self.assertIn("function clearPromptPreview(s,card)", self.html)
        self.assertIn("function invalidateAllPromptPreviews()", self.html)
        self.assertIn("clearPromptPreview(s,card);render()", self.html)
        self.assertIn("s.prompt_preview_options={include_confirmed_stable_hold:", self.html)
        self.assertIn('promptSettingIds.forEach', self.html)
        self.assertIn('invalidateAllPromptPreviews()', self.html)
        self.assertIn('data-prompt-preview', self.html)
        self.assertIn('apply.disabled=true', self.html)

    def test_warnings_are_non_blocking_and_qc_is_invalidated_on_apply(self):
        self.assertIn("warn-weight-shift", self.runtime)
        self.assertIn("warn-time-coded-static-pose", self.runtime)
        self.assertIn("warn-shoulder-roll-ambiguity", self.runtime)
        self.assertIn("warn-platform-branding", self.runtime)
        self.assertIn("s.prompt_preview=result.text", self.html)
        self.assertIn("function promptPreviewSnapshot(s,p,opts)", self.html)
        self.assertIn("meta.snapshot!==promptPreviewSnapshot(s,settings(),meta.options||{})", self.html)
        self.assertIn("Dữ liệu đã đổi sau khi tạo preview", self.html)
        self.assertIn("delete s.qc_report;s.qc_draft=blankQcDraft(s)", self.html)
        self.assertIn('s.media_uri="";s.media_uri_360p="";s.media_uri_720p=""', self.html)
        self.assertIn('s.status="WAITING_FOR_GENERATION"', self.html)
        self.assertIn('s.status="PROMPT_REVISED"', self.html)


    def test_prompt_output_must_be_english_and_blocks_apply_export_and_copy(self):
        import re

        validator = re.compile(r"[^\x09\x0a\x0d\x20-\x7e]")
        self.assertIsNone(validator.search("Mai holds Warrior II with gentle breathing."))
        self.assertIsNone(validator.search("Mai dung yen trong tu the Chien binh II"), "ASCII-only validation cannot infer language from unaccented words.")
        self.assertIsNotNone(validator.search("Ｍａｉ"))
        self.assertIsNotNone(validator.search("café"))
        self.assertIsNotNone(validator.search("Mai 🙂"))
        self.assertIsNotNone(validator.search("Đứng yên trong tư thế."))
        self.assertIsNotNone(validator.search("a\u0301"))
        self.assertIn("function validateEnglishPrompt(text, fieldLabel)", self.runtime)
        self.assertIn(r"const re = /[^\x09\x0A\x0D\x20-\x7E]/g", self.runtime)
        self.assertIn("validateEnglishPrompt", self.runtime)
        self.assertIn('"Project brief: " + String(project.brief).trim()', self.runtime)
        self.assertIn('activityNames={cycling:"cycling",yoga:"yoga",dance:"dance",fashion:"fashion",other:"general action"}', self.html)
        self.assertIn("previewCheck.valid", self.html)
        self.assertIn('validateEnglishPrompt(s.prompt_preview,"Scene "+(i+1)+" preview prompt")', self.html)
        self.assertIn('validateEnglishPrompt(s.prompt||"","Scene "+(i+1)+" prompt")', self.html)
        self.assertIn('validateEnglishPrompt(p.brief||"","Project brief (Ý tưởng / bối cảnh)")', self.html)
        self.assertIn('validateEnglishPrompt(s.prompt||"","Scene "+(i+1)+" prompt")', self.html)
        self.assertIn("Chặn Apply: prompt phải hoàn toàn bằng tiếng Anh.", self.html)
        self.assertIn("Brief dự án phải bằng tiếng Anh vì được đưa vào prompt Flow.", self.html)
        self.assertIn('validateEnglishPrompt(p.brief||"","Project brief (Ý tưởng / bối cảnh)")', self.html)
        self.assertIn('validateEnglishPrompt(s.prompt_preview,"Scene "+(i+1)+" preview prompt")', self.html)
        self.assertIn("A clean, well-lit setting appropriate to the activity, with natural light and realistic movement.", self.html)
        self.assertIn('<textarea id="brief">A clean, well-lit setting appropriate to the activity, with natural light and realistic movement.</textarea>', self.html)
        beats_start = self.html.index("const beats")
        beats = self.html[beats_start:self.html.index("function settings()", beats_start)]
        self.assertIsNone(validator.search(beats), "All default action/start/end/body-mechanics strings must be English.")



if __name__ == "__main__":
    unittest.main()

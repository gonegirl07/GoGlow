"""Static contract tests for the browser generation ledger."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class GenerationLedgerRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
        cls.runtime = (ROOT / "app" / "generation-ledger.js").read_text(encoding="utf-8")
        cls.schema = json.loads((ROOT / "specs" / "generation-attempt.schema.json").read_text(encoding="utf-8"))

    def test_runtime_is_loaded_and_each_scene_exposes_manual_ledger(self):
        self.assertIn('<script src="generation-ledger.js"></script>', self.html)
        self.assertIn("function generationLedgerPanel(s,i)", self.html)
        self.assertIn('data-act=\'ledger-add\'', self.html)
        self.assertIn("GoGlowGenerationLedger.appendAttempt", self.html)

    def test_ledger_is_append_only_and_retries_link_to_previous_attempt(self):
        self.assertIn("scene.generation_attempts.push(record)", self.runtime)
        self.assertIn('retry_of: previous && form.retry_mode === "retry_previous" ? previous.attempt_id : null', self.runtime)
        self.assertIn('value=\'retry_previous\'', self.html)
        self.assertIn('value=\'new\'', self.html)
        self.assertIn("attempt_number: attemptNumber", self.runtime)
        self.assertIn("Lịch sử cũ được giữ nguyên", self.html)
        self.assertIn("generationLedger", self.html)
        self.assertIn("generation_attempts:generationLedger", self.html)
        self.assertIn("ledger-qc-add", self.html)
        self.assertIn("generationLedgerEvents.push", self.html)
        self.assertIn("Project-wide generation ledger (including deleted scenes)", self.html)
        self.assertIn("generation_ledger_events:generationLedgerEvents", self.html)
        self.assertIn("project_id:projectId", self.html)
        self.assertIn("generationLedger", self.html)
        self.assertIn("generation_attempts:generationLedger", self.html)
        self.assertIn("ledger-qc-add", self.html)
        self.assertIn("generationLedgerEvents.push", self.html)

    def test_attempt_captures_exact_prompt_configuration_and_rule_ids(self):
        for marker in ("text: String(scene.prompt || \"\")", "model_label:", "resolution:", "duration_seconds:", "aspect_ratio:", "rule_ids:"):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.runtime)

    def test_failure_requires_category_message_and_retryability(self):
        self.assertIn('const isFailure = status === "failed"', self.runtime)
        self.assertIn("category: form.failure_category || \"unknown\"", self.runtime)
        self.assertIn("retryable: !!form.retryable", self.runtime)
        self.assertIn("Failed result requires failure details.", self.runtime)

    def test_credit_amounts_and_evidence_are_never_invented(self):
        self.assertIn("estimated_amount: nullableNumber(form.estimated_amount)", self.runtime)
        self.assertIn("before_balance: nullableNumber(form.before_balance)", self.runtime)
        self.assertIn("after_balance: nullableNumber(form.after_balance)", self.runtime)
        self.assertIn("estimated credits:", self.html)
        self.assertIn("credits estimated=", self.html)
        self.assertIn("before_balance: nullableNumber(form.before_balance)", self.runtime)
        self.assertIn("after_balance: nullableNumber(form.after_balance)", self.runtime)
        self.assertIn("estimated credits:", self.html)
        self.assertIn("credits estimated=", self.html)
        self.assertIn("actual_amount: nullableNumber(form.actual_amount)", self.runtime)
        self.assertIn('charge_status: form.charge_status || "unknown"', self.runtime)
        self.assertIn('evidence_source: form.evidence_source || "unknown"', self.runtime)
        self.assertIn("Unknown values are left null/unknown", self.runtime)

    def test_qc_and_media_are_snapshotted_at_log_time(self):
        self.assertIn("const qc = scene.qc_report || null", self.runtime)
        self.assertIn("integrity_status:", self.runtime)
        self.assertIn("Copied from the scene QC report at log time", self.runtime)

    def test_attempt_shape_matches_generation_attempt_schema(self):
        required = self.schema["required"]
        for field in ("attempt_id", "project_id", "scene_id", "attempt_number", "provider", "configuration", "prompt", "rule_ids", "result", "credits", "created_by"):
            with self.subTest(field=field):
                self.assertIn(field, required)
        self.assertIn("generation_attempts", self.html)
        self.assertIn("Generation attempts:", self.html)

    def test_markdown_export_includes_attempt_history_and_json_preserves_scene_fields(self):
        self.assertIn("s.generation_attempts.map(a=>", self.html)
        self.assertIn("JSON.stringify(project(),null,2)", self.html)
        self.assertIn("scenes.map(s=>Object.assign({},s", self.html)


if __name__ == "__main__":
    unittest.main()

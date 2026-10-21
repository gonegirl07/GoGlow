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

    def test_project_id_is_not_overwritten_during_export_or_save(self):
        project_fn = self.html.split("function project(){", 1)[1].split("function save(){", 1)[0]
        self.assertIn("project_id:projectId", project_fn)
        self.assertNotIn('project_id:"goglow-"+Date.now()', project_fn)
        self.assertEqual(project_fn.count("project_id:"), 1)

    def test_scene_ids_are_unique_across_rebuild_and_add(self):
        self.assertIn("function newSceneId()", self.html)
        self.assertIn('return "scene-"+crypto.randomUUID()', self.html)
        self.assertGreaterEqual(self.html.count("id:newSceneId()"), 2)
        self.assertNotIn('id:"scene-"+String(i+1).padStart(2,"0")', self.html)
        self.assertIn('generationLedger.filter(a=>a.scene_id===s.id)', self.html)

    def test_attempt_ids_are_globally_unique_even_for_same_second_cross_scene_attempts(self):
        self.assertIn('crypto.randomUUID()', self.runtime)
        self.assertIn('const existingIds = new Set([', self.runtime)
        self.assertIn('project.generation_attempts', self.runtime)
        self.assertIn('while (existingIds.has(attemptId))', self.runtime)
        self.assertNotIn('const attemptId = "attempt-" + timestamp.replace(/[^0-9]/g, "").slice(0, 14) + "-" + attemptNumber', self.runtime)
        self.assertIn('if(!generationLedger.some(x=>x.attempt_id===a.attempt_id))generationLedger.push(a)', self.html)

    def test_markdown_exports_project_id_in_header_and_each_project_ledger_row(self):
        self.assertIn('- Project ID: "+p.project_id', self.html)
        self.assertIn('project_id="+a.project_id+" · "+a.scene_id', self.html)

    def test_markdown_scene_attempts_include_project_and_scene_ids(self):
        self.assertIn('s.generation_attempts.map(a=>"- project_id="+a.project_id+" · "+a.scene_id+" #"+a.attempt_number', self.html)

    def test_markdown_project_archive_preserves_balance_evidence_charge_and_qc(self):
        archive = self.html.split('## Project-wide generation ledger (including deleted scenes)', 1)[1]
        for marker in (
            '· balance="+(a.credits.before_balance==null?"?":a.credits.before_balance)+"→"+(a.credits.after_balance==null?"?":a.credits.after_balance)',
            '· evidence="+(a.credits.evidence_source||"unknown")',
            '· charge="+(a.credits.charge_status||"unknown")',
            '· QC="+(a.qc.status||"not_reviewed")',
            '· estimated="+(a.credits.estimated_amount==null?"unknown":a.credits.estimated_amount)',
            'actual="+(a.credits.actual_amount==null?"unknown":a.credits.actual_amount)',
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, archive)

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

    def test_qc_update_targets_attempt_and_requires_reviewer_and_defects_for_fail(self):
        self.assertIn("function updateAttemptQC(record, form, now)", self.runtime)
        self.assertIn('["not_reviewed", "pass", "fail", "needs_review"]', self.runtime)
        self.assertIn("Reviewer is required to record QC.", self.runtime)
        self.assertIn("QC FAIL requires at least one observed defect.", self.runtime)
        self.assertIn("QC PASS cannot include unresolved defects.", self.runtime)
        self.assertIn('root.GoGlowGenerationLedger = { version: VERSION, makeAttempt, validateAttempt, appendAttempt, updateAttemptQC }', self.runtime)
        self.assertIn('data-ledger="qc_reviewer"', self.html)
        self.assertIn('data-ledger="qc_defects"', self.html)
        self.assertIn("generationLedger.find(item=>item.attempt_id===attemptId&&item.scene_id===s.id)", self.html)
        self.assertIn("window.GoGlowGenerationLedger.updateAttemptQC(attempt,{status,reviewed_by:reviewer,defects,notes})", self.html)
        self.assertIn("generationLedgerEvents.push(event)", self.html)
        self.assertIn("reviewer,defects,notes,created_at:attempt.qc.reviewed_on", self.html)

    def test_flow_jsonl_import_validates_and_appends_without_duplicate_attempt_ids(self):
        self.assertIn('id="importFlowLedger"', self.html)
        self.assertIn('id="flowLedgerFile"', self.html)
        self.assertIn('window.GoGlowGenerationLedger.validateAttempt(records[i])', self.html)
        self.assertIn('const known=new Set(generationLedger.map(record=>record.attempt_id))', self.html)
        self.assertIn('if(known.has(record.attempt_id)){skipped++;continue}', self.html)
        self.assertIn('generationLedger.push(record);known.add(record.attempt_id);added++', self.html)
        self.assertIn('scene.generation_attempts=generationLedger.filter(record=>record.scene_id===scene.id)', self.html)
        self.assertIn('Đã nhập "+added+" attempt vào Generation Ledger', self.html)


if __name__ == "__main__":
    unittest.main()

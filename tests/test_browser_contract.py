"""Static contract tests for the no-build browser prototype."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class BrowserContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / "app" / "index.html").read_text(encoding="utf-8")
        cls.scene_schema = json.loads((ROOT / "specs" / "scene-plan.schema.json").read_text(encoding="utf-8"))
        cls.qc_schema = json.loads((ROOT / "specs" / "qc-report.schema.json").read_text(encoding="utf-8"))

    def test_browser_has_manual_media_and_structured_qc_controls(self):
        for marker in (
            'data-k="media_uri"',
            'data-qc="review_status"',
            'data-qc="check-status"',
            'data-qc="reviewed_by"',
            'data-qc="reviewed_at"',
            'data-act="save-qc"',
            "function buildQcReport",
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.html)

    def test_browser_gates_approval_on_matching_pass_evidence(self):
        for marker in (
            "function canApprove(s)",
            'r.scene_id===s.id',
            'r.media_uri===s.media_uri',
            'r.review_status==="PASS"',
            'r.checks.every(x=>x.status==="PASS")',
            "function availableTransitions(s)",
            's.status==="APPROVED"&&(!canApprove(s))',
        ):
            with self.subTest(marker=marker):
                self.assertIn(marker, self.html)

    def test_scene_schema_allows_qc_draft_and_report(self):
        scene = self.scene_schema["properties"]["scenes"]["items"]
        self.assertIn("qc_draft", scene["properties"])
        self.assertEqual(scene["properties"]["qc_report"]["$ref"], "./qc-report.schema.json")
        self.assertIn("status_history", scene["properties"])
        draft_checks = scene["properties"]["qc_draft"]["properties"]["checks"]["items"]["properties"]
        self.assertIn("category", draft_checks)
        self.assertIn("status", draft_checks)
        self.assertIn("notes", draft_checks)

    def test_qc_report_schema_binds_review_to_media(self):
        self.assertIn("media_uri", self.qc_schema["required"])
        self.assertIn("scene_id", self.qc_schema["required"])
        self.assertIn("reviewed_by", self.qc_schema["required"])
        self.assertIn("reviewed_at", self.qc_schema["required"])

    def test_browser_invalidates_old_clip_evidence_before_regeneration(self):
        self.assertIn("Bắt đầu lượt tạo mới; media URI và báo cáo QC cũ đã được xóa.", self.html)
        self.assertIn("báo cáo đã lưu không còn hiệu lực", self.html)
        self.assertIn("status_history không hợp lệ", self.html)

    def test_browser_disclaims_automatic_media_verification(self):
        self.assertIn("không phải xác minh file hay tự động xem video", self.html)
        self.assertIn("không tự đánh giá video", self.html)


if __name__ == "__main__":
    unittest.main()

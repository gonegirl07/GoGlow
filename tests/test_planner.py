import unittest

from goglow.planner import create_project
from goglow.validator import validate_project
from goglow.exporter import to_markdown


def valid_qc_report(scene_id="scene-01", media_uri="file:///clips/scene-01.mp4"):
    return {
        "scene_id": scene_id,
        "review_status": "PASS",
        "checks": [
            {"category": "identity", "status": "PASS", "notes": "Identity visually checked."},
            {"category": "physics", "status": "PASS", "notes": "Movement visually checked."},
        ],
        "defects": [],
        "reviewed_by": "Human reviewer",
        "reviewed_at": "2026-10-21T10:00:00+00:00",
        "media_uri": media_uri,
    }


class PlannerTests(unittest.TestCase):
    def test_default_plan_is_36_seconds(self):
        project = create_project("cycling")
        self.assertEqual(sum(s["duration_seconds"] for s in project["scenes"]), 36)
        self.assertEqual(validate_project(project), [])
        self.assertTrue(all(s["status_history"] == ["PLANNED"] for s in project["scenes"]))

    def test_uneven_duration_is_distributed_without_losing_seconds(self):
        project = create_project("dance", target_duration_seconds=37, scene_count=4)
        self.assertEqual([s["duration_seconds"] for s in project["scenes"]], [10, 9, 9, 9])
        self.assertEqual(validate_project(project), [])

    def test_accepts_minimum_duration_of_30_seconds(self):
        project = create_project("yoga", target_duration_seconds=30, scene_count=3)
        self.assertEqual(sum(s["duration_seconds"] for s in project["scenes"]), 30)
        self.assertEqual(validate_project(project), [])

    def test_rejects_duration_below_30_seconds(self):
        with self.assertRaises(ValueError):
            create_project("yoga", target_duration_seconds=29)

    def test_rejects_unknown_activity(self):
        with self.assertRaises(ValueError):
            create_project("skydiving")

    def test_duplicate_scene_ids_are_invalid(self):
        project = create_project("fashion")
        project["scenes"][1]["id"] = project["scenes"][0]["id"]
        self.assertTrue(any("Duplicate scene id" in e for e in validate_project(project)))

    def test_scene_total_must_match_target(self):
        project = create_project("cycling")
        project["scenes"][0]["duration_seconds"] += 1
        self.assertTrue(any("durations total" in e for e in validate_project(project)))

    def test_generated_state_requires_nonempty_media_reference(self):
        project = create_project("cycling")
        scene = project["scenes"][0]
        scene["status"] = "GENERATED"
        scene["status_history"] = ["PLANNED", "PROMPT_READY", "WAITING_FOR_GENERATION", "GENERATED"]
        self.assertTrue(any("requires a non-empty media_uri" in e for e in validate_project(project)))

    def test_approved_state_rejects_fake_uri_without_qc_report(self):
        project = create_project("cycling")
        scene = project["scenes"][0]
        scene["status"] = "APPROVED"
        scene["status_history"] = ["PLANNED", "PROMPT_READY", "WAITING_FOR_GENERATION", "GENERATED", "QC_REVIEW", "APPROVED"]
        scene["media_uri"] = "file:///fake.mp4"
        errors = validate_project(project)
        self.assertTrue(any("qc_report must be an object" in e for e in errors))

    def test_approved_state_requires_pass_qc_report_and_reviewer(self):
        project = create_project("cycling")
        scene = project["scenes"][0]
        scene["status"] = "APPROVED"
        scene["status_history"] = ["PLANNED", "PROMPT_READY", "WAITING_FOR_GENERATION", "GENERATED", "QC_REVIEW", "APPROVED"]
        scene["media_uri"] = "file:///clips/scene-01.mp4"
        scene["qc_report"] = valid_qc_report(scene["id"], scene["media_uri"])
        self.assertEqual(validate_project(project), [])

    def test_approved_state_requires_qc_report_for_same_media(self):
        project = create_project("cycling")
        scene = project["scenes"][0]
        scene["status"] = "APPROVED"
        scene["status_history"] = ["PLANNED", "PROMPT_READY", "WAITING_FOR_GENERATION", "GENERATED", "QC_REVIEW", "APPROVED"]
        scene["media_uri"] = "file:///clips/scene-01.mp4"
        report = valid_qc_report(scene["id"], "file:///clips/other.mp4")
        scene["qc_report"] = report
        self.assertTrue(any("must match the scene media_uri" in e for e in validate_project(project)))

    def test_approved_state_rejects_qc_report_not_passed(self):
        project = create_project("cycling")
        scene = project["scenes"][0]
        scene["status"] = "APPROVED"
        scene["status_history"] = ["PLANNED", "PROMPT_READY", "WAITING_FOR_GENERATION", "GENERATED", "QC_REVIEW", "APPROVED"]
        scene["media_uri"] = "file:///clips/scene-01.mp4"
        report = valid_qc_report(scene["id"], scene["media_uri"])
        report["review_status"] = "REVIEW"
        scene["qc_report"] = report
        self.assertTrue(any("review_status must be PASS" in e for e in validate_project(project)))

    def test_status_history_rejects_skipped_transitions(self):
        project = create_project("cycling")
        scene = project["scenes"][0]
        scene["status"] = "APPROVED"
        scene["status_history"] = ["PLANNED", "APPROVED"]
        scene["media_uri"] = "file:///clips/scene-01.mp4"
        scene["qc_report"] = valid_qc_report(scene["id"], scene["media_uri"])
        self.assertTrue(any("invalid transition PLANNED -> APPROVED" in e for e in validate_project(project)))

    def test_status_history_must_end_at_current_status(self):
        project = create_project("cycling")
        scene = project["scenes"][0]
        scene["status"] = "PROMPT_READY"
        scene["status_history"] = ["PLANNED"]
        self.assertTrue(any("must end with the current status" in e for e in validate_project(project)))

    def test_validator_handles_malformed_activity_and_status_types(self):
        project = create_project("cycling")
        project["activity"] = []
        project["scenes"][0]["status"] = []
        errors = validate_project(project)
        self.assertTrue(any("activity must be one of" in e for e in errors))
        self.assertTrue(any("status is not a recognized" in e for e in errors))

    def test_validator_rejects_non_finite_duration(self):
        project = create_project("cycling")
        project["scenes"][0]["duration_seconds"] = float("nan")
        self.assertTrue(any("finite positive number" in e for e in validate_project(project)))

    def test_export_contains_prompt_and_disclaimer(self):
        project = create_project("yoga")
        markdown = to_markdown(project)
        self.assertIn("### Prompt", markdown)
        self.assertIn("does not mean generation or visual QC has occurred", markdown)


if __name__ == "__main__":
    unittest.main()

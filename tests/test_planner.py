import unittest

from goglow.planner import create_project
from goglow.validator import validate_project
from goglow.exporter import to_markdown

class PlannerTests(unittest.TestCase):
    def test_default_plan_is_36_seconds(self):
        project = create_project("cycling")
        self.assertEqual(sum(s["duration_seconds"] for s in project["scenes"]), 36)
        self.assertEqual(validate_project(project), [])

    def test_uneven_duration_is_distributed_without_losing_seconds(self):
        project = create_project("dance", target_duration_seconds=37, scene_count=4)
        self.assertEqual([s["duration_seconds"] for s in project["scenes"]], [10, 9, 9, 9])
        self.assertEqual(validate_project(project), [])

    def test_rejects_short_duration(self):
        with self.assertRaises(ValueError):
            create_project("yoga", target_duration_seconds=30)

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

    def test_generated_state_requires_media_reference(self):
        project = create_project("cycling")
        project["scenes"][0]["status"] = "GENERATED"
        self.assertTrue(any("requires media_uri" in e for e in validate_project(project)))

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

"""Contract tests for the proposed prompt-rule and generation-attempt seed data."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class PromptAndGenerationSeedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rule_schema = json.loads((ROOT / "specs" / "prompt-rule.schema.json").read_text(encoding="utf-8"))
        cls.attempt_schema = json.loads((ROOT / "specs" / "generation-attempt.schema.json").read_text(encoding="utf-8"))
        cls.rules = json.loads((ROOT / "examples" / "prompt-rules.seed.json").read_text(encoding="utf-8"))
        cls.attempts = json.loads((ROOT / "examples" / "generation-attempts.seed.json").read_text(encoding="utf-8"))

    def test_schemas_are_versioned_and_expose_evidence_fields(self):
        self.assertEqual(self.rule_schema["properties"]["schema_version"]["const"], "1.0")
        self.assertIn("evidence", self.rule_schema["required"])
        self.assertIn("provenance", self.rule_schema["required"])
        self.assertIn("credits", self.attempt_schema["required"])
        self.assertIn("result", self.attempt_schema["required"])
        self.assertIn("rule_ids", self.attempt_schema["required"])
        self.assertIn("null", self.attempt_schema["properties"]["started_on"]["type"])

    def test_first_rule_is_narrowly_scoped_and_confirmed_with_one_pass(self):
        self.assertEqual(len(self.rules["rules"]), 1)
        rule = self.rules["rules"][0]
        self.assertEqual(rule["rule_id"], "yoga.warrior-ii.stable-hold-breathe")
        self.assertEqual(rule["status"], "confirmed")
        self.assertEqual(rule["scope"]["pose_ids"], ["warrior-ii"])
        self.assertEqual(rule["scope"]["model_labels"], ["Omni 1.1 Flash"])
        passes = [item for item in rule["evidence"] if item["kind"] == "pass"]
        failures = [item for item in rule["evidence"] if item["kind"] == "fail"]
        self.assertEqual(len(passes), 1)
        self.assertEqual((passes[0]["qc_passed"], passes[0]["qc_total"]), (7, 7))
        self.assertEqual(len(failures), 2)
        self.assertIn("Exact prompt text was not supplied", failures[0]["summary"])

    def test_success_prompt_is_verbatim_and_attempts_are_append_only(self):
        rule = self.rules["rules"][0]
        expected = (
            "Mai, the woman in the reference image, same face, hair, sage-green high-neck longline sports top and dark grey yoga leggings, bright yoga studio. "
            "The shot starts already in the exact Warrior II pose of the reference image with the same wide full-body framing, empty space on both sides, both hands inside the frame. "
            "Static locked-off camera. She holds the pose calmly: only gentle breathing in the chest and shoulders and a soft blink. "
            "Feet, legs, hips and arms stay still. Natural hands. Single continuous shot, real-time. No text."
        )
        self.assertEqual(rule["instructions"]["exact_prompt_fragment"], expected)
        attempts = self.attempts["attempts"]
        self.assertEqual(len(attempts), 3)
        self.assertEqual([a["result"]["status"] for a in attempts], ["succeeded", "succeeded", "succeeded"])
        self.assertEqual([a["qc"]["status"] for a in attempts], ["fail", "fail", "pass"])
        self.assertTrue(all(a["started_on"] is None for a in attempts))
        self.assertTrue(all(a["credits"]["actual_amount"] is None for a in attempts))
        self.assertEqual(attempts[2]["configuration"]["pose_reference_id"], "warrior-still-v4")
        self.assertEqual(attempts[2]["configuration"]["face_reference_id"], "mai-face")

    def test_attempt_records_do_not_claim_unknown_credit_or_direct_download(self):
        attempts = self.attempts["attempts"]
        self.assertTrue(all(a["credits"]["charge_status"] == "unknown" for a in attempts))
        self.assertTrue(all(a["credits"]["evidence_source"] == "unknown" for a in attempts))
        self.assertIsNone(attempts[0]["prompt"]["sha256"])
        self.assertIn("not a verified direct-download URI", attempts[2]["qc"]["notes"])


if __name__ == "__main__":
    unittest.main()

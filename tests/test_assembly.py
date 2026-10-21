"""Unit tests for guarded FFmpeg assembly; real media rendering is covered by the manual QA guide."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from goglow.assembly import AssemblyError, assemble_reel


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source.mp4"
        self.source.write_bytes(b"fixture-placeholder")
        self.manifest = self.root / "clips.json"
        self.output = self.root / "reel.mp4"

    def write_manifest(self, clips):
        self.manifest.write_text(json.dumps({"clips": clips}), encoding="utf-8")

    def clip(self, **overrides):
        value = {
            "scene_id": "scene-1",
            "path": "source.mp4",
            "approved": True,
            "qc_status": "PASS",
            "media_uri": "file://source.mp4",
        }
        value.update(overrides)
        return value

    def test_requires_explicit_approval_and_qc_pass(self):
        for changes, expected in [
            ({"approved": False}, "not explicitly approved"),
            ({"approved": "true"}, "not explicitly approved"),
            ({"qc_status": "REVIEW"}, "qc_status='PASS'"),
        ]:
            with self.subTest(changes=changes):
                self.write_manifest([self.clip(**changes)])
                with self.assertRaisesRegex(AssemblyError, expected):
                    assemble_reel(self.manifest, self.output)

    def test_rejects_duplicate_scene_ids_and_missing_sources(self):
        self.write_manifest([self.clip(), self.clip(path="source.mp4")])
        with self.assertRaisesRegex(AssemblyError, "Duplicate scene_id"):
            assemble_reel(self.manifest, self.output)
        self.write_manifest([self.clip(path="missing.mp4")])
        with patch("goglow.assembly._require_tool", side_effect=lambda name: name):
            with self.assertRaisesRegex(AssemblyError, "does not exist"):
                assemble_reel(self.manifest, self.output)

    def test_rejects_short_timeline_before_running_ffmpeg(self):
        self.write_manifest([self.clip()])
        with patch("goglow.assembly._require_tool", side_effect=lambda name: name), \
             patch("goglow.assembly._probe", return_value={
                 "duration_seconds": 8.0, "has_audio": False, "video_codec": "h264",
                 "width": 640, "height": 360,
             }), patch("goglow.assembly._run") as run:
            with self.assertRaisesRegex(AssemblyError, "below the required"):
                assemble_reel(self.manifest, self.output, min_duration_seconds=30)
            run.assert_not_called()

    def test_rejects_output_overwrite_without_force(self):
        self.output.write_bytes(b"keep-me")
        self.write_manifest([self.clip()])
        with self.assertRaisesRegex(AssemblyError, "Use --force"):
            assemble_reel(self.manifest, self.output)
        self.assertEqual(self.output.read_bytes(), b"keep-me")

    def test_success_creates_output_and_sidecar_with_order_and_qc(self):
        self.write_manifest([
            self.clip(scene_id="scene-a"),
            self.clip(scene_id="scene-b"),
        ])

        def fake_run(command):
            target = Path(command[-1])
            target.write_bytes(b"fake-mp4")
            from subprocess import CompletedProcess
            return CompletedProcess(command, 0, stdout="", stderr="")

        def fake_probe(path, ffprobe):
            return {
                "duration_seconds": 20.0 if Path(path) == self.source else 40.0,
                "has_audio": True,
                "video_codec": "h264",
                "width": 1080,
                "height": 1920,
            }

        with patch("goglow.assembly._require_tool", side_effect=lambda name: name), \
             patch("goglow.assembly._probe", side_effect=fake_probe), \
             patch("goglow.assembly._run", side_effect=fake_run):
            result = assemble_reel(self.manifest, self.output)

        self.assertTrue(self.output.is_file())
        sidecar = self.output.with_suffix(".manifest.json")
        self.assertTrue(sidecar.is_file())
        data = json.loads(sidecar.read_text(encoding="utf-8"))
        self.assertEqual([c["scene_id"] for c in data["clips"]], ["scene-a", "scene-b"])
        self.assertTrue(all(c["qc_status"] == "PASS" for c in data["clips"]))
        self.assertEqual(result["duration_seconds"], 40.0)


if __name__ == "__main__":
    unittest.main()

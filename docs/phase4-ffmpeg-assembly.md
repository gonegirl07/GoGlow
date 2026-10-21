# Phase 4 — Local FFmpeg Reel assembly

This command assembles a manually curated list of approved clips. It does not call Google Flow, fetch remote media, or decide QC automatically.

## Requirements

- Python 3.10+
- `ffmpeg` and `ffprobe` on PATH (tested target: FFmpeg 7.1.5)
- Source clips already downloaded to local files
- Human approval and a QC result of `PASS` for every clip

## Manifest

Start from `examples/reel-manifest.example.json`. Paths are resolved relative to the manifest file unless absolute. List clips in the exact intended Reel order. Each clip must have a unique `scene_id`, `approved: true`, and `qc_status: "PASS"`. Optional trim points are in seconds; `trim_end_seconds: null` means use the end of the source. `media_uri` is provenance text only and is not fetched.

Example:

```json
{
  "clips": [
    {
      "scene_id": "scene-01",
      "path": "media/scene-01.mp4",
      "approved": true,
      "qc_status": "PASS",
      "media_uri": "file://media/scene-01.mp4",
      "trim_start_seconds": 0,
      "trim_end_seconds": null
    }
  ]
}
```

A single short clip will be rejected if the selected timeline is shorter than 30 seconds. Add enough approved clips to reach the minimum; do not lower the threshold merely to make a failed test pass.

## Run

```bash
python -m pip install -e .
goglow assemble examples/reel-manifest.example.json --out output/reel.mp4
```

Default output is 1080x1920 (9:16), 30 FPS, H.264 video, AAC stereo audio. Each clip is normalized to common dimensions, frame rate, sample aspect ratio, pixel format, and audio layout before concatenation. Missing audio is filled with silence. Source files are never modified.

Output includes:
- `reel.mp4`
- `reel.manifest.json` with clip order, source paths, trims, QC status, duration and output encoding metadata

The output path must not already exist unless `--force` is supplied. With `--force`, the existing output is removed before rendering; use it deliberately. The sidecar manifest is updated alongside a successful render.

## Manual QA checklist

1. Run `ffmpeg -version` and `ffprobe -version`; confirm the expected version and that both commands work.
2. Prepare three local test clips totalling at least 30 seconds, with mixed dimensions/frame rates and at least one clip without audio.
3. Mark every clip `approved: true` and `qc_status: "PASS"`; render and inspect playback, portrait framing, clip order, sound and duration.
4. Change one clip to `approved: false`, then separately to `qc_status: "REVIEW"`; each run must fail before rendering.
5. Test a missing source file, duplicate scene ID, invalid trim, and total duration below 30 seconds; each must fail with an actionable message.
6. Render to an existing path without `--force`; it must refuse and preserve the existing bytes.
7. Inspect the sidecar manifest and verify it preserves the input clip order and trim information.
8. Run all Python unit tests and the existing browser regression suite before requesting merge.

## Known scope limits

- QC approval is an explicit human assertion in the manifest, not an automated inspection of the pixels.
- Only local media paths are supported; remote URLs are not downloaded.
- No transitions, subtitles, music mixing, loudness normalization, watermark detection, or upload/publish action is performed.
- The default output is vertical 1080x1920; choose other dimensions only deliberately.

"""Assemble human-approved clips into a normalized vertical Reel using local FFmpeg.

The module intentionally requires explicit approval and QC PASS evidence in the input
manifest. It never edits source media and never overwrites output unless requested.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any


class AssemblyError(ValueError):
    """A safe, actionable assembly validation or FFmpeg error."""


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, check=False, capture_output=True, text=True)
    except OSError as exc:
        raise AssemblyError(f"Cannot execute {command[0]}: {exc}") from exc


def _require_tool(name: str) -> str:
    executable = shutil.which(name)
    if not executable:
        raise AssemblyError(f"Required executable '{name}' was not found on PATH.")
    return executable


def _probe(path: Path, ffprobe: str) -> dict[str, Any]:
    result = _run([
        ffprobe, "-v", "error", "-show_streams", "-show_format",
        "-of", "json", str(path),
    ])
    if result.returncode:
        detail = result.stderr.strip() or "ffprobe could not read the media"
        raise AssemblyError(f"Cannot probe '{path}': {detail}")
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssemblyError(f"Invalid ffprobe output for '{path}'.") from exc
    streams = data.get("streams") or []
    videos = [s for s in streams if s.get("codec_type") == "video"]
    if not videos:
        raise AssemblyError(f"'{path}' has no video stream.")
    try:
        duration = float(data.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0:
        durations = [float(s["duration"]) for s in streams if s.get("duration")]
        duration = max(durations, default=0.0)
    if duration <= 0:
        raise AssemblyError(f"Cannot determine a positive duration for '{path}'.")
    return {
        "duration_seconds": duration,
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
        "video_codec": videos[0].get("codec_name"),
        "width": videos[0].get("width"),
        "height": videos[0].get("height"),
    }


def _load_manifest(path: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise AssemblyError(f"Cannot read manifest '{path}': {exc}") from exc
    except json.JSONDecodeError as exc:
        raise AssemblyError(
            f"Invalid JSON in manifest at line {exc.lineno}, column {exc.colno}: {exc.msg}"
        ) from exc
    clips = data.get("clips") if isinstance(data, dict) else None
    if not isinstance(clips, list) or not clips:
        raise AssemblyError("Manifest must contain a non-empty 'clips' array.")
    seen: set[str] = set()
    for index, clip in enumerate(clips, 1):
        if not isinstance(clip, dict):
            raise AssemblyError(f"Clip #{index} must be an object.")
        scene_id = str(clip.get("scene_id", "")).strip()
        if not scene_id:
            raise AssemblyError(f"Clip #{index} is missing scene_id.")
        if scene_id in seen:
            raise AssemblyError(f"Duplicate scene_id '{scene_id}' in manifest.")
        seen.add(scene_id)
        if clip.get("approved") is not True:
            raise AssemblyError(f"Scene '{scene_id}' is not explicitly approved; refusing to assemble.")
        if str(clip.get("qc_status", "")).upper() != "PASS":
            raise AssemblyError(f"Scene '{scene_id}' must have qc_status='PASS'.")
        media_path = clip.get("path")
        if not isinstance(media_path, str) or not media_path.strip():
            raise AssemblyError(f"Scene '{scene_id}' is missing a media path.")
        for key in ("trim_start_seconds", "trim_end_seconds"):
            value = clip.get(key)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0):
                raise AssemblyError(f"Scene '{scene_id}' has invalid {key}; expected a non-negative number.")
    return clips


def assemble_reel(
    manifest_path: str | Path,
    output_path: str | Path,
    *,
    width: int = 1080,
    height: int = 1920,
    fps: int = 30,
    min_duration_seconds: float = 30.0,
    force: bool = False,
) -> dict[str, Any]:
    """Validate and assemble clips; return a manifest of the generated output."""
    manifest_path = Path(manifest_path).expanduser().resolve()
    output_path = Path(output_path).expanduser().resolve()
    if width <= 0 or height <= 0 or fps <= 0:
        raise AssemblyError("Width, height, and FPS must be positive integers.")
    if min_duration_seconds < 0:
        raise AssemblyError("Minimum duration must be non-negative.")
    if output_path.suffix.lower() != ".mp4":
        raise AssemblyError("Output must use the .mp4 extension.")
    if output_path.exists() and not force:
        raise AssemblyError(f"Output already exists: '{output_path}'. Use --force to replace it.")
    if output_path == manifest_path:
        raise AssemblyError("Output path must not overwrite the input manifest.")

    ffmpeg = _require_tool("ffmpeg")
    ffprobe = _require_tool("ffprobe")
    clips = _load_manifest(manifest_path)
    validated: list[dict[str, Any]] = []
    for clip in clips:
        source = Path(clip["path"]).expanduser()
        if not source.is_absolute():
            source = (manifest_path.parent / source).resolve()
        if not source.is_file():
            raise AssemblyError(f"Source media does not exist for scene '{clip['scene_id']}': '{source}'.")
        info = _probe(source, ffprobe)
        start = float(clip.get("trim_start_seconds") or 0)
        end_value = clip.get("trim_end_seconds")
        end = float(end_value) if end_value is not None else info["duration_seconds"]
        if start >= end or end > info["duration_seconds"] + 0.05:
            raise AssemblyError(
                f"Invalid trim for scene '{clip['scene_id']}': {start:g}..{end:g}s "
                f"for a {info['duration_seconds']:.3f}s source."
            )
        validated.append({
            "scene_id": clip["scene_id"],
            "source_path": source,
            "source_info": info,
            "trim_start_seconds": start,
            "trim_end_seconds": min(end, info["duration_seconds"]),
            "duration_seconds": end - start,
            "media_uri": clip.get("media_uri"),
            "qc_status": "PASS",
        })

    total_duration = sum(item["duration_seconds"] for item in validated)
    if total_duration + 0.05 < min_duration_seconds:
        raise AssemblyError(
            f"Selected clips total {total_duration:.3f}s, below the required "
            f"{min_duration_seconds:.3f}s. Add approved clips or adjust trims."
        )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists() and force:
        output_path.unlink()

    with tempfile.TemporaryDirectory(prefix="goglow-assemble-") as temporary:
        work = Path(temporary)
        normalized: list[Path] = []
        for index, clip in enumerate(validated, 1):
            target = work / f"clip-{index:04d}.mp4"
            duration = clip["duration_seconds"]
            command = [
                ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f'{clip["trim_start_seconds"]:.6f}',
                "-i", str(clip["source_path"]),
                "-t", f"{duration:.6f}",
                "-map", "0:v:0",
                "-vf", (
                    f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                    f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
                    f"setsar=1,fps={fps},format=yuv420p"
                ),
                "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            ]
            if clip["source_info"]["has_audio"]:
                command += ["-map", "0:a:0?", "-af", "aresample=async=1:first_pts=0"]
            else:
                command += [
                    "-f", "lavfi", "-i", f"anullsrc=channel_layout=stereo:sample_rate=48000",
                    "-map", "1:a:0", "-shortest",
                ]
            command += ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                        "-movflags", "+faststart", str(target)]
            result = _run(command)
            if result.returncode or not target.is_file() or target.stat().st_size == 0:
                detail = result.stderr.strip() or "FFmpeg did not produce a non-empty file."
                raise AssemblyError(f"Failed to normalize scene '{clip['scene_id']}': {detail}")
            normalized.append(target)

        concat_list = work / "concat.txt"
        concat_list.write_text(
            "".join(f"file '{item.as_posix()}'\n" for item in normalized),
            encoding="utf-8",
        )
        concat_command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0", "-i", str(concat_list),
            "-c", "copy", "-movflags", "+faststart", str(output_path),
        ]
        result = _run(concat_command)
        if result.returncode or not output_path.is_file() or output_path.stat().st_size == 0:
            detail = result.stderr.strip() or "FFmpeg did not produce a non-empty output."
            if output_path.exists():
                output_path.unlink()
            raise AssemblyError(f"Failed to concatenate normalized clips: {detail}")

    try:
        output_info = _probe(output_path, ffprobe)
    except AssemblyError:
        output_path.unlink(missing_ok=True)
        raise
    if output_info["duration_seconds"] + 0.25 < min_duration_seconds:
        output_path.unlink(missing_ok=True)
        raise AssemblyError(
            f"Rendered output is only {output_info['duration_seconds']:.3f}s; "
            f"minimum is {min_duration_seconds:.3f}s. Output was removed."
        )

    result_manifest = {
        "schema_version": 1,
        "output": str(output_path),
        "duration_seconds": round(output_info["duration_seconds"], 3),
        "width": width,
        "height": height,
        "fps": fps,
        "video_codec": output_info["video_codec"],
        "audio_present": output_info["has_audio"],
        "clips": [
            {
                "scene_id": item["scene_id"],
                "source_path": str(item["source_path"]),
                "media_uri": item["media_uri"],
                "duration_seconds": round(item["duration_seconds"], 3),
                "trim_start_seconds": item["trim_start_seconds"],
                "trim_end_seconds": item["trim_end_seconds"],
                "qc_status": item["qc_status"],
            }
            for item in validated
        ],
    }
    sidecar = output_path.with_suffix(".manifest.json")
    sidecar.write_text(json.dumps(result_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result_manifest

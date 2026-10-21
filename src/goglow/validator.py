"""Validation for GoGlow project JSON."""
from __future__ import annotations
from typing import Any

SUPPORTED_ACTIVITIES = {"cycling", "yoga", "dance", "fashion", "other"}
VALID_STATUSES = {"PLANNED", "PROMPT_READY", "WAITING_FOR_GENERATION", "GENERATED", "QC_REVIEW", "NEEDS_REVISION", "PROMPT_REVISED", "APPROVED", "BLOCKED"}

def validate_project(project: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(project, dict):
        return ["Project root must be a JSON object."]
    for field in ("project_id", "aspect_ratio", "target_duration_seconds", "activity", "scenes"):
        if field not in project:
            errors.append(f"Missing required project field: {field}.")
    if project.get("aspect_ratio") != "9:16":
        errors.append("aspect_ratio must be '9:16'.")
    target = project.get("target_duration_seconds")
    if isinstance(target, bool) or not isinstance(target, int) or target < 31:
        errors.append("target_duration_seconds must be an integer >= 31.")
    activity = project.get("activity")
    if activity not in SUPPORTED_ACTIVITIES:
        errors.append(f"activity must be one of: {', '.join(sorted(SUPPORTED_ACTIVITIES))}.")
    scenes = project.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        errors.append("scenes must be a non-empty array.")
        return errors
    total = 0.0
    seen_ids: set[str] = set()
    for index, scene in enumerate(scenes, start=1):
        prefix = f"scenes[{index - 1}]"
        if not isinstance(scene, dict):
            errors.append(f"{prefix} must be an object.")
            continue
        for field in ("id", "duration_seconds", "start_state", "primary_action", "end_state", "prompt", "qc_checklist"):
            if field not in scene:
                errors.append(f"{prefix} missing required field: {field}.")
        scene_id = scene.get("id")
        if not isinstance(scene_id, str) or not scene_id.strip():
            errors.append(f"{prefix}.id must be a non-empty string.")
        elif scene_id in seen_ids:
            errors.append(f"Duplicate scene id: {scene_id}.")
        else:
            seen_ids.add(scene_id)
        duration = scene.get("duration_seconds")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or duration <= 0:
            errors.append(f"{prefix}.duration_seconds must be a positive number.")
        else:
            total += duration
        for field in ("start_state", "primary_action", "end_state", "prompt"):
            value = scene.get(field)
            if not isinstance(value, str) or not value.strip():
                errors.append(f"{prefix}.{field} must be a non-empty string.")
        checklist = scene.get("qc_checklist")
        if not isinstance(checklist, list) or not checklist or any(not isinstance(item, str) or not item.strip() for item in checklist):
            errors.append(f"{prefix}.qc_checklist must be a non-empty array of non-empty strings.")
        status = scene.get("status", "PLANNED")
        if status not in VALID_STATUSES:
            errors.append(f"{prefix}.status is not a recognized production state.")
        if status in {"GENERATED", "QC_REVIEW", "APPROVED"} and not scene.get("media_uri"):
            errors.append(f"{prefix} status {status} requires media_uri; a prompt alone is not generated media.")
    if isinstance(target, int) and not isinstance(target, bool) and abs(total - target) > 0.001:
        errors.append(f"Scene durations total {total:g}s but target_duration_seconds is {target}s.")
    return errors

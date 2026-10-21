"""Validation for GoGlow project JSON."""
from __future__ import annotations

import math
from datetime import datetime
from typing import Any

SUPPORTED_ACTIVITIES = {"cycling", "yoga", "dance", "fashion", "other"}
VALID_STATUSES = {
    "PLANNED", "PROMPT_READY", "WAITING_FOR_GENERATION", "GENERATED",
    "QC_REVIEW", "NEEDS_REVISION", "PROMPT_REVISED", "APPROVED", "BLOCKED",
}
STATUS_TRANSITIONS = {
    "PLANNED": {"PROMPT_READY", "BLOCKED"},
    "PROMPT_READY": {"WAITING_FOR_GENERATION", "BLOCKED"},
    "WAITING_FOR_GENERATION": {"GENERATED", "BLOCKED"},
    "GENERATED": {"QC_REVIEW", "WAITING_FOR_GENERATION", "BLOCKED"},
    "QC_REVIEW": {"APPROVED", "NEEDS_REVISION", "WAITING_FOR_GENERATION", "BLOCKED"},
    "NEEDS_REVISION": {"PROMPT_REVISED", "BLOCKED"},
    "PROMPT_REVISED": {"WAITING_FOR_GENERATION", "BLOCKED"},
    "APPROVED": set(),
    "BLOCKED": {"PLANNED", "PROMPT_READY"},
}
MEDIA_EVIDENCE_STATUSES = {"GENERATED", "QC_REVIEW", "APPROVED"}


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _validate_qc_report(report: Any, prefix: str) -> list[str]:
    errors: list[str] = []
    if not isinstance(report, dict):
        return [f"{prefix}.qc_report must be an object for APPROVED status."]
    review_status = report.get("review_status")
    if review_status != "PASS":
        errors.append(f"{prefix}.qc_report.review_status must be PASS for APPROVED status.")
    if not _nonempty_string(report.get("scene_id")):
        errors.append(f"{prefix}.qc_report.scene_id must be a non-empty string.")
    if not _nonempty_string(report.get("reviewed_by")):
        errors.append(f"{prefix}.qc_report.reviewed_by must identify the human reviewer.")
    reviewed_at = report.get("reviewed_at")
    if not _nonempty_string(reviewed_at):
        errors.append(f"{prefix}.qc_report.reviewed_at must record the review date/time.")
    else:
        try:
            datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
        except ValueError:
            errors.append(f"{prefix}.qc_report.reviewed_at must be an ISO 8601 date-time.")
    checks = report.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append(f"{prefix}.qc_report.checks must contain human-reviewed checks.")
    else:
        for check_index, check in enumerate(checks):
            if not isinstance(check, dict):
                errors.append(f"{prefix}.qc_report.checks[{check_index}] must be an object.")
                continue
            if check.get("status") not in {"PASS", "NOT_CHECKED"}:
                errors.append(
                    f"{prefix}.qc_report.checks[{check_index}] must be PASS or NOT_CHECKED "
                    "when the report is marked PASS."
                )
            if not _nonempty_string(check.get("category")):
                errors.append(f"{prefix}.qc_report.checks[{check_index}].category must be a non-empty string.")
            if not isinstance(check.get("notes"), str):
                errors.append(f"{prefix}.qc_report.checks[{check_index}].notes must be a string.")
    defects = report.get("defects", [])
    if not isinstance(defects, list):
        errors.append(f"{prefix}.qc_report.defects must be an array when provided.")
    elif any(_nonempty_string(defect) for defect in defects):
        errors.append(f"{prefix}.qc_report.defects must be empty for a PASS report.")
    return errors


def validate_project(project: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(project, dict):
        return ["Project root must be a JSON object."]
    for field in ("project_id", "aspect_ratio", "target_duration_seconds", "activity", "scenes"):
        if field not in project:
            errors.append(f"Missing required project field: {field}.")
    if project.get("aspect_ratio") not in {"9:16", "16:9", "1:1"}:
        errors.append("aspect_ratio must be one of: 9:16, 16:9, 1:1.")
    target = project.get("target_duration_seconds")
    if isinstance(target, bool) or not isinstance(target, int) or target < 30:
        errors.append("target_duration_seconds must be an integer >= 30.")
    activity = project.get("activity")
    if not isinstance(activity, str) or activity not in SUPPORTED_ACTIVITIES:
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
        if not _nonempty_string(scene_id):
            errors.append(f"{prefix}.id must be a non-empty string.")
        elif scene_id in seen_ids:
            errors.append(f"Duplicate scene id: {scene_id}.")
        else:
            seen_ids.add(scene_id)

        duration = scene.get("duration_seconds")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
            errors.append(f"{prefix}.duration_seconds must be a finite positive number.")
        else:
            total += duration
        for field in ("start_state", "primary_action", "end_state", "prompt"):
            if not _nonempty_string(scene.get(field)):
                errors.append(f"{prefix}.{field} must be a non-empty string.")
        checklist = scene.get("qc_checklist")
        if not isinstance(checklist, list) or not checklist or any(not _nonempty_string(item) for item in checklist):
            errors.append(f"{prefix}.qc_checklist must be a non-empty array of non-empty strings.")

        status = scene.get("status", "PLANNED")
        if not isinstance(status, str) or status not in VALID_STATUSES:
            errors.append(f"{prefix}.status is not a recognized production state.")
            continue

        history = scene.get("status_history")
        if history is None:
            if status != "PLANNED":
                errors.append(f"{prefix}.status_history is required when status is not PLANNED.")
            else:
                history = ["PLANNED"]
        if not isinstance(history, list) or not history or any(not isinstance(item, str) or item not in VALID_STATUSES for item in history):
            errors.append(f"{prefix}.status_history must be a non-empty array of recognized production states.")
        else:
            if history[0] != "PLANNED":
                errors.append(f"{prefix}.status_history must start with PLANNED.")
            if history[-1] != status:
                errors.append(f"{prefix}.status_history must end with the current status {status}.")
            for previous, current in zip(history, history[1:]):
                if current not in STATUS_TRANSITIONS.get(previous, set()):
                    errors.append(f"{prefix}.status_history has invalid transition {previous} -> {current}.")
                    break

        media_uri = scene.get("media_uri")
        if status in MEDIA_EVIDENCE_STATUSES and not _nonempty_string(media_uri):
            errors.append(f"{prefix} status {status} requires a non-empty media_uri; a prompt alone is not generated media.")
        if status == "APPROVED":
            errors.extend(_validate_qc_report(scene.get("qc_report"), prefix))
            report = scene.get("qc_report")
            if isinstance(report, dict):
                if report.get("scene_id") != scene_id:
                    errors.append(f"{prefix}.qc_report.scene_id must match the scene id.")
                if not _nonempty_string(report.get("media_uri")):
                    errors.append(f"{prefix}.qc_report.media_uri must identify the reviewed clip.")
                elif _nonempty_string(media_uri) and report.get("media_uri") != media_uri:
                    errors.append(f"{prefix}.qc_report.media_uri must match the scene media_uri.")
        if status == "QC_REVIEW" and not _nonempty_string(media_uri):
            # Keep this explicit even if the general media gate changes later.
            errors.append(f"{prefix} cannot enter QC_REVIEW without declared media.")

    if isinstance(target, int) and not isinstance(target, bool) and abs(total - target) > 0.001:
        errors.append(f"Scene durations total {total:g}s but target_duration_seconds is {target}s.")
    return errors

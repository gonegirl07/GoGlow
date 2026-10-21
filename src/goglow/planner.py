"""Deterministic starter scene plans. No model/API calls are made here."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

SUPPORTED_ACTIVITIES = ("cycling", "yoga", "dance", "fashion", "other")
DEFAULT_TARGET_SECONDS = 36
DEFAULT_SCENE_COUNT = 4

_ACTIVITY_BEATS = {
    "cycling": [
        ("Rider starts in a stable riding position on the selected path.", "Ride forward at a steady, realistic pace while pedaling continuously.", "Rider reaches a clearly described point farther along the same path without changing lanes abruptly.", "Keep bicycle orientation, wheel rotation, pedaling, hand contact, and road direction coherent."),
        ("Continue from the previous scene's ending position and orientation.", "Maintain forward travel in the same direction; camera tracks from the side at a constant distance.", "Rider continues along the same lane with a consistent speed and cadence.", "Do not reverse direction, slide sideways, or let feet leave the pedals."),
        ("Rider approaches a visible landmark on the same path.", "Pass the landmark smoothly while maintaining a steady cadence.", "Rider has passed the landmark and remains aligned with the path.", "Background motion must agree with camera tracking and travel direction."),
        ("Rider continues from the established position and pace.", "Ease into a controlled slowdown or continue riding, according to the project brief.", "End at a specific, stable position suitable for the next clip.", "Preserve bicycle geometry, clothing, lighting, and screen direction."),
    ],
    "yoga": [
        ("Full body visible, standing neutrally on the mat with feet grounded.", "Move slowly into the requested starting pose with deliberate weight transfer.", "Settle into the pose with stable support points.", "Keep the mat, hands, feet, and full body visible; no sudden pose morphs."),
        ("Begin in the previous scene's final pose.", "Perform one slow, clearly specified transition toward the target pose.", "Reach the target pose and stabilize balance.", "Maintain plausible joint angles and intentional left/right limb placement."),
        ("Hold the established pose with controlled breathing and minimal movement.", "Make one small, deliberate alignment adjustment if requested.", "Return to a stable hold without adding another pose.", "No extra pose changes; preserve support points and camera framing."),
        ("Start from the stable pose established in the prior scene.", "Transition slowly to a simple neutral finishing pose.", "Hold the finishing pose steadily for the final beat.", "Keep the entire body and mat in frame; no unintended mirroring."),
    ],
    "dance": [
        ("Full-body view; character faces the camera with feet and arms in a defined starting position.", "Perform a short 2–4 movement phrase with clear foot placement and weight transfer.", "Finish in a stable pose facing the defined direction.", "Keep the rhythm consistent and avoid unrequested spins or jumps."),
        ("Start from the prior ending pose and facing.", "Perform a second short phrase with explicit steps and coordinated arm movement.", "Return to a readable pose without changing location unexpectedly.", "No foot sliding, random choreography, or sudden facing flips."),
        ("Begin with feet planted and weight clearly on the named leg.", "Perform one deliberate turn or directional change, then two controlled steps.", "Finish facing the specified direction with balanced posture.", "Make the turn physically plausible; keep hands and feet visible."),
        ("Resume from the established position and facing.", "Repeat the most readable motif at the same tempo.", "End with a clear final pose and hold briefly.", "Preserve identity, wardrobe, rhythm, and stage position."),
    ],
    "fashion": [
        ("Full-body framing shows the complete outfit, shoes, and accessories.", "Take a short, deliberate walk toward the camera or along the specified runway.", "Stop in a balanced full-body pose with the outfit still visible.", "Preserve garment cut, colors, accessories, and character identity."),
        ("Begin from the prior ending position and pose.", "Turn slowly by a specified amount to reveal the outfit silhouette.", "Hold a three-quarter or side view without cropping key details.", "Avoid fast spins and unrequested outfit/accessory changes."),
        ("Start in a stable pose with the outfit unobstructed.", "Use a controlled camera push-in or a small pose change to show one garment detail.", "Return to a framing that clearly shows the intended outfit details.", "Camera motion must not hide the outfit or distort fabric."),
        ("Begin from the established pose and camera framing.", "Perform one deliberate final pose change, keeping accessories and garment shape stable.", "Hold a clean final fashion pose.", "No fabric melting, clipping, identity drift, or unexplained wardrobe changes."),
    ],
    "other": [
        ("Start in a clear, stable pose with the subject and environment visible.", "Perform one simple primary action described by the project owner.", "Reach a clearly described ending state.", "Keep the action singular, readable, and physically plausible."),
        ("Continue from the prior ending state.", "Repeat or continue the primary action with one controlled variation.", "End in a stable state that can connect to the next scene.", "Preserve identity, wardrobe, props, and screen direction."),
        ("Begin from the previous scene's ending state.", "Perform one secondary action only if explicitly requested.", "Return to a stable, visible pose.", "Avoid adding actions that were not requested."),
        ("Start from the established position and pose.", "Complete the main action at a deliberate pace.", "End with a clear final state held briefly.", "Keep camera, environment, identity, and props consistent."),
    ],
}

def _divide_duration(total: int, count: int) -> list[int]:
    base, remainder = divmod(total, count)
    return [base + (1 if i < remainder else 0) for i in range(count)]

def _qc_for(activity: str) -> list[str]:
    common = ["Character identity and wardrobe match the selected references.", "Start and end states are clear and continuity is usable.", "Review the actual output; do not infer QC from the prompt alone."]
    specific = {
        "cycling": ["Travel direction, road/lane, wheel rotation, and pedaling agree.", "Hands remain on handlebars and feet on pedals; speed is plausible."],
        "yoga": ["Pose and support points match the intended posture.", "Left/right limbs, balance, and joint alignment are plausible; full body remains visible."],
        "dance": ["Footwork and weight transfer are readable and match the beat.", "No unrequested spins, foot sliding, or sudden facing flips."],
        "fashion": ["Outfit, shoes, colors, and accessories remain stable.", "Framing shows the required outfit details; fabric and limbs remain plausible."],
        "other": ["Primary action is readable and physically plausible."],
    }
    return common + specific[activity]

def create_project(activity: str, target_duration_seconds: int = DEFAULT_TARGET_SECONDS, character_name: str = "Main Character", brief: str = "", project_id: str | None = None, scene_count: int = DEFAULT_SCENE_COUNT) -> dict[str, Any]:
    """Create an editable starter plan; content is a template, not model output."""
    activity = activity.strip().lower()
    if activity not in SUPPORTED_ACTIVITIES:
        raise ValueError(f"Unsupported activity {activity!r}. Choose: {', '.join(SUPPORTED_ACTIVITIES)}")
    if isinstance(target_duration_seconds, bool) or not isinstance(target_duration_seconds, int) or target_duration_seconds < 31:
        raise ValueError("Target duration must be at least 31 seconds.")
    if isinstance(scene_count, bool) or not isinstance(scene_count, int) or not 1 <= scene_count <= 20:
        raise ValueError("Scene count must be between 1 and 20.")
    durations = _divide_duration(target_duration_seconds, scene_count)
    beats = _ACTIVITY_BEATS[activity]
    scenes = []
    for index, duration in enumerate(durations):
        start, action, end, constraint = beats[index % len(beats)]
        if index:
            start = "Continue from the previous scene's ending state. " + start
        prompt = (f"Vertical 9:16 video featuring {character_name}. Activity: {activity}. {brief.strip()} "
                  f"Starting state: {start} Primary action: {action} Ending state: {end} "
                  f"Continuity and constraints: {constraint} Use one coherent shot, stable identity and wardrobe, "
                  "plausible body mechanics, and a deliberate camera plan. This is a starter prompt; replace generic "
                  "details with the exact character reference, location, camera setup, and action before generation.").strip()
        scenes.append({
            "id": f"scene-{index + 1:02d}", "duration_seconds": duration, "wardrobe": "", "location": "",
            "start_state": start, "primary_action": action,
            "motion_direction": "Specify screen direction and path explicitly before generation.",
            "speed_and_timing": "Steady, deliberate motion; adjust to the activity and shot.",
            "body_mechanics": constraint, "camera": "Choose one camera setup and keep it consistent within the shot.",
            "environment": "", "end_state": end,
            "continuity_in": ["character identity", "wardrobe", "props", "screen direction"] if index else [],
            "continuity_out": ["ending position", "facing", "pose", "props", "camera relationship"],
            "reference_ids": [], "image_brief": "", "prompt": prompt, "negative_constraints": [],
            "qc_checklist": _qc_for(activity), "status": "PLANNED", "status_history": ["PLANNED"],
        })
    return {
        "project_id": project_id or f"goglow-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        "aspect_ratio": "9:16", "target_duration_seconds": target_duration_seconds, "activity": activity,
        "character_id": "", "character_name": character_name, "brief": brief,
        "model_labels": {"video": "", "image": ""}, "created_at": datetime.now(timezone.utc).isoformat(),
        "scenes": scenes, "metadata": {"planner": "goglow-template-v1", "model_called": False},
    }

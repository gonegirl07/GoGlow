"""Export GoGlow plans to human-readable Markdown."""
from __future__ import annotations
from typing import Any

def to_markdown(project: dict[str, Any]) -> str:
    lines = [
        f"# GoGlow production plan: {project.get('project_id', 'untitled')}", "",
        f"- Activity: **{project.get('activity', 'unspecified')}**",
        f"- Aspect ratio: **{project.get('aspect_ratio', 'unspecified')}**",
        f"- Target duration: **{project.get('target_duration_seconds', '?')} seconds**",
        f"- Character: **{project.get('character_name') or project.get('character_id') or 'not set'}**",
        f"- Video model label: {project.get('model_labels', {}).get('video') or 'not recorded'}",
        f"- Image model label: {project.get('model_labels', {}).get('image') or 'not recorded'}", "",
        "> This is a planning export. It does not mean generation or visual QC has occurred.", "",
    ]
    if project.get("brief"):
        lines.extend(["## Project brief", "", str(project["brief"]), ""])
    for index, scene in enumerate(project.get("scenes", []), start=1):
        lines.extend([
            f"## {scene.get('id', f'scene-{index:02d}')} — {scene.get('duration_seconds', '?')}s", "",
            f"- Status: {scene.get('status', 'PLANNED')}",
            f"- Start state: {scene.get('start_state', '')}",
            f"- Primary action: {scene.get('primary_action', '')}",
            f"- Motion direction: {scene.get('motion_direction') or 'not specified'}",
            f"- Camera: {scene.get('camera') or 'not specified'}",
            f"- End state: {scene.get('end_state', '')}", "", "### Prompt", "", str(scene.get("prompt", "")).strip(), "", "### QC checklist", "",
        ])
        lines.extend(f"- [ ] {item}" for item in scene.get("qc_checklist", []))
        if scene.get("image_brief"):
            lines.extend(["", "### Reference image brief", "", scene["image_brief"]])
        if scene.get("review_notes"):
            lines.extend(["", "### Review notes", "", scene["review_notes"]])
        lines.append("")
    lines.extend(["## Assembly notes", "", "- Verify actual clip durations after generation.", "- Check transitions, continuity, trims, and final runtime.", "- Do not mark clips approved until the actual media has been reviewed.", ""])
    return "\n".join(lines)

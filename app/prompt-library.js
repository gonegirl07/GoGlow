/* GoGlow Phase 1 prompt library runtime.
 * The source seed remains examples/prompt-library.seed.json. This small runtime
 * adapter deliberately previews only; it never mutates a scene on its own.
 */
(function (root) {
  "use strict";

  const VERSION = "1.0";
  const RULES = [
    { id: "start-already-in-pose", status: "confirmed", label: "Bắt đầu sẵn ở tư thế tham chiếu", match: /warrior[\s-]*ii|warrior 2/i, append: "The shot starts already in the exact pose of the reference image. Hold still until the end; only gentle breathing and a soft blink.", scope: "Mai / Yoga / Warrior II / Omni 1.1 Flash / 9:16 / 360p / 8s / warrior-still-v4 + mai-face" },
    { id: "keep-prompts-concise", status: "confirmed", label: "Giữ prompt ngắn gọn", match: /[\s\S]{1200,}/, warning: "Prompt vượt ngưỡng thử nghiệm 1200 ký tự; hãy cân nhắc rút gọn, không tự xóa nội dung." },
    { id: "lock-static-body-parts", status: "confirmed", label: "Khóa bộ phận cần đứng yên", match: /deep knee bend|weight shift|heel pedal|deep cat-cow|side bend|sun salutation/i, warning: "Động tác có chuyển trọng lượng; chỉ ghi khóa cơ thể chưa đủ để bảo đảm điểm tựa không trượt." },
    { id: "warn-weight-shift", status: "confirmed", label: "Cảnh báo chuyển trọng lượng", match: /deep knee bend|weight shift|heel pedal|deep cat-cow|side bend|sun salutation/i, warning: "Chuyển trọng lượng có rủi ro trượt chân/cắt tay; cân nhắc tách chuyển tiếp thành clip riêng hoặc dùng stable hold." },
    { id: "warn-time-coded-static-pose", status: "candidate", label: "Cảnh báo mốc thời gian trong tư thế tĩnh", match: /\b0\s*[–-]\s*3s\b|\b3\s*[–-]\s*8s\b/i, warning: "Rule candidate: mốc thời gian có thể gây kéo giãn ở tư thế tĩnh; cần kiểm tra clip thực tế." },
    { id: "warn-shoulder-roll-ambiguity", status: "candidate", label: "Cảnh báo shoulder roll / shrug", match: /shoulder rolls?|shrugs?/i, warning: "Rule candidate: cách diễn đạt này có thể khiến tay đặt lên vai thay vì thực hiện chuyển động dự định." },
    { id: "warn-platform-branding", status: "candidate", label: "Cảnh báo tên nền tảng", match: /\bTikTok\b|\bReels\b/i, warning: "Rule candidate: tên nền tảng có thể làm xuất hiện logo ngoài ý muốn." },
    { id: "explicit-real-time", status: "candidate", label: "Đề xuất tốc độ real-time", match: /slow motion|real[- ]time/i, warning: "Rule candidate về tốc độ: chỉ thêm cụm từ sau khi người dùng xem preview và chủ động duyệt." }
  ];

  function uniqueSentences(parts) {
    const seen = new Set();
    const segments = parts.map(v => String(v || "").trim()).filter(Boolean)
      .flatMap(v => v.split(/\\n+|(?<=[.!?])\\s+/));
    return segments.map(v => v.trim()).filter(Boolean).filter(v => {
      const key = v.replace(/\\s+/g, " ").toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function inWarriorScope(scene, project) {
    const all = [scene.id, scene.start_state, scene.primary_action, scene.end_state, scene.prompt].join(" ");
    return String(project.character_name || "").trim().toLocaleLowerCase() === "mai" &&
      project.activity === "yoga" &&
      /warrior[\s-]*ii|warrior 2/i.test(all) &&
      /omni\s*1\.1\s*flash/i.test(String(project.model_labels && project.model_labels.video || "")) &&
      String(project.aspect_ratio || "") === "9:16" &&
      String(scene.flow_clip_seconds || scene.duration_seconds || "") === "8" &&
      String(scene.pose_reference_uri || "").includes("warrior-still-v4") &&
      String(scene.face_reference_uri || "").includes("mai-face");
  }

  function analyze(scene, project) {
    const raw = [scene.prompt, scene.start_state, scene.primary_action, scene.end_state, scene.motion_direction, scene.body_mechanics, scene.camera, scene.wardrobe, scene.location, scene.environment].filter(Boolean).join("\n");
    const warnings = [];
    const matchedRules = [];
    RULES.forEach(rule => {
      if (!rule.match.test(raw)) return;
      matchedRules.push({ id: rule.id, status: rule.status, label: rule.label });
      if (rule.warning) warnings.push({ rule_id: rule.id, status: rule.status, message: rule.warning });
    });
    if (raw.length > 1200 && !warnings.some(w => w.rule_id === "keep-prompts-concise")) {
      warnings.push({ rule_id: "keep-prompts-concise", status: "confirmed", message: "Prompt vượt ngưỡng thử nghiệm 1200 ký tự; cân nhắc rút gọn nhưng giữ nguyên bản gốc." });
    }
    if (project.activity === "yoga" && /warrior[\s-]*ii|warrior 2/i.test(raw) && !inWarriorScope(scene, project)) {
      warnings.push({ rule_id: "start-already-in-pose", status: "confirmed", message: "Rule Warrior II đã xác nhận chỉ áp dụng đúng cấu hình hẹp; cấu hình cảnh hiện tại chưa khớp đủ nên không tự chèn rule." });
    }
    return { version: VERSION, matched_rules: matchedRules, warnings, in_warrior_scope: inWarriorScope(scene, project) };
  }

  function compose(scene, project, options) {
    const analysis = analyze(scene, project);
    const outfit = String(scene.wardrobe || "").trim() ||
      "Outfit matching the selected reference, chest and upper torso fully covered, SFW.";
    const room = String(scene.environment || scene.location || project.brief || "").trim() ||
      "A bright, uncluttered yoga studio.";
    const camera = String(scene.camera || "").trim() ||
      "Eye-level static camera, front view, wide full-body framing, both hands and feet inside the frame, no zoom.";
    const parts = [
      String(project.character_name || "").trim().toLocaleLowerCase() === "mai" ?
        "Mai keeping exactly her face, hair, body." :
        "Keep exactly the selected character's face, hair, and body.",
      outfit,
      room,
      camera,
      "Single continuous shot. Natural hands with five fingers. No dialogue, no text, SFW.",
      "Starting state: " + (scene.start_state || "Start in the specified reference pose."),
      "Primary action: " + (scene.primary_action || "Perform one clearly defined main movement."),
      "Body parts that stay still: " + (scene.body_mechanics || "Keep support points and all unmentioned body parts still."),
      "Ending state: " + (scene.end_state || "Reach the described ending state and hold still until the end."),
      "Movement direction and speed: " + (scene.motion_direction || "Use clear, physically plausible movement."),
      "Avoid: " + (Array.isArray(scene.negative_constraints) ? scene.negative_constraints.join("; ") : (scene.negative_constraints || "No morphing, fused fingers, sliding, or unrequested actions.")),
      // Preserve any user-authored prompt text not already represented by the structured fields.
      scene.prompt ? "Existing prompt details: " + scene.prompt : ""
    ];
    if (analysis.in_warrior_scope && options && options.include_confirmed_stable_hold) {
      parts.push(RULES[0].append);
    }
    // Candidate rules, including explicit-real-time, are warnings only here.
    // They are never appended by default; the caller must opt in via preview.
    if (options && options.include_candidate_realtime === true) {
      parts.push("real-time speed, never slow motion.");
    }
    return { text: uniqueLines(parts).join("\n"), analysis };
  }

  root.GoGlowPromptLibrary = Object.freeze({
    version: VERSION,
    rules: RULES.map(rule => Object.freeze({ id: rule.id, status: rule.status, label: rule.label })),
    analyze,
    compose
  });
})(window);

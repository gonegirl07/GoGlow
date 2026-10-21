/* Append-only, provider-neutral generation-attempt ledger. No Flow API calls. */
(function (root) {
  "use strict";
  const VERSION = "1.0";
  function nullableNumber(value) {
    if (value === "" || value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  function makeAttempt(scene, project, form, now) {
    const attempts = Array.isArray(scene.generation_attempts) ? scene.generation_attempts : [];
    const previous = attempts.length ? attempts[attempts.length - 1] : null;
    const attemptNumber = attempts.reduce((max, item) => Math.max(max, Number(item.attempt_number) || 0), 0) + 1;
    const status = form.status || "unknown";
    const isFailure = status === "failed";
    const qc = scene.qc_report || null;
    const timestamp = now || new Date().toISOString();
    const existingIds = new Set([
      ...((project && Array.isArray(project.generation_attempts)) ? project.generation_attempts : []).map(item => item && item.attempt_id),
      ...attempts.map(item => item && item.attempt_id)
    ].filter(Boolean));
    function createCandidateId() {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return "attempt-" + crypto.randomUUID();
      }
      const randomPart = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
        ? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")
        : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      return "attempt-" + timestamp.replace(/[^0-9]/g, "").slice(0, 14) + "-" + randomPart;
    }
    let attemptId = createCandidateId();
    while (existingIds.has(attemptId)) attemptId = createCandidateId();
    return {
      schema_version: VERSION,
      attempt_id: attemptId,
      project_id: String(project.project_id || project.project_name || "goglow-project"),
      scene_id: String(scene.id || "unknown-scene"),
      attempt_number: attemptNumber,
      retry_of: previous && form.retry_mode === "retry_previous" ? previous.attempt_id : null,
      provider: form.provider || "google_flow",
      started_on: form.started_on || null,
      finished_on: form.finished_on || null,
      configuration: {
        model_label: project.model_labels && project.model_labels.video || null,
        resolution: form.resolution || null,
        duration_seconds: Number(scene.flow_clip_seconds || scene.duration_seconds) || null,
        aspect_ratio: project.aspect_ratio || null,
        pose_reference_id: scene.pose_reference_uri || null,
        face_reference_id: scene.face_reference_uri || null,
        other_reference_ids: []
      },
      prompt: {
        text: String(scene.prompt || ""),
        sha256: null,
        template_version: scene.prompt_preview_meta && scene.prompt_preview_meta.version || null
      },
      rule_ids: Array.from(new Set((scene.prompt_preview_meta && scene.prompt_preview_meta.applied_rule_ids || []).filter(Boolean))),
      result: {
        status,
        provider_message: form.provider_message || null,
        failure: isFailure ? {
          category: form.failure_category || "unknown",
          message: String(form.failure_message || "Failure recorded without a detailed message."),
          provider_error_code: form.provider_error_code || null,
          retryable: !!form.retryable,
          suggested_prompt_revision: null,
          revision_rationale: null
        } : null
      },
      credits: {
        estimated_amount: nullableNumber(form.estimated_amount),
        actual_amount: nullableNumber(form.actual_amount),
        currency_or_unit: "credits",
        charge_status: form.charge_status || "unknown",
        before_balance: nullableNumber(form.before_balance),
        after_balance: nullableNumber(form.after_balance),
        evidence_source: form.evidence_source || "unknown",
        notes: String(form.credit_notes || "")
      },
      media: {
        uri: String(form.media_uri || scene.media_uri || "").trim() || null,
        downloaded_file: null,
        sha256: null,
        integrity_status: String(form.media_uri || scene.media_uri || "").trim() ? "not_checked" : "missing"
      },
      qc: {
        status: qc ? ({ PASS: "pass", FAIL: "fail", REVIEW: "needs_review" }[qc.review_status] || "not_reviewed") : "not_reviewed",
        observed_defects: qc && Array.isArray(qc.defects) ? qc.defects.slice() : [],
        checks_passed: qc && Array.isArray(qc.checks) ? qc.checks.filter(x => x.status === "PASS").length : null,
        checks_total: qc && Array.isArray(qc.checks) ? qc.checks.length : null,
        reviewed_by: qc && qc.reviewed_by || null,
        reviewed_on: qc && qc.reviewed_at || null,
        notes: qc ? "Copied from the scene QC report at log time; this attempt record is immutable." : "QC has not been recorded for this attempt."
      },
      created_by: "user",
      notes: "Ledger entry recorded at " + timestamp + ". Unknown values are left null/unknown; no provider integration is implied."
    };
  }
  function validateAttempt(record) {
    const errors = [];
    if (!record || record.schema_version !== VERSION) errors.push("Unsupported ledger schema version.");
    if (!record || !record.attempt_id) errors.push("Missing attempt_id.");
    if (!record || !record.scene_id) errors.push("Missing scene_id.");
    if (!record || !Number.isInteger(record.attempt_number) || record.attempt_number < 1) errors.push("Invalid attempt_number.");
    if (!record || !record.prompt || !String(record.prompt.text || "").trim()) errors.push("Missing exact prompt text.");
    if (!record || !record.result || !["queued", "started", "succeeded", "failed", "unknown", "cancelled"].includes(record.result.status)) errors.push("Invalid result status.");
    if (record && record.result && record.result.status === "failed" && !record.result.failure) errors.push("Failed result requires failure details.");
    if (!record || !record.credits || !["charged", "not_charged", "refunded", "unknown", "not_applicable"].includes(record.credits.charge_status)) errors.push("Invalid credit charge status.");
    if (!record || !record.credits || !["provider_display", "user_observation", "provider_receipt", "estimate_only", "unknown"].includes(record.credits.evidence_source)) errors.push("Invalid credit evidence source.");
    return { valid: errors.length === 0, errors };
  }
  function updateAttemptQC(record, form, now) {
    if (!record || typeof record !== "object" || !record.attempt_id) {
      throw new Error("A valid generation attempt is required.");
    }
    const status = String(form && form.status || "");
    if (!["not_reviewed", "pass", "fail", "needs_review"].includes(status)) {
      throw new Error("Invalid QC status.");
    }
    const reviewer = String(form && form.reviewed_by || "").trim();
    if (!reviewer) throw new Error("Reviewer is required to record QC.");
    const defects = form && Array.isArray(form.defects)
      ? form.defects.map(value => String(value).trim()).filter(Boolean)
      : [];
    if (status === "fail" && !defects.length) {
      throw new Error("QC FAIL requires at least one observed defect.");
    }
    if (status === "pass" && defects.length) {
      throw new Error("QC PASS cannot include unresolved defects.");
    }
    const timestamp = now || new Date().toISOString();
    record.qc = Object.assign({}, record.qc || {}, {
      status,
      observed_defects: defects,
      reviewed_by: reviewer,
      reviewed_on: timestamp,
      notes: String(form && form.notes || "").trim()
    });
    return record;
  }
  function appendAttempt(scene, project, form, now) {
    const record = makeAttempt(scene, project, form, now);
    const check = validateAttempt(record);
    if (!check.valid) throw new Error(check.errors.join(" "));
    if (!Array.isArray(scene.generation_attempts)) scene.generation_attempts = [];
    scene.generation_attempts.push(record);
    return record;
  }
  root.GoGlowGenerationLedger = { version: VERSION, makeAttempt, validateAttempt, appendAttempt, updateAttemptQC };
})(typeof window !== "undefined" ? window : globalThis);

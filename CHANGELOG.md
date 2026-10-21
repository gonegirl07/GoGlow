# Changelog

## Unreleased — M1 local planner and validator (2026-10-21)
- Added a Python package and CLI to create editable starter scene plans, validate them, and export Markdown.
- Added activity-aware templates for cycling, yoga, dance, fashion, and other.
- Added a 36-second cycling example and local setup guide.
- Added unit tests and GitHub Actions checks on Python 3.10, 3.11, and 3.12.
- Hardened validation for malformed values, non-finite durations, duplicate scene IDs, total-duration mismatch, and generated states without media references.
- No model API integration, Flow automation, or automatic visual QC is implemented.

## Initial specification scaffold
- Added AI-agent guardrails, provider-neutral architecture/workflow docs, model capability verification policy, JSON schemas, prompt templates, adapter notes, and activity acceptance cases.

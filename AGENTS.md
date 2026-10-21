# Instructions for AI coding agents

## Mission
Build GoGlow as a reliable, model-agnostic production planner for AI character videos. The first use case is Google Flow; keep planning and validation independent of any provider.

## Non-negotiable rules
1. Do not fabricate integrations. Never claim to call Flow, Omni/Gemini, Nano Banana, or another model unless an actual supported interface is implemented and tested.
2. Do not fabricate observation. Never mark video visually inspected, QC-passed, or approved unless media was actually available and reviewed.
3. Separate planned, attempted, generated, reviewed, and approved states.
4. Treat model labels, limits, reference behavior, extension behavior, and UI options as unverified until documented with dated evidence or observed tests.
5. Never store API keys, cookies, session tokens, or credentials in source, fixtures, issues, logs, or commits.
6. Preserve user-supplied character identity and reference intent. Never claim to have loaded assets that were not provided.
7. Prefer small, testable, provider-neutral modules and JSON schemas.
8. Keep 9:16 as default and >30 seconds as target runtime, but never imply one generation request supports the full runtime unless verified.
9. Require human confirmation for paid generation, publishing, or account-changing actions.
10. Report what changed, what was tested, and what remains manual.

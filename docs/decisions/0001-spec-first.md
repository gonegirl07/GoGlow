# Decision 0001: Start specification-first

- Status: Accepted
- Date: 2026-10-21

## Context
The project needs repeatable AI character video planning, but direct generation and visual QC capabilities have not been verified as callable from this repository.

## Decision
Start with provider-neutral schemas, prompt templates, continuity rules, honest production states, and reproducible tests. Implement integrations only after their interfaces are verified.

## Consequences
The first milestone works without model API keys. Provider integrations can be added later without rewriting planning logic. Some steps remain manual until verified.

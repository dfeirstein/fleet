---
name: Operational review
about: A sweep across fleet's operational behavior — lifecycle, state, silent failures, security posture
title: "Operational review YYYY-MM-DD: <one-line summary>"
labels: operational-review
assignees: dfeirstein
---

<!-- Modeled on issue #30 and docs/FLEET-BUG-REVIEW-2026-06-09.md — the gold
     standard. Scope = operational issues (lifecycle, state, silent failures,
     security posture), not code style. Order findings by operational risk.
     Security issues: email the maintainer privately, do NOT post here. -->

Operational review of fleet as of `<branch>` @ `<commit>` (`YYYY-MM-DD`).
Scope: <!-- what you looked at and what you deliberately didn't. -->

## What's already solid

<!-- Brief — what you verified is working, so the reader knows the diff from any
     prior review. Cite the fix if it closed a prior finding. -->

## Findings

Ordered by operational risk. State how each was verified (read against the code,
observed live, etc.).

### 1. <title> (critical | major | minor)

**Symptom / risk:** <!-- what breaks, or what could. -->

**Root cause:** <!-- the actual cause, with `src/file.ts:line` refs. -->

**Fix shape:** <!-- enough that a maintainer can judge scope + blast radius. -->

### 2. <title> (severity)

...

## Bottom line

<!-- The one or two things to fix first, and why. What can wait. -->

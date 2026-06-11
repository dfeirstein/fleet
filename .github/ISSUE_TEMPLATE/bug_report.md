---
name: Bug report
about: A single concrete defect — symptom, repro, expected behavior
title: ""
labels: bug
assignees: dfeirstein
---

<!-- For a sweep across the orchestrator's behavior, use the Operational review
     template instead. Security issues: email the maintainer privately, do NOT
     open a public issue. -->

## Symptom

<!-- What went wrong, observably. The error, the wrong output, the hang. -->

## Repro

<!-- Exact steps / commands. The shorter and more deterministic, the better. -->

```bash
fleet ...
```

## Expected

<!-- What you expected to happen instead. -->

## Severity

<!-- critical (breaks a fleet run / silent data loss) | major | minor -->

## Environment

- fleet commit: <!-- git rev-parse --short HEAD -->
- cmux version: <!-- cmux --version -->
- Node: <!-- node --version -->

## File refs (if known)

<!-- `src/file.ts:line` for anything you've already traced. Optional but gold. -->

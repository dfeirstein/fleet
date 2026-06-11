<!-- See CONTRIBUTING.md for the full PR rules. Keep scope surgical. -->

## Linked issue

Fixes #<!-- issue number, or "n/a — describe why this isn't issue-driven" -->

## What & why

<!-- What this changes and why. One paragraph. Every changed line should trace
     back to the linked issue / stated goal. -->

## Verification evidence

<!-- Commands you ran + their actual output. Not "tests pass" — paste the result.
     For behavior changes, the before/after you observed. -->

```
$ npm run typecheck
<output>

$ npm test
<output, e.g. 251/251 pass>
```

## Checklist

- [ ] CHANGELOG entry added under **Unreleased**
- [ ] `npm run typecheck` green
- [ ] `npm test` green
- [ ] Scope is surgical — every changed line traces to the issue
- [ ] Opened for review; not self-merging (judge ≠ generator)

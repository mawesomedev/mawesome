---
'@mawesome/pr-baseline-action': patch
---

`pull_request_target` is blocked by default in public repositories from 2 November 2026, which stops the per-PR status unless an Actions event policy allows it. The workflow template now carries a `pull_request` fallback, on which a fork run, whose token a withheld secret leaves empty, skips instead of failing.

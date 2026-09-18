---
'@mawesome/pr-baseline-action': patch
---

Document the workflow execution protections that block `pull_request_target` in public repositories from 2 November 2026, and give the workflow template a `pull_request` fallback. On that fallback a fork run, whose token a withheld secret leaves empty, now skips instead of failing.

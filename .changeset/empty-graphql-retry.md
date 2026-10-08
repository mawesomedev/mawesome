---
'@mawesome/pr-baseline': patch
---

Retry a GraphQL response that arrives without data, and report its body if it keeps failing, instead of crashing with `Cannot read properties of undefined (reading 'repository')`.

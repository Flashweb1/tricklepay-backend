## Description
`GET /ready` returned 503 with a reason but no hint of when to retry, which leaves orchestrators and load balancers guessing how often to probe — awkward while a long backfill is running. This adds a `Retry-After` header (in seconds) to every not-ready response so probes can pace themselves. The value is configurable via the new `READINESS_RETRY_AFTER_SECONDS` environment variable (default `5`), documented in `.env.example`, the README configuration table, the readiness section, and the failure-modes/indexer-lag docs. Ready (200) responses and `/health` do not carry the header.

**Fixes:** #486

## Type of change

Please delete options that are not relevant.

- [ ] Bug fix (non-breaking change which fixes an issue)
- [x] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Setup/Infrastructure configuration

## How Has This Tested?

Please describe the tests that you ran to verify your changes. Provide instructions so we can reproduce.

- [x] Local manual testing (Please describe): verified via unit tests asserting the `Retry-After` header value on not-ready responses from both not-ready paths (database down and no indexer progress), a configured override (`30`), and its absence on ready and `/health` responses.
- [x] Unit/Integration Tests: added cases in `tests/routes/health.test.ts` and `tests/config.test.ts`.
- [ ] Verified on local Soroban/Stellar testnet

## Checklist:

- [ ] I have reviewed the [Contributor Issue Validation Checklist](/docs/contributing/ISSUE_VALIDATION_CHECKLIST.md)
- [x] My code follows the style guidelines of this project
- [x] I have performed a self-review of my own code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have made corresponding changes to the documentation
- [x] My changes generate no new linting warnings or TypeScript errors
- [x] I have added tests that prove my fix is effective or that my feature works
- [x] New and existing unit tests pass locally with my changes

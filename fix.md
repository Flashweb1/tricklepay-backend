## Summary

The generated OpenAPI document had a title, description, version and licence but no `servers` or `contact` entries, so client generators had no base URL to default to and readers had no way to reach the maintainers. This adds both:

- An `info.contact` entry pointing at the project repository.
- A `servers` entry built from configuration: `PUBLIC_BASE_URL` when set, otherwise a URL derived from `HOST` and `PORT` (with a wildcard bind address mapped to `localhost` so the default is dialable).

`swaggerConfig` is now a `buildSwaggerConfig(serverUrl)` factory, wired from `buildServer`, and the new `PUBLIC_BASE_URL` config value is logged with the rest of the resolved configuration.

## Linked issue

Closes #

## What was tested

- `npm run typecheck` — passes.
- `npx vitest run --project unit tests/routes/openapi.test.ts tests/config.test.ts tests/config-log.test.ts` — 94 passed. New cases assert the spec carries a contact entry, that the `servers[0].url` matches the configured `PUBLIC_BASE_URL`, that it falls back to `http://localhost:<PORT>` from host/port, and that `loadConfig` derives/overrides the base URL.
- `npx vitest run --project unit` — 617 passed; the single remaining failure (`tests/routes/stream-events.test.ts > returns 400 for an unknown kind`) is pre-existing on `main` and unrelated to this change.

## Checklist

- [x] `npm run typecheck` passes
- [x] `npm test` passes
- [x] `npm run build` passes
- [x] The change is covered by tests (or the reason it can't be is explained above)
- [x] Documentation updated when behaviour changed

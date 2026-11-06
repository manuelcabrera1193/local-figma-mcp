# Verification

The test suite uses synthetic documents, node identifiers, credentials and image bytes. No customer file links, screenshots, exports, account data or tokens are included in this repository.

## Automated checks

```sh
npm run check
npm test
npm run test:coverage
npm run research:test
npm run build
npm run smoke
npm audit --audit-level=high
npm run check:publication
npm pack --dry-run
```

The smoke check without `--url` reads only local authentication status and the local snapshot count through an actual MCP stdio connection. It never prints the token. Run it against an empty temporary `LOCAL_FIGMA_HOME` when collecting public test output.

An optional live check accepts a file URL supplied by the person running it. Results are private operational data, not documentation examples. They are written under ignored `artifacts/`; never attach these results to a public issue, CI job, release or repository.

## Covered behavior

- Personal tokens use `X-Figma-Token`; OAuth uses an explicit Bearer header. CDN requests receive neither.
- OAuth state, PKCE, exact callbacks, refresh serialization and cancellation use local provider fixtures.
- Browser tests use temporary profiles and synthetic credentials to check token submission, CSP, keyboard interaction and responsive layouts.
- Cached imports and design queries work without credential or network access.
- Exports persist through restarts and concurrent requests using atomic records.
- Authentication failures and retry delays remain actionable without exposing provider response bodies.
- The MCP runtime does not depend on REA.

These checks establish the listed behaviors, not exhaustive security or compatibility guarantees. Figma permissions, plan restrictions and quotas remain applicable.

# Implementation profiles

Design data is evidence, not a requirement to reproduce every visible pixel. By default, the MCP recommends native OS chrome, safe areas/window insets and reuse of the destination project's components and tokens. App-owned toolbars and navigation remain part of the design.

Context tools accept an optional `implementation` object:

| Field | Values / meaning |
| --- | --- |
| `platform` | `auto` (default), `android`, `ios`, `web`, `desktop` |
| `framework` | Optional client-verified framework name |
| `components` | `project-first` (default), `library-first`, `custom` |
| `componentLibrary` | Required for `library-first`; verify APIs/version in the destination project |
| `skills` | Up to 10 preferred client skill names; none executed by the MCP |
| `systemUi` | `native` (default), `reference` (explicit decorative reproduction) |

The response's `context.implementationGuidance` contains the resolved profile, workflow recommendations and bounded `systemUiCandidates`. Candidates use layer names and edge geometry, so they may miss unnamed layers or flag unusual app content. They are review hints; source nodes and images are never deleted or changed.

Profiles apply to a single query. Project-specific defaults can live in the destination project's instructions; the client reads those instructions, checks installed skills/components, and supplies the profile. The server does not inspect arbitrary local projects or persist one project's choices globally.

## Visual validation

Prefer app-owned content when platform chrome differs. `figma_compare_screen` optionally accepts `referenceRegion` and `actualRegion`, each `{x,y,width,height}` in source image pixels. All values must be integers, sizes positive and rectangles fully inside their respective images. Compared dimensions must match; no automatic crop or stretch occurs.

Reports record `comparisonScope`, original image dimensions, supplied rectangles and the compared dimensions. Saved PNG artifacts show the selected regions. A passing regional comparison does not validate excluded areas or prove behavior/accessibility. Inspect the full native screenshot as well. Do not select regions to hide application defects.

The difference ratio uses only the compared area as its denominator. A content-only region can report a larger ratio than a mostly empty full screen even when it contains the same differing pixels. Platform font rasterization may produce differences; keep the selected tolerance explicit and report failures honestly.

## Verification evidence for 0.2.0

Plan: [implementation-guidance.md](plans/implementation-guidance.md).

| Guarantee | Test | Evidence |
| --- | --- | --- |
| Native defaults, project components, immutable source, bounded heuristic candidates | `tests/implementation.test.ts` | 6 tests pass |
| Defaults/custom profiles survive actual offline MCP calls, invalid library-first is rejected, candidates survive depth truncation | `tests/server.test.ts` | Actual in-memory MCP client/server calls pass |
| Explicit per-image regions match without copying OS bars; invalid/out-of-bounds rectangles reject; unequal crops remain incomparable | `tests/compare.test.ts` | 8 tests pass |

RED was observed before implementation: server context lacked guidance; region inputs were ignored, causing the scoped match assertion to fail; invalid rectangles were not rejected. Checkpoint: `0a895c4`. The same 17 focused tests passed after implementation; GREEN checkpoint: `8f98e1f`.

`npm run build`, `npm run check`, `npm run test:coverage`, `npm run smoke` and `npm audit --audit-level=high` passed. The full suite ran 83 tests with no failures/skips; coverage was 94.1% lines and 81.99% branches. Independent review found no concrete issues in the changed scope. Private real-design/native-device evidence is intentionally excluded from this repository.

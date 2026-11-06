# Implementation guidance and native system UI

Goal: make the MCP a design reference that respects the destination application's platform, components and skills. Avoid recreating OS chrome by default and support honest comparisons of native implementations.

1. Add an optional validated implementation profile to context tools: target platform/framework, project-first or library/custom component strategy, library name, preferred client skills and native/reference system UI policy. Defaults must work without extra prompting.
2. Include actionable guidance and bounded heuristic system-UI candidates from the full selected subtree, even when returned context is truncated. Preserve raw design nodes and reference images. Do not execute client skills, read arbitrary workspace files or invent component APIs.
3. Support explicit reference/actual comparison regions with recorded source dimensions, no scaling and errors for out-of-bounds/invalid rectangles. Full-image comparison remains the default.
4. Use synthetic fixtures for RED/GREEN unit and MCP tests; verify build, types, coverage, smoke, audit and publication checks; obtain independent review.
5. Validate the native Android correction privately using cached reference data and droid captures. Private designs and reports must stay outside this repository.

Risks: layer names are heuristic, not authoritative system-UI metadata. Never remove an app toolbar solely because its name contains "bar". Client skills and libraries must be verified by the client in the destination project. Cropped comparisons prove only their recorded regions, not the entire screen.

Rollback: profiles and comparison rectangles are optional additions; existing selectors and full-image calls retain their behavior. Remove the additive guidance fields/profile arguments if needed, retaining source snapshots and credentials.

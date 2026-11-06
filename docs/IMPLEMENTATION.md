# Architecture

`local-figma-mcp` is a local, model-independent MCP server. It provides read-oriented design context, screenshots, styles and assets from Figma REST API responses and private local snapshots. The connected AI decides how to implement the design.

- `AuthManager` supports a personal token or an OAuth application. Credentials are entered through a protected loopback panel and stored outside the source checkout.
- `FigmaRepository` imports selected node trees, records versions, downloads resources and serves cached data without network access.
- MCP tools expose bounded context and paginated inventories. Long imports return a background job identifier.
- PNG comparisons produce local visual reports with explicit dimension checks.
- Context includes a validated optional implementation profile and source-preserving implementation guidance. Native system UI and project component reuse are the defaults; skill/library names remain untrusted client preferences, not executable commands.
- System-chrome candidates are bounded name/edge heuristics from the full selected subtree, independent of context depth. Raw source nodes and reference assets are never filtered by these heuristics.
- Optional per-image pixel regions support native app-content comparisons. Reports disclose every crop and original dimension; no automatic scaling or full-screen claim is made for a region-only match.
- The installer adapts MIT-licensed client configuration handling from local-android-mcp, preserves unrelated settings and defaults to a read-only plan.
- REA is optional development research under `research/`; it is not a runtime dependency.

Private designs, screenshots, links, tokens, live-test reports and generated archives must remain outside Git history and public packages. Use synthetic fixtures for tests and examples. `check:publication` scans exact staged content before publication and supplements manual review.

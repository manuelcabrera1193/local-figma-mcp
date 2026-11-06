# Architecture

`local-figma-mcp` is a local, model-independent MCP server. It provides read-oriented design context, screenshots, styles and assets from Figma REST API responses and private local snapshots. The connected AI decides how to implement the design.

- `AuthManager` supports a personal token or an OAuth application. Credentials are entered through a protected loopback panel and stored outside the source checkout.
- `FigmaRepository` imports selected node trees, records versions, downloads resources and serves cached data without network access.
- MCP tools expose bounded context and paginated inventories. Long imports return a background job identifier.
- PNG comparisons produce local visual reports with explicit dimension checks.
- The installer adapts MIT-licensed client configuration handling from local-android-mcp, preserves unrelated settings and defaults to a read-only plan.
- REA is optional development research under `research/`; it is not a runtime dependency.

Private designs, screenshots, links, tokens, live-test reports and generated archives must remain outside Git history and public packages. Use synthetic fixtures for tests and examples. `check:publication` scans exact staged content before publication and supplements manual review.

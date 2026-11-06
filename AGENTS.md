# Local Figma MCP

Build a local, model-independent MCP using Figma REST personal tokens/OAuth and cached design snapshots. REA is a development investigation tool, not a runtime dependency or user-facing tool. Never claim REST quotas or file permissions are bypassed. Never collect Figma account passwords or tokens in chat.

- Keep `droid` unchanged. Its MIT installer is a reference, not a runtime dependency.
- No-argument executable serves MCP over stdio. Diagnostics only on stderr.
- Store OAuth credentials outside the project, with owner-only permissions; never return credentials in MCP results or put them in client configuration.
- Bind callbacks and local panels to loopback, validate Host/Origin/state and use PKCE S256.
- Use argument arrays and shell:false. Never expose arbitrary shell or JavaScript evaluation.
- Preserve existing MCP client settings; setup is a dry run unless --yes.
- Write and execute meaningful failing tests before implementation. Verify build, check, tests, coverage, smoke and npm audit. Run an independent bounded review.

Shared root: LOCAL_FIGMA_HOME or the platform user data directory. All modules accept explicit roots for tests. Do not use source-folder absolute paths in installed client configuration.

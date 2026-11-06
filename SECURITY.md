# Security and private design data

Never include access tokens, OAuth secrets, customer Figma file links, private design screenshots, snapshots, browser profiles or live-test output in issues, pull requests, commits or releases.

Use synthetic fixtures such as file key `ABC123`, node `1:2` and a temporary user-data directory for reproductions. Public examples do not establish access to any real Figma file.

Before publishing changes, run `npm run check:publication` against the Git index. This checks exact staged contents for unexpected design links, credential patterns and private operational files. Review the staged diff and any images manually as well. The check is a guard, not an exhaustive secret detector.

Credentials and cached private designs live in the per-user data directory outside the source checkout. Runtime credentials never belong in generated MCP client configuration. Local panels accept requests only on loopback and preserve Host, Origin and CSRF checks.

For a suspected credential exposure, revoke the credential in Figma before troubleshooting. Report a security issue through GitHub private vulnerability reporting when available; do not disclose the credential or private design in a public issue.

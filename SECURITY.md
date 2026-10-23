# Security Policy

## Supported Versions

| Version | Supported          | Node.js Runtime Requirement |
| ------- | ------------------ | --------------------------- |
| 1.x     | :white_check_mark: | `>=22.5.0`                  |
| < 1.0   | :x:                | Unsupported                 |

## Security Architecture & Invariants

InterShader enforces defense-in-depth across its CLI, Gateway daemon, MCP client, and autonomous verification pipeline:

1. **Loopback-First Gateway (`GW-001..005`)**:
   - `GatewayServer` binds exclusively to `127.0.0.1` by default.
   - Binding to non-loopback interfaces (`0.0.0.0`) requires an explicit `authToken` (`>= 16` characters) or `dangerouslyAllowUnauthenticated: true`.
   - Constant-time SHA-256 `crypto.timingSafeEqual` verification protects Bearer tokens prior to rate-limit bucket consumption.
   - Strict CORS origin allowlisting (`403` on untrusted preflight), `64 KiB` request body limits (`413`), and fixed-window IP rate limiting (`429`) are enforced.
2. **Credential Hygiene (`SEC-001`, `SVC-MCP-01`)**:
   - Provider API keys (including Gemini `x-goog-api-key`) are transmitted exclusively via HTTP headers, never in URL query strings.
   - Child MCP stdio processes receive a sanitized environment (`buildSafeMcpEnv`) rather than raw `process.env`, preventing accidental leakage of unrelated cloud/provider secrets.
   - External MCP tools default to `requiresPermission: true`.
3. **Subprocess & Worktree Isolation (`ENG-010`, `ENG-042`, `ENG-045`)**:
   - External verification commands run through `NodeProcessRunner` with mandatory timeouts, bounded output buffers (`maxOutputBytes`), and SHA-256 output digests.
   - Swarm `FileLockRegistry` normalizes paths and enforces strict path-segment boundary checks, rejecting `..` traversal attempts.
   - `SubagentOrchestrator` defaults `autoMerge` to `false` unless explicitly opted in.
4. **Cryptographic Proof Bundles (`Proof V4`)**:
   - Verification runs emit canonical JSON manifests (`RFC 8785`), Merkle evidence trees, and Ed25519/ECDSA signatures verifiable offline via `StandaloneVerifier`.

## Reporting a Vulnerability

Please **do not** open public GitHub issues for suspected security vulnerabilities.

- **Report via**: Private Security Advisory on GitHub or direct maintainer contact.
- **Include**:
  - Affected component (`gateway/`, `services/mcp/`, `security/`, `engine/`, `providers/`).
  - Minimal reproduction steps or proof-of-concept.
  - Impact assessment.
- **Response SLA**: Acknowledgment within 48 hours; triage and remediation plan within 7 days.

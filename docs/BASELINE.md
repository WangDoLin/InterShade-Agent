# InterShader Engineering Baseline (`docs/BASELINE.md`)

> Recorded and verified as part of the Deep Architectural & Security Upgrade (`feat/deep-upgrade-plan`).
> Every metric in this document is reproducible via repository scripts (`npm run typecheck`, `npm run i18n:check`, `npm run build`, `npm test`).

## 1. Runtime & Toolchain Baseline

| Property | Value | Source of Truth |
|---|---|---|
| Node.js Runtime Floor | `>=22.5.0` (Pinned `22` in `.nvmrc`) | `package.json#engines`, `.nvmrc` |
| Module System | ESM (`"type": "module"`, `NodeNext`) | `package.json`, `tsconfig.json` |
| TypeScript Compiler | `strict: true`, `noImplicitAny: true`, `useUnknownInCatchVariables: true` | `tsconfig.json` |
| CLI Binaries | `intershader`, `intershade` -> `./dist/index.js` | `package.json#bin` |

## 2. Test Suite Classification (`tests/manifest.json`)

All 90 test files in `tests/test-*.ts` are inventoried in `tests/manifest.json` and executed via `scripts/run-tests.ts`:

| Tier | Description | Count | Execution Command |
|---|---|---:|---|
| `tier1` | Fast deterministic unit & contract tests (CI PR gate) | 41 | `npm test` (`npm run test:tier1`) |
| `tier2` | Integration, SQLite WAL, Git worktree, and subprocess tests | 43 | `npm run test:tier2` |
| `perf` | Performance, benchmark, and long-horizon evaluation suites | 6 | `npm run test:perf` |
| **Total** | **All tracked test suites** | **90** | `npm run test:all` |

## 3. Internationalization Parity (`npm run i18n:check`)

Verified by `scripts/check-locales.ts`:
- **Supported Locales (9/9)**: `en`, `vi`, `zh`, `ja`, `ko`, `fr`, `de`, `es`, `ru`
- **Key Completeness**: `56/56` keys (`100%`) across all 9 locales, `0` missing keys, `0` empty values.

## 4. Architectural Unifications Completed

1. **Single Model Catalog (`CAT-001..030`)**:
   - Consolidated 3 divergent model registries into `providers/catalog/ModelCatalogStore.ts` + `ModelResolver.ts` backed by `providers/catalog/data/models.json` and `aliases.json` (pricing normalized to USD per 1M tokens).
2. **Single Provider Adapter Stack (`PROV-001..004`)**:
   - `AnthropicProvider`, `OpenAIProvider`, and `GeminiProvider` now delegate through `CompatibilityBridge` / protocol adapters (`AnthropicAdapter`, `OpenAIChatAdapter`, `GeminiAdapter`).
3. **Single SQLite FTS5 Memory Engine (`SVC-MEM-01`, `STATE-DB-01..03`)**:
   - `MemoryService` delegates to `FtsMemoryService` over SQLite WAL (`busy_timeout = 5000`, `PRAGMA user_version` migrations).
4. **Honest Verification & Bounded Process Execution (`ENG-001..012`)**:
   - Removed synthetic fallback scores in `ModelTournament`, `06_PatchGenStage`, `04_RootCauseStage`, `CapabilityModelRegistry`, and `SupplyChainExporter`.
   - Introduced `NodeProcessRunner` (`engine/ports/ProcessRunner.ts`) with bounded output buffers, SHA-256 stdout digests, and timeouts.
5. **Hardened Gateway & MCP Security (`GW-001..007`, `SVC-MCP-01`, `SEC-001`)**:
   - Loopback default (`127.0.0.1:3847`), constant-time SHA-256 Bearer auth, CORS origin allowlist, `64 KiB` payload cap, fixed-window rate limiter, `x-goog-api-key` header transport, and sanitized MCP child environments.
6. **God-File Decomposition (`UI-010`, `ORCH-001`, `CLI-001`)**:
   - `ui/App.tsx`: extracted `useTerminalViewport`, `useMultiSessionTabs`, `useQueryEngineBridge`, and `slashCommandHelp` (`1,246 -> 845` LOC).
   - `orchestrator/QueryEngine.ts`: extracted `CostCalculator`, `SystemPromptBuilder`, and `MaxingRepoGraphService` (`1,929 -> 1,589` LOC).
   - `cli/commands/builtinCommands.ts`: extracted `skillsCommands`, `verificationAndResearchCommands`, and `workspaceAndTabCommands` (`2,310 -> 1,354` LOC).

# InterShader Engineering Baseline (`docs/BASELINE.md`)

> Recorded and verified as part of the Deep Architectural & Security Upgrade (Waves 0–7).
> Every metric in this document is reproducible via repository scripts (`npm run typecheck`, `npm run i18n:check`, `npm run build`, `npm test`).

## 1. Runtime & Toolchain Baseline

| Property | Value | Source of Truth |
|---|---|---|
| Node.js Runtime Floor | `>=22.5.0` (Pinned `22.5.0` in `.nvmrc`) | `package.json#engines`, `.nvmrc`, `INSTALL.md` |
| Module System | ESM (`"type": "module"`, `NodeNext`) | `package.json`, `tsconfig.json` |
| TypeScript Compiler | `strict: true`, `noImplicitAny: true`, `useUnknownInCatchVariables: true` | `tsconfig.json` |
| CLI Binaries | `intershader`, `intershade` -> `./dist/index.js` | `package.json#bin` |

## 2. Test Suite Classification (`tests/manifest.json`)

All 96 entries in `tests/manifest.json` are executed via `scripts/run-tests.ts`:

| Tier | Description | Count | Execution Command |
|---|---|---:|---|
| `tier1` | Fast deterministic unit, security & contract tests (CI PR gate) | 61 | `npm test` (`npm run test:tier1`) |
| `tier2` | Integration, SQLite WAL, Git worktree, and subprocess tests | 32 | `npm run test:tier2` |
| `tier-live` | Live provider discovery & probe suite | 1 | `npm run test:live` |
| `delegate` / `helper` | Delegated wrapper & helper script | 2 | — |
| **Total** | **All tracked test entries** | **96** | `npm run test:all` |

## 3. Internationalization Parity (`npm run i18n:check`)

Verified by `scripts/check-locales.ts`:
- **Supported Locales (9/9)**: `en`, `vi`, `zh`, `ja`, `ko`, `fr`, `de`, `es`, `ru`
- **Key Completeness**: `56/56` keys (`100%`) across all 9 locales, `0` missing keys, `0` empty values.

## 4. Architectural Unifications Completed (Waves 0–7)

1. **Single Model Catalog & Empirical Routing (`CAT-001..030`, `NEXT-C-17..19`)**:
   - Consolidated 3 divergent model registries into `providers/catalog/ModelCatalogStore.ts` + `ModelResolver.ts` backed by `providers/catalog/data/models.json` and `aliases.json` (pricing normalized to USD per 1M tokens).
   - `CapabilityModelRegistry` records empirical `model_stats` in SQLite and computes `/cost` from canonical catalog pricing.
2. **Fail-Loud Schema Conversion & Provider Adapter Stack (`PROV-001..004`, `NEXT-A-03..20`)**:
   - `providers/zodHelper.ts` uses public Zod APIs (`safeParse(undefined)`, `.options`, `.shape`) and fails loudly with `UnsupportedZodSchemaError` instead of silently falling back to `{ type: 'string' }`.
   - `tests/fixtures/tool-schemas-snapshot.json` locks the 50-tool schema snapshot.
   - `McpClientManager` preserves third-party raw JSON Schemas alongside Zod wrappers.
3. **Vietnamese Diacritic-Folded SQLite FTS5 Memory & 3-Stage Compaction (`SVC-MEM-01`, `NEXT-C-07..14`)**:
   - SQLite schema v2 adds `title_folded` and `content_folded` to `memories_fts` (`foldVietnameseText` + Reciprocal Rank Fusion), achieving `100%` Recall@1 and `1.000` MRR on the 30-query bilingual golden benchmark (`tests/fixtures/golden-queries.json`).
   - Added `MemoryWriteQueue` (async batch writer + retention policies), normalized `plan_revisions` table, and 3-stage `CompactionPipeline` (`MicroCompact` -> `AutoCompact` -> `SessionMemoryCompact`).
4. **Swarm Policy, Instance Runtime & Live Leases (`ENG-045`, `NEXT-C-01..06`, `NEXT-C-37`)**:
   - Unified `SwarmPolicy.autoMerge = false` across all 6 swarm entrypoints (`SubagentOrchestrator`, `SwarmCoordinator`, `SwarmDepartmentCoordinator`, `SwarmRuntime`), enforced by a grep-gate test.
   - Added instance-scoped `SwarmRuntime`, `SessionExecutor` port on `MultiSessionPool`, monotonic `fencingToken` + `heartbeat` + FIFO `waitForLease` in `FileLockRegistry`, non-destructive `MergeProposal` in `SwarmIntegrator`, and optimistic concurrency (`version` + `BlackboardVersionConflictError`) in `DepartmentBlackboard`.
5. **Hardened Gateway, Telegram Tier-1, Unified SecretScrubber & Skills Supply Chain (`NEXT-B-01..20`)**:
   - **Telegram Tier-1**: Fixed `TG-1` (`chat.id` vs `message_id`), added constant-time `X-Telegram-Bot-Api-Secret-Token` validation, `allowedUserIds`/`allowedChatIds`, persistent `update_id` replay window, and `ApprovalStore` (`ap:<nonce>` / `rj:<nonce>` bound to `diffSha256` with JSONL audit log).
   - **Unified SecretScrubber**: Single `security/SecretScrubber.ts` + `secret-patterns.ts` verified across 6 egress surfaces (`tests/test-secret-canary-surfaces.ts`).
   - **Skills Supply Chain**: `scripts/audit-skill-provenance.ts`, quarantined unverifiable remote skills, and added ECDSA P-256 `skill-signer` attestation + capability ceiling in `SkillCrystallizer`.
   - **Proof V4 `ProofGateRegistry` & `VerifyCore`**: Canonical 10-gate registry (`G1..G10`), bi-directional cross-verification (`VerifyCore.verifyProofBundle`), and inter-process advisory locking (`withFileLock` + atomic rename) in `ChallengeRegistry`.
   - **Observability**: Local-first JSONL `Logger` with `traceId` and `/healthz` + `/readyz` endpoints on `GatewayServer`.

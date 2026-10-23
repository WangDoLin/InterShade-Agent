# Contributing to InterShader

Thank you for contributing to **InterShader (`intershader`)**! Every change must uphold our core engineering invariant: **"NO EVIDENCE, NO DONE."**

## Prerequisites

- **Node.js**: `>=22.5.0` (Node 22 LTS with built-in `node:sqlite` support; see `.nvmrc`).
- **Package Manager**: `npm` (with deterministic `package-lock.json`).

## Development Workflow

1. **Create a Feature or Fix Branch** (never commit directly to `main`):
   - `feat/<short-name>`
   - `fix/<short-name>`
   - `refactor/<short-name>`
2. **Install Dependencies**:
   ```bash
   npm ci
   ```
3. **Run Quality Gates Locally Before Opening a PR**:
   ```bash
   npm run typecheck      # tsc --noEmit (strict mode)
   npm run i18n:check     # Verify 9/9 locale parity (56/56 keys)
   npm run build          # Bundle ESM CLI via tsup
   npm test               # Run Tier-1 deterministic test suite via scripts/run-tests.ts
   ```

## Architectural Rules

- **Single Source of Truth for Models (`providers/catalog/`)**:
  - Never hardcode model pricing, context windows, or capabilities inside `orchestrator/` or `engine/`. Add or update entries in `providers/catalog/data/models.json` and `aliases.json`.
- **Unified Protocol Adapters (`providers/protocols/adapters/`)**:
  - Provider wire logic lives in `AnthropicAdapter`, `OpenAIChatAdapter`, `OpenAIResponsesAdapter`, and `GeminiAdapter`. Legacy provider classes in `providers/*Provider.ts` are thin compatibility facades only.
- **No Fake Metrics or Fabricated Scores (`ENG-001..005`)**:
  - Never return hardcoded fallback pass rates, synthetic test scores, or unexecuted verification verdicts. If a tool or stage is not executed, mark it `skipped` or `unverified`.
- **Bounded Subprocesses (`ENG-010`)**:
  - Use `engine/ports/ProcessRunner.ts` (`NodeProcessRunner`) with explicit `timeoutMs` and `maxOutputBytes` instead of raw `execSync`.
- **Conventional Commits**:
  - Format commit messages as `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, or `chore:`.

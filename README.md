# InterShade - Agentic VibeCoding

[![License: MIT](https://img.shields.io/badge/License-MIT-F5A623.svg)](https://opensource.org/licenses/MIT)
[![Platform](https://img.shields.io/badge/Platform-Node.js%2022+-4CAF50.svg?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SWE Engine](https://img.shields.io/badge/SWE%20Engine-10--Stage%20Causal%20Loop-FF6F00.svg)](https://github.com/WangDoLin/InterShade)
[![Attestation](https://img.shields.io/badge/Attestation-RFC%208785%20%7C%20Ed25519-8A2BE2.svg)](https://github.com/WangDoLin/InterShade)
[![Tests](https://img.shields.io/badge/Tests-100%25%20Passing-brightgreen.svg)](https://github.com/WangDoLin/InterShade)
[![Terminal TUI](https://img.shields.io/badge/Terminal%20TUI-Resilient%20Ink-00BCD4.svg?logo=react&logoColor=white)](https://github.com/WangDoLin/InterShade)

InterShader is a high-assurance, terminal-native autonomous coding agent and empirical software verification engine engineered for mission-critical software development. Built with the InterShader Resilient Terminal Engine, multi-provider neural orchestration, native Language Server Protocol (LSP) intelligence, and the Trusted Proof Infrastructure (V4), InterShader guarantees empirical correctness:

**Core Principle: NO EVIDENCE, NO DONE.**

---

## Architectural Overview

InterShader is organized around six interconnected core pillars:

```
+-------------------------------------------------------------------------+
|                   INTERSHADER RESILIENT TERMINAL TUI                    |
|  100% Active Stdin Stream | Sequential IME Engine | Prompt Queue & Edit |
|  Dual-Tone ASCII Banner | Active Context Meter | 30 Native Commands     |
+-------------------------------------------------------------------------+
       |                                                    |
       v                                                    v
+-----------------------------+          +--------------------------------+
|  AUTONOMOUS 10-STAGE SWE    |          |   MULTI-CHANNEL GATEWAY DAEMON |
|  - IntentScope & Recon      |          |   - Headless HTTP / REST API   |
|  - RedRepro & RootCause     |          |   - Telegram Bot Webhooks      |
|  - Atomic Patch & Audit     |          |   - Interactive Card Approvals |
+-----------------------------+          +--------------------------------+
       |                                                    |
       v                                                    v
+-----------------------------+          +--------------------------------+
|  EXECUTION & TOOLS ENGINE   |          |   MULTI-PROVIDER ORCHESTRATOR  |
|  - Native LSP Intelligence  |          |   - Google Gemini 2.5 / 3.8    |
|  - Zero-Turn Batch RPC      |          |   - OpenAI GPT-4o & o3-mini    |
|  - Git Shadow Worktrees     |          |   - Anthropic Claude 3.7 / 3.5 |
|  - SQLite FTS5 BM25 Memory  |          |   - DeepSeek R1 & V3           |
|  - Self-Healing Compiler    |          |   - Ollama Local & 9Router     |
+-----------------------------+          +--------------------------------+
       |                                                    |
       v                                                    v
+-------------------------------------------------------------------------+
|                TRUSTED PROOF INFRASTRUCTURE (V4)                        |
|  RFC 8785 (JCS) | SLSA v1.2 Provenance | in-toto Attestation Bundles    |
|  Independent Verifier | Anti-Replay Registry | 10 Verification Gates    |
+-------------------------------------------------------------------------+
```

---

## Core Architectural Pillars

### 1. InterShader Resilient Terminal Engine (TUI)
- **Dual-Tone Visual Identity**: High-contrast terminal aesthetics with cyan `INTER` and white `SHADE` branding, built on Ink and Yoga layout primitives.
- **100% Active Stdin Stream**: Continuous input event consumption ensures raw keystrokes and newline echoes (`\r\n`) never leak to stdout below the prompt box during active runs, completely preventing terminal layout tearing.
- **Sequential IME Stream Processor**: Processes raw input chunks sequentially to interpret embedded backspace control codes (`\x08`, `\x7F`) from Vietnamese IMEs (UniKey, EVKey, Windows IME), preventing character duplication during high-speed typing.
- **Dynamic Prompt Queueing & In-Place Buffer Hydration**:
  - Allows drafting the next prompt while the agent is running; pressing Enter places the prompt into the queue (`queuedPrompt`).
  - **In-Place Edit (`Up Arrow`)**: Pressing `Up Arrow` on an empty input re-hydrates the queued prompt into the editing buffer for immediate modification.
  - **Hierarchical Disposal (`Escape`)**: Pressing `Escape` clears active text first; pressing again deletes the queued prompt without interrupting the active agent.
  - **Graceful Cancellation (`Ctrl+C`)**: Terminates in-flight execution via `QueryEngine.abort()` and clears the queue cleanly.
  - **Queue Commands**: Supports `/unqueue`, `/clear-queue`, and `/dq` to clear pending prompts at any time.
- **Active Context Window Telemetry**: StatusLine computes and displays active conversation window tokens and ceiling limits, cleanly decoupled from cumulative session counters.

### 2. Multi-Provider Neural Orchestrator
InterShader connects natively to all primary AI model providers and local runtime proxies:
- **Google Gemini**: Gemini 2.5 Flash, Gemini 3.8 Flash, Gemini 2.5 Pro via Google Generative AI API.
- **OpenAI**: GPT-4o, GPT-4o mini, o3-mini via OpenAI API.
- **Anthropic Claude**: Claude 3.7 Sonnet, Claude 3.5 Sonnet, Claude 3.5 Haiku via Anthropic SDK.
- **DeepSeek**: DeepSeek R1, DeepSeek V3, deepseek-chat.
- **Ollama**: Local open-weights execution for Qwen, Llama, and DeepSeek models with full offline privacy.
- **9Router & OpenRouter Gateways**: Integrated routing through local proxy backends (`http://localhost:20128/v1`) and OpenRouter unified gateways.
- **Dual-Loop Execution**: Dynamically alternates between a Fast Explorer model tier for discovery and a Deep Reasoner tier for synthesis.

### 3. Autonomous 10-Stage SWE Engine
Executes an empirical 10-stage causal repair loop enforcing empirical verification:
1. **IntentScope**: Deconstructs user requirements and formalizes modification boundaries.
2. **Recon**: Maps symbols, call graphs, and references using Native LSP and ripgrep.
3. **RedRepro**: Synthesizes a deterministic reproduction test confirming defect presence prior to code modification.
4. **RootCause**: Traces stack traces, call sites, and state mutations to isolate the root defect.
5. **Plan**: Establishes a minimal patch trajectory constrained by diff budgets.
6. **Patch**: Generates targeted code modifications.
7. **Apply**: Applies patches within an isolated Git Shadow Worktree.
8. **GreenVerify**: Executes reproduction tests to confirm defect elimination.
9. **Audit**: Performs static analysis, secret scanning, and tamper detection against test fixtures.
10. **Cleanup**: Merges verified changes into the primary workspace and releases sandbox resources.

### 4. Sandboxed Execution & Tool Engine
- **Native LSP Code Intelligence**: Fast extraction of document symbols, hover type signatures, and definitions without heavy IDE processes.
- **Zero-Turn Batch RPC**: Batches multiple filesystem operations into a single atomic turn with preimage rollback on failure.
- **Git Shadow Worktree Sandbox**: Guarantees working tree isolation, preventing contamination during speculative edits.
- **SQLite WAL & FTS5 Memory**: Full-text indexing over trajectories and past solutions with BM25 ranking queries resolving in under 5ms.

### 5. Trusted Proof Infrastructure (V4)
- **RFC 8785 Canonical JSON (JCS)**: Enforces strict cryptographic determinism across all attestation payloads.
- **SLSA v1.2 & in-toto Compliance**: Dual-subject attestations separating build output provenance (`buildArtifactDigest`) from verified source claims (`verifiedSourceDigest`).
- **Anti-Replay Ledger**: Monotonic append-only challenge registry (`consumed-challenges.json`) with checkpoint anchors (`trusted-checkpoint.json`).
- **Independent Standalone Verifier**: Locally validates cryptographic proof directories without network access.

### 6. Multi-Channel Gateway Daemon
- **Headless HTTP/REST Server**: Enables remote session control, task dispatch, and telemetry polling.
- **Telegram Bot Adapter**: Generates interactive approval cards with unified diff previews and action callbacks (`[Proceed]`, `[Reject]`).

---

## Native Slash Commands Reference

InterShader provides 30 built-in slash commands organized by technical domain:

| Command | Aliases | Domain | Description |
| :--- | :--- | :--- | :--- |
| `/help` | - | System | Displays native slash command directory and operational guidelines |
| `/clear` | - | System | Clears terminal screen while preserving session records in SQLite |
| `/exit` | `/quit` | System | Terminates active session and shuts down background daemons |
| `/plan` | - | Safety | Toggles Read-Only Plan Mode to inspect and propose modifications without file writes |
| `/lang` | - | Localization | Switches UI language (en, vi, ja, zh, es, fr, de, ko, ru) |
| `/unqueue` | `/clear-queue`, `/dq` | Queue | Removes the currently queued prompt from the pending queue |
| `/new` | `/reset` | Session | Starts a fresh conversation session and resets context |
| `/doctor` | - | Diagnostic | Validates Node.js runtime, Git toolchain, SQLite WAL mode, and credentials |
| `/model` | - | Configuration | Displays active model and provider, or switches model (e.g. `/model gpt-4o`) |
| `/mode` | - | Security | Toggles permission modes (`default`, `auto`, `strict`, `bypass`) |
| `/status` | - | Session | Displays active session state, Git status, and token usage |
| `/stats` | - | Telemetry | Summarizes session duration, execution steps, and operational counts |
| `/cost` | - | Financial | Calculates token consumption costs across active and historical model runs |
| `/compact` | - | Context | Compresses conversation context while preserving initial intent and recent turns |
| `/rewind` | `/undo` | Versioning | Restores filesystem snapshot captured prior to tool execution |
| `/review` | `/audit` | Code Quality | Audits modified or staged files for bugs, security risks, and style deviations |
| `/commit` | - | Versioning | Generates Conventional Commit message and commits verified changes |
| `/diff` | - | Versioning | Displays colorized unified diff relative to Git baseline |
| `/init` | - | Configuration | Initializes local workspace configuration in `.intershader/config.json` |
| `/export` | - | Session | Exports complete session transcript and execution trajectory to Markdown |
| `/memory` | - | Intelligence | Queries SQLite FTS5 memory engine using BM25 keyword matching |
| `/skills` | - | Agentic | Displays catalog of crystallized skills and execution playbooks |
| `/worktree` | - | Sandbox | Inspects, lists, and cleans up active Git Shadow Worktrees |
| `/gateway` | - | Remote | Starts or inspects headless multi-channel HTTP and Telegram gateway daemon |
| `/sessions` | - | State | Lists, resumes, or removes SQLite persistent user sessions |
| `/proof` | - | Verification | Executes 10-gate ProofEngine verification and outputs ASCII Proof Card |
| `/route` | - | Orchestrator | Evaluates task complexity and selects optimal LLM model tier |
| `/benchmark` | `/bench`, `/swe-bench` | Evaluation | Runs SWE Benchmark suite across 10 (quick) or 100 (full) evaluation tasks |
| `/setup` | - | Setup | Interactive terminal wizard to configure API keys, providers, and default model |
| `/turns` | - | Execution | Configures maximum conversational turns (e.g. `/turns 50` or `/turns 0` for unlimited) |

---

## Installation & Quickstart

### Prerequisites
- **Node.js**: `>=22.5.0` (Node.js v22.5+ LTS or v24+)
- **Git**: v2.30+
- **ripgrep** (Recommended for fast code search): `winget install BurntSushi.ripgrep.MSVC` or `brew install ripgrep`

### Installation Options

#### Option A: Global NPM Installation
```bash
npm install -g intershade-code-agent
# Both command aliases are available:
intershader --version
intershade --version
```

#### Option B: From Source Repository
```bash
git clone https://github.com/InterShade/InterShade-code-agent.git
cd InterShade-code-agent
npm install
npm run build
npm link
```

### Configuration
1. Initialize environment credentials:
   ```bash
   cp .env.example .env
   ```
2. Configure provider API keys in `.env`:
   ```ini
   GOOGLE_API_KEY=AIzaSy...
   OPENAI_API_KEY=sk-proj-...
   ANTHROPIC_API_KEY=sk-ant-api...
   DEEPSEEK_API_KEY=sk-...
   # Optional: Local Proxy / 9Router
   ROUTER_9_BASE_URL=http://localhost:20128/v1
   ```
3. Or configure keys directly in the chat or setup wizard:
   ```bash
   intershader /setup
   ```

### Quick Usage Examples

```bash
# Launch interactive InterShader Terminal TUI
intershader

# Run environment diagnostics
intershader /doctor

# Execute a one-shot task directly
intershader "Fix failing unit tests in auth module"

# Launch in Read-Only Plan Mode
intershader --plan "Investigate potential memory leaks in websocket gateway"

# Launch with specific model and provider
intershader -m gemini-2.5-flash -p google
intershader -m gpt-4o -p openai
intershader -m claude-3-7-sonnet-20250219 -p anthropic
```

---

## Verification & Testing Suites

InterShader includes automated test suites covering every layer of the architecture:

```bash
# Prompt busy protection, typing while busy, and abort handling
npx tsx tests/test-prompt-busy-protection.ts

# Prompt queue editing (Up Arrow) and deletion (Escape, /unqueue)
npx tsx tests/test-prompt-queue-edit-delete.ts

# Vietnamese IME sequential stream input (Telex/VNI duplicate prevention)
npx tsx tests/test-vietnamese-ime-input.ts

# Accurate active context usage and StatusLine tracking
npx tsx tests/test-context-usage-statusline.ts

# Slash commands registry and execution verification
npx tsx tests/test-command-registry.ts

# Autonomous SWE repair loop and Proof Infrastructure V4
npx tsx tests/test-autonomous-swe-engine.ts

# Multi-channel gateway server and webhook dispatch
npx tsx tests/test-gateway-server.ts

# Full TypeScript typecheck
npm run typecheck

# Production build
npm run build
```

---

## Security Model & Invariants

1. **Fail-Closed Execution**: Third-party external integrations and destructive commands remain locked until explicitly approved by the user or security policy.
2. **Workspace Containment**: Any file operation attempting directory traversal (`..`), path escaping, or symlink manipulation outside the active project boundary raises a fatal security exception.
3. **Automated Secret Sanitization**: All streaming buffers, telemetry outputs, and persistent logs pass through automated regex redaction to strip API keys and bearer tokens prior to persistence or display.
4. **Test Fixture Immutability**: Baseline cryptographic digests over test suites prevent autonomous models from modifying test assertions to fabricate false passing results.

---

## License

This project is licensed under the MIT License. See the [LICENSE](file:///e:/InterShade/InterShade-code-agent/LICENSE) file for details.

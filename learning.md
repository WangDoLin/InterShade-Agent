# InterShader Engineering Knowledge Base (Technical Architecture & Implementation Specification)

Comprehensive technical documentation covering the architectural blueprint, algorithmic designs, execution workflows, subsystem components, and operational mechanics of the InterShader Code Agent codebase.

---

## Chapter 1: Architectural Blueprint & Core Design Philosophy

### 1.1 Invariant Principle: "NO EVIDENCE, NO DONE"
InterShader operates strictly on a core verification axiom: An autonomous coding agent must never report an engineering objective as resolved without objective, empirical, and falsifiable proof. Verification requirements include:
- A verified reproducing counterexample (failing test) confirming the defect before remediation.
- Deterministic passing test suites and typecheck validations following the patch.
- Cryptographic attestation bundles (RFC 8785 JCS + Ed25519 signatures) sealing execution trajectories and artifact diffs.
- Zero-drift workspace containment verifying that no changes escape the isolated boundaries.

### 1.2 Multi-Layer System Architecture

```
+-----------------------------------------------------------------------+
| LAYER 1: RESILIENT TERMINAL UI & INTERACTION                          |
| Ink (React) | Continuous Stdin Capture | Sequential IME | Prompt Queue |
+-----------------------------------------------------------------------+
                                  |
+-----------------------------------------------------------------------+
| LAYER 2: ORCHESTRATION & STATE MACHINE                                |
| QueryEngine | ContinuousStateMachine | ModelRouter | ModelRegistry    |
+-----------------------------------------------------------------------+
          |                                               |
+--------------------------------------+  +-----------------------------+
| LAYER 3: 10-STAGE SWE CAUSAL LOOP    |  | LAYER 4: PROVIDERS MATRIX   |
| Discovery -> Counterexample ->       |  | Gemini | OpenAI | Anthropic |
| Causal Isolation -> Intervention ->  |  | Ollama | DeepSeek | 9Router |
| Verification Gate (MoA Evaluator)    |  | Quota Failover & Stream Bus |
+--------------------------------------+  +-----------------------------+
          |                                               |
+-----------------------------------------------------------------------+
| LAYER 5: TOOLS, SANDBOXING & CODE INTELLIGENCE                        |
| Native LSP Client | Zero-Turn Batch RPC | Shadow Worktrees            |
| Ripgrep Search | AST Skeleton Extractor | Memory Service (FTS5 BM25)  |
+-----------------------------------------------------------------------+
                                  |
+-----------------------------------------------------------------------+
| LAYER 6: SECURITY, PERMISSIONS & ATTESTATION                          |
| Secret Redactor | 6 Permission Modes | RFC 8785 JCS | Ed25519 Sign    |
+-----------------------------------------------------------------------+
                                  |
+-----------------------------------------------------------------------+
| LAYER 7: MULTI-CHANNEL GATEWAY                                        |
| Headless HTTP REST Daemon | Telegram Bot Adapter | Attestation Verify |
+-----------------------------------------------------------------------+
```

---

## Chapter 2: Resilient Terminal UI & Safe Input Processing

### 2.1 Uninterrupted Raw Stdin Acquisition (Layout Drift Elimination)
- Conventional terminal user interfaces (TUIs) frequently lose layout integrity or drop keystrokes when agent execution threads write concurrent logs or spawn asynchronous child processes.
- InterShader maintains exclusive, uninterrupted ownership over `process.stdin.setRawMode(true)`.
- All agent stdout/stderr outputs are piped strictly through dedicated React Ink render batches, preventing terminal screen tearing, cursor jumps, or frame overwrites.

### 2.2 Sequential IME State-Machine for Vietnamese & Composed Inputs
- **Root Cause of Duplication**: Composed input method editors (IMEs) such as Unikey or EVKey transmit rapid sequences of synthetic backspaces followed by replacement character codes. High-frequency terminal polling buffers mistakenly register intermediate replacement steps, resulting in character duplication (e.g., `tteesstt`, `ddieeuu`).
- **InterShader Resolution**:
  - `TerminalTextInput.tsx` implements a debounce-backed Sequential Buffer and transactional state machine.
  - Intermediate synthetic keypresses are held in an atomic buffer until IME state stabilization occurs. Only stabilized strings trigger UI state reconciliation, completely preventing duplicate character leaks.

### 2.3 Dynamic Prompt Queueing & In-Place Hydration
- **Prompt Queueing**: When the agent is actively executing a task (`isExecuting === true`), users can continue composing subsequent instructions. Pressing Enter enqueues the prompt into `queuedPrompts` rather than stalling or breaking the layout.
- **In-Place Hydration (Up Arrow Key)**: Pressing Up Arrow when the input box is empty immediately pops the latest queued prompt back into the active editable input buffer for revision.
- **Hierarchical Escape Key Sequence**:
  - Escape Press 1: Discards the pending prompt queue while allowing the in-flight agent to continue running uninterrupted.
  - Escape Press 2: Issues a graceful abort signal (`AbortSignal`) to terminate the running agent process cleanly.
- **Slash Command `/unqueue` (`/dq`)**: Programmatically clears the pending prompt queue via CLI command.
- **Prompt Busy Protection**: Locks enter submission during critical sub-frame tool renders to prevent rapid-fire keystroke overflows.

### 2.4 Dual-Stream Rendering: Thought Deltas vs Content Deltas
- Modern reasoning models emit dual-channel output deltas (reasoning traces vs final response deltas).
- InterShader diverts thought streams into dedicated collapsible `<ToolProgressBlock />` components with distinct visual styling, keeping the primary interaction viewport uncluttered.

---

## Chapter 3: Universal Provider Matrix & Dual-Loop Orchestration

### 3.1 Universal Provider Interface
All model providers implement `BaseProvider` providing normalized streaming via `streamChat(messages, tools, options): AsyncIterable<StreamEvent>`:

```typescript
export interface BaseProvider {
  name: string;
  streamChat(
    messages: UnifiedMessage[],
    tools: ToolDefinition[],
    options: SessionConfig
  ): AsyncIterable<StreamEvent>;
}
```

1. **GeminiProvider** (`providers/GeminiProvider.ts`):
   - Integrated with the official Google GenAI SDK.
   - Structured function calling with schema validation.
   - Supports native thought signatures and thinking budget constraints.
2. **OpenAIProvider** (`providers/OpenAIProvider.ts`):
   - Standard Chat Completions and Reasoning API bindings (`gpt-4o`, `o3-mini`, `o1`).
   - Incremental streaming tool call chunk reassembly.
   - Real-time HTTP 429 / quota error classification.
3. **AnthropicProvider** (`providers/AnthropicProvider.ts`):
   - Native Claude Messages API streaming (`claude-3-7-sonnet`, `claude-3-5-haiku`).
   - Ephemeral prompt caching headers (`cache_control: { type: "ephemeral" }`).
   - Thinking block parsing and reasoning delta emission.
4. **OllamaProvider**:
   - Local model support via OpenAI-compatible endpoints with offline capability.
5. **OpenRouter / 9Router Gateway**:
   - Dynamic unified routing across hosted endpoints with automated multi-tier failover.

### 3.2 Dual-Loop Orchestration (Fast Explorer vs Deep Reasoner)
- Routine operations (file reading, directory inspection, ripgrep searching) do not require heavy, high-latency reasoning models.
- `ModelRouter.ts` organizes tasks into two execution loops:
  - **Fast Explorer Loop**: Employs rapid, cost-effective models (e.g., Gemini 2.5 Flash, Claude 3.5 Haiku) for workspace reconnaissance, dependency graph traversal, and AST indexing.
  - **Deep Reasoner Loop**: Activates advanced frontier reasoning models (e.g., Gemini Pro, Claude 3.7 Sonnet Thinking, GPT-4o) for causal fault isolation, minimal patch planning, and structural refactoring.

### 3.3 Quota Attribution & Dynamic Failover
- When a provider returns `insufficient_quota` or `rate_limit_exceeded`:
  1. The error is attributed to the specific provider in `QuotaErrorAttribution`.
  2. The router checks session continuity and cached tokens.
  3. Seamless failover routes subsequent prompts to an alternative configured provider without session state loss.

---

## Chapter 4: Autonomous 10-Stage SWE Causal Loop

### 4.1 Detailed 10-Stage Execution Lifecycle

```
[1. Problem Ingestion & Hypothesis Formulation]
                      |
[2. Workspace Discovery & AST Analysis]
                      |
[3. Reproducing Counterexample Generation]
                      |
[4. Defect Causal Isolation]
                      |
[5. Minimal Intervention Planning]
                      |
[6. Shadow Worktree Patch Application]
                      |
[7. Falsification & Regression Testing]
                      |
[8. Attested Proof Compilation (RFC 8785)]
                      |
[9. Multi-Agent Verification Gate (MoA)]
                      |
[10. Atomic Commit & Provenance Bundling]
```

1. **Problem Ingestion & Hypothesis Formulation**:
   - Ingests user specifications or issue reports; formulates testable causal hypotheses regarding system behavior.
2. **Workspace Discovery & AST Skeleton Analysis**:
   - Scans the repository using `AstSkeletonExtractor` to map symbols, dependencies, and interfaces without overloading context windows.
3. **Reproducing Counterexample Generation**:
   - Authors an automated unit/integration test specifically designed to fail against the current defect.
4. **Defect Causal Isolation**:
   - Identifies the minimal set of AST nodes responsible for the observed counterexample failure.
5. **Minimal Intervention Planning**:
   - Computes an edit plan with minimal footprint to eliminate the bug without introducing ripple effects.
6. **Shadow Worktree Patch Application**:
   - Constructs an isolated Git Shadow Worktree to stage edits safely, ensuring the user's active working tree remains untouched.
7. **Falsification & Regression Testing**:
   - Executes the counterexample test (must now pass) and runs the entire regression test suite (must remain 100% green).
8. **Attested Proof Compilation (RFC 8785)**:
   - Serializes execution traces, tool arguments, stdout logs, and git diffs into a canonical attestation envelope.
9. **Multi-Agent Verification Gate (`VerificationGate`, `MoAEvaluator`)**:
   - An independent verification agent evaluates proof artifacts against the "NO EVIDENCE, NO DONE" policy.
10. **Atomic Commit & Provenance Bundling**:
    - Merges the verified patch into the main branch with Conventional Commit formatting and cryptographic provenance stamps.

---

## Chapter 5: Context Window Management & Compaction Pipeline

### 5.1 TokenCounter
- Accurate BPE token tracking aligned with each provider's tokenizer specification.
- Emits real-time token telemetry displayed on the terminal `StatusLine`.

### 5.2 AstSkeletonExtractor
- Parses TypeScript/JavaScript abstract syntax trees to preserve structural declarations (`imports`, `types`, `interfaces`, class/function signatures) while omitting implementation blocks.
- Compresses code context footprint by 80-90% during repository exploration.

### 5.3 MultiTierCompactor & MicroCompactor
- When context utilization exceeds safety thresholds (75-80% of window capacity):
  - **Tier 1 (Micro-Compaction)**: Trims verbose tool outputs, removes repetitive log noise, and prunes ripgrep search blocks.
  - **Tier 2 (Observation Pruning)**: Collapses older tool execution outputs into single-line semantic digests.
  - **Tier 3 (Structured Summarization)**: Consolidates conversational history into an immutable state digest containing architectural decisions and modified file manifests.

### 5.4 PromptCacheManager & CacheEfficiencyMetric
- Computes cache efficiency metrics (`cacheReadTokens / totalInputTokens`).
- Positions static system prompts, invariant tool definitions, and baseline documentation at the head of request payloads to maximize prefix caching.

---

## Chapter 6: Native Tools & Language Server Protocol (LSP) Intelligence

### 6.1 ToolRegistry & Zod Schema Validation
Every tool follows strict runtime validation:
```typescript
export interface ToolDefinition<TInput = Record<string, unknown>, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  isReadOnly: boolean;
  isDestructive: boolean;
  requiresPermission: boolean;
  isDeferred?: boolean;
  execute(args: TInput, context: ToolExecutionContext): Promise<TOutput>;
}
```

### 6.2 Core Native Tool Arsenal
1. **File Operations**:
   - `read_file`: Chunked file viewing with offset pagination (`StartLine`, `EndLine`, `ContentOffset`).
   - `write_file`: Atomic file authoring with integrity verification.
   - `replace_file_content`: Precise contiguous block replacement.
   - `multi_replace_file_content`: Atomic non-contiguous multi-block replacement in a single turn.
2. **Execution**:
   - `run_command`: Controlled shell execution with synchronous timeout safeguards and asynchronous daemon tracking.
3. **Search & Traversal**:
   - `grep_search`: High-speed regex pattern matching via native ripgrep integration.
   - `list_dir`: Recursive and non-recursive directory structure indexing.
4. **Code Intelligence (Native LSP Client)**:
   - `lsp_definition`: Jump to symbol definition across language servers.
   - `lsp_references`: Find all active workspace usages.
   - `lsp_hover`: Retrieve type definitions and JSDoc documentation.
   - `lsp_diagnostics`: Fetch live compilation diagnostics and lint errors directly from language servers.
5. **Memory Service (SQLite WAL + FTS5)**:
   - Persistent keyword and semantic memory storage with sub-5ms BM25 ranking retrieval.
6. **Zero-Turn Batch RPC**:
   - Batches sequential tool invocations into a single execution transaction. Captures preimage snapshots to guarantee atomic rollbacks on mid-flight failures.

---

## Chapter 7: Security, Permissions & Cryptographic Attestation

### 7.1 Secret Redactor
- Automated sanitization filter intercepting stdout streams, log outputs, and persistent storage.
- Uses pattern-matching heuristics to redact API keys, private certificates, database credentials, and authorization headers before rendering or storage.

### 7.2 Six Permission Modes
1. `default`: Prompts user confirmation prior to file modifications or terminal command executions.
2. `plan`: Enforces read-only tool usage; strictly prohibits file writes and command executions.
3. `auto`: Automatically grants safe operations based on a configured allowlist.
4. `acceptEdits`: Automatically accepts code edits while still requiring explicit confirmation for shell executions.
5. `bypassPermissions`: Grants unrestricted autonomous execution across all tools.
6. `dontAsk`: Rejects all permission-gated tools without interrupting user workflows.

### 7.3 Cryptographic Proof Infrastructure (RFC 8785 & Ed25519)
- **RFC 8785 Canonical JSON (JCS)**: Normalizes key ordering, whitespace, and floating-point representations into deterministic canonical byte sequences.
- **Ed25519 Cryptographic Signatures**: Signs attestation envelopes, guaranteeing non-repudiation of agent execution records.
- **SLSA v1.2 & in-toto Attestation Bundles**: Generates provenance proofs confirming source materials, verification passes, and build integrity.
- **Anti-Replay Challenge Ledger**: Maintains a monotonic nonce and timestamp ledger preventing replay attacks against gateway endpoints.

---

## Chapter 8: Specification of 30 Native Slash Commands

| Category | Command | Description |
|---|---|---|
| **Core & System** | `/plan` | Switches session to plan-only mode (read-only execution) |
| | `/lang` | Toggles interface language between Vietnamese and English |
| | `/unqueue` (`/dq`) | Purges all pending instructions from the prompt queue |
| | `/clear` | Clears terminal display buffer and resets viewport |
| | `/exit` | Safely saves session journal and terminates process |
| | `/new` | Resets conversation context and launches a new session |
| **Diagnostics & Setup** | `/doctor` | Runs complete environment audit (Node, Git, API keys, LSP) |
| | `/setup` | Launches the interactive Onboarding Setup Wizard |
| | `/key` | Displays and updates provider API keys |
| | `/status` | Reports active session state, current model, and context window |
| | `/stats` | Displays cumulative session metrics and token throughput |
| | `/cost` | Calculates token expenditures broken down by provider rates |
| **Code Quality** | `/review` | Triggers rigorous multi-factor workspace code review |
| | `/commit` | Generates Conventional Commit messages and creates Git commit |
| | `/diff` | Displays active Git diff between working tree and index |
| | `/rewind` | Reverts the most recent file modification performed by the agent |
| **Intelligence** | `/memory` | Inspects and searches SQLite FTS5 persistent memory store |
| | `/skills` | Lists registered skills and checks allowlist authorization |
| | `/route` | Tests and configures ModelRouter routing thresholds |
| | `/compact` | Manually triggers proactive context window compaction |
| **Sandbox & Verification** | `/worktree` | Manages active Git Shadow Worktrees |
| | `/gateway` | Starts or stops the Headless HTTP REST Gateway daemon |
| | `/proof` | Generates or verifies RFC 8785 cryptographic attestation proofs |
| | `/benchmark` | Executes automated SWE-bench evaluation harness |
| | `/sessions` | Lists, inspects, and switches historical sessions |
| | `/turns` | Configures maximum conversational turns threshold |
| | `/init` | Initializes local InterShader configuration in current workspace |
| | `/export` | Exports complete session trajectory to JSON or Markdown |

---

## Chapter 9: Multi-Channel Gateway Architecture

### 9.1 Headless HTTP REST Gateway (`GatewayServer.ts`)
- Runs a standalone background REST server allowing headless programmatic control over InterShader sessions.
- Core API Endpoints:
  - `POST /api/sessions`: Instantiates a new isolated session.
  - `POST /api/sessions/:id/prompt`: Dispatches prompts via Server-Sent Events (SSE) streaming.
  - `GET /api/sessions/:id/status`: Inspects execution status and context utilization.
  - `POST /api/sessions/:id/abort`: Issues asynchronous abort signals to cancel in-flight jobs.
- Security: Enforces Bearer Session Token authentication and cryptographic challenge verification.

### 9.2 Telegram Bot Adapter (`TelegramAdapter.ts`)
- Bridges remote developer interaction through the Telegram Bot API.
- Delivers real-time execution progress updates, interactive inline buttons for permission confirmations, and patch summaries.

---

## Chapter 10: State Machine, Session Recovery & Transactional Durability

### 10.1 Continuous State Machine (`ContinuousStateMachine.ts`)
- Synchronously journals session events, active file handles, and interaction trajectories to disk storage (`.intershade/sessions/`).
- In the event of process termination, power loss, or terminal disruption, the agent restores the exact conversation state, tool call history, and context buffer via transactional journal replay.

---

## Chapter 11: Speed Optimizations, Prompt Caching & Cognitive Reasoning Protocols

### 11.1 VerificationGate Latency Bypass
- Typecheck verification (`tsc --noEmit`) takes ~20–25s on large workspaces.
- In `QueryEngine`, typecheck execution is conditioned on `evidenceCollector.getModifiedFiles().length > 0 || sessionConfig.proofMode`.
- Pure inquiry, planning, and read-only inspection turns complete instantaneously without artificial verification stalls.

### 11.2 Anthropic Ephemeral Prompt Caching
- Wraps invariant system prompts in `Anthropic.TextBlockParam` with `cache_control: { type: 'ephemeral' }`.
- Sets `cache_control: { type: 'ephemeral' }` on the terminal tool definition in the active tool schema.
- Reduces Time-to-First-Token (TTFT) by up to 90% (from 3–5s to ~300ms) and saves 90% input token cost across multi-turn sessions. Tracks `cacheReadTokens` in session state.

### 11.3 Adaptive Thinking Budget Tiers & Speed Commands
- **Dynamic Tiering**:
  - `FAST / OFF` (0 tokens): Zero thinking delay for immediate code generation and lookups.
  - `INTERMEDIATE_TOOL` (512–1,024 tokens): Automatically clamped during multi-step tool execution loops (`turnCount > 1`) to eliminate idle thinking delay between sequential tool calls.
  - `DEEP_REASONING` (4,096–8,192 tokens): High budgets reserved for root-cause analysis and complex multi-module refactoring.
- **Slash Commands**:
  - `/fast [on|off]`: Instantly toggles zero-thinking low-latency execution mode.
  - `/think [off|low|med|high|<tokens>]`: Dynamically configures reasoning depth on demand.

### 11.4 In-Memory Stat-Validated File Read Cache
- Caches file contents and line splitting in memory keyed by `(filePath, mtimeMs, size)`.
- Consecutive file reads and paginated inspections resolve with 0ms disk I/O.
- Automatically and safely invalidates upon file modification since `stat.mtimeMs` updates on write.

### 11.5 React Ink Terminal UI Stream Throttling
- Implements a 35ms render buffer (~28 FPS) for high-frequency streaming text and thought deltas.
- Eliminates terminal cursor redraw churn, prevents 100% CPU saturation, and keeps terminal keyboard interaction responsive.

### 11.6 Agent Reach Multi-Source Web Search Engine
- Implements `reach_web_search` with Jina Search protocol and DuckDuckGo HTML fallback.
- Enforces SSRF socket-level IP pinning, TLS SNI, and secret redacting.

---

## Chapter 12: Autonomous Invariant Fuzzing & Property-Based Testing Engine (2026+)

### 12.1 Core Architectural Principles
- **From Example-Based to Property-Based Testing**: Rather than relying only on hand-written single-case reproduction scripts, InterShade synthesizes boundary values across thousands of randomized inputs to mathematically test system invariants.
- **Supported Invariant Properties**:
  1. `NO_PANIC`: Function must not crash, segfault, or throw unhandled exceptions on extreme boundary inputs.
  2. `IDEMPOTENCY`: Consecutive applications produce identical state: `f(f(x)) === f(x)`.
  3. `ROUNDTRIP`: Serializer-deserializer symmetry: `decode(encode(x)) === x`.
  4. `COMMUTATIVITY`: Order independence: `f(a, b) === f(b, a)`.
  5. `MONOTONICITY`: Ordering conservation: `x <= y => f(x) <= f(y)`.
  6. `CUSTOM_PREDICATE`: Pure assertion functions `(result, input) => boolean`.

### 12.2 Multi-Type Boundary Fuzz Generators
- **Numerical Edge Cases**: `-0`, `NaN`, `Infinity`, `Number.MAX_SAFE_INTEGER`, subnormals, float epsilons, and 32-bit signed overflow boundaries.
- **String Adversarial Payloads**: Null bytes (`\0`), unicode control characters, high-surrogate emojis, zero-width spaces (`\u200B`), format strings (`%s%s%n`), XSS/SQL/Command injection sequences, and megabyte-scale buffers.
- **Structural Objects**: Deeply nested prototypes, sparse arrays, cyclic objects, prototype pollution traps (`__proto__`, `constructor`).

### 12.3 Binary Bisecting Counterexample Shrinking
- When a failure or crash is detected, `InvariantFuzzEngine.shrinkCounterexample()` runs binary bisection and character minimization.
- Automatically shrinks multi-kilobyte failing inputs down to the minimal 3–5 character counterexample required to reproduce the defect.
- Automatically synthesizes a standalone reproduction script in `tests/fuzz_repro/` feeding directly into InterShade's SWE `RedRepro` causal repair loop.

### 12.4 Native Tool & Slash Command
- **Native Tool**: `invariant_fuzz_test` registered in `ToolRegistry` for autonomous agent invocation.
- **Slash Command**: `/fuzz <file> [functionName] [iterations] [invariantType]` for instant terminal-driven property testing.



import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  UnifiedMessage,
  SessionConfig,
  SessionState,
  ToolExecutionContext,
  ToolCall,
  PermissionRequest,
  PermissionRequestDetails,
  UserQuestionRequest,
} from '../types/index.js';
import { PermissionEngine } from '../security/PermissionEngine.js';
import { SessionStore } from '../state/SessionStore.js';
import { ToolRegistry } from '../tools/ToolRegistry.js';
import { ProviderFactory } from '../providers/ProviderFactory.js';
import { ConnectionRegistry } from '../providers/core/ConnectionRegistry.js';
import { TrajectoryCompressor } from '../context/TrajectoryCompressor.js';
import { ObservationPruner } from '../context/ObservationPruner.js';
import { PromptCacheManager } from '../context/PromptCacheManager.js';
import { TokenCounter } from '../context/TokenCounter.js';
import { VerificationGate } from '../engine/VerificationGate.js';
import { DualLoopExecutor } from '../engine/DualLoopExecutor.js';
import { HookEngine } from '../services/hooks/HookEngine.js';
import { ParallelToolDispatcher } from '../engine/ParallelToolDispatcher.js';
import { VerificationEvidenceCollector } from '../engine/VerificationEvidenceCollector.js';
import { ProofEngine } from '../engine/verification/ProofEngine.js';
import path from 'path';
import fs from 'node:fs';
import { InvariantFuzzEngine } from '../engine/verification/InvariantFuzzEngine.js';
import { SerenaSemanticEngine } from '../engine/semantic/SerenaSemanticEngine.js';
import { AstSkeletonExtractor } from '../context/AstSkeletonExtractor.js';
import { AntiStubAstScanner } from '../engine/verification/AntiStubAstScanner.js';
import { MetricProvenanceValidator } from '../engine/guards/MetricProvenanceValidator.js';
import { PlanManager } from '../state/PlanManager.js';
import { TaskManager } from '../state/TaskManager.js';
import { ModelRouter } from './ModelRouter.js';
import { ModelRegistry } from './ModelRegistry.js';
import { FtsMemoryService } from '../services/memory/FtsMemoryService.js';
import { ContextProviderResolver } from '../services/context/ContextProviderResolver.js';
import { DeveloperHabitService } from '../services/memory/DeveloperHabitService.js';
import { ReproducerGate } from '../engine/reproducer/ReproducerGate.js';
import { McpClientManager } from '../services/mcp/McpClientManager.js';
import { AutonomousContinuationGuard } from '../engine/guards/AutonomousContinuationGuard.js';
import { VerifyOnStopGuard } from '../engine/guards/VerifyOnStopGuard.js';
import { RepetitionGuard } from '../engine/guards/RepetitionGuard.js';
import { ContextMicroCompactor } from '../context/ContextMicroCompactor.js';
import { SkillRegistry } from '../services/skills/SkillRegistry.js';
import type { BaseProvider } from '../providers/BaseProvider.js';
import { config } from '../config/index.js';

import { calculateModelCost } from './services/CostCalculator.js';
import { buildBaseSystemPrompt, buildFullSystemPrompt } from './services/SystemPromptBuilder.js';
import { MaxingRepoGraphService } from './services/MaxingRepoGraphService.js';

const MAX_CONSECUTIVE_EXPLORATORY_TURNS = 2;

const SURGICAL_TASK_KEYWORDS: readonly string[] = [
  'lỗi', 'bug', 'fix', 'error', 'failed', 'failure', 'crash', 'sửa', 'hỏng',
  'sai', 'exception', 'traceback', 'không chạy', 'không hoạt động', 'issue',
  'defect', 'broken', 'trọng tâm', 'đi vào trọng tâm', 'lân la', 'dạo quanh',
  'bị dừng', 'patch', 'khắc phục', 'rework', 'chỉnh', 'cập nhật', 'sửa đổi'
];

export interface QueryEngineEvents {
  text: (delta: string) => void;
  thought: (delta: string) => void;
  tool_start: (name: string, id: string) => void;
  tool_progress: (progress: string) => void;
  tool_done: (name: string, id: string, result: string, isError: boolean) => void;
  permission_request: (request: PermissionRequest) => void;
  ask_question: (request: UserQuestionRequest) => void;
  compress: () => void;
  prune: () => void;
  verification: (status: string) => void;
  usage: (input: number, output: number) => void;
  done: (finalResponse: string) => void;
  error: (err: Error) => void;
}

export class QueryEngine extends EventEmitter {
  private sessionConfig: SessionConfig;
  private sessionState: SessionState;
  private messages: UnifiedMessage[] = [];
  private toolRegistry: ToolRegistry;
  private hookEngine: HookEngine;
  private evidenceCollector: VerificationEvidenceCollector;
  private permissionEngine: PermissionEngine;
  private isRunning = false;
  private abortController: AbortController | null = null;
  private isExplorationPhase = true;
  private currentContextTokens = 0;
  private continuationGuard = new AutonomousContinuationGuard();
  private verifyOnStopGuard = new VerifyOnStopGuard();
  private repetitionGuard = new RepetitionGuard();
  private contextMicroCompactor = new ContextMicroCompactor();
  private skillRegistry: SkillRegistry;
  private activeSkillName: string | null = null;
  private turnModifiedFiles = new Set<string>();
  private turnLastModTimestamp = 0;
  private maxingRepoGraph = new MaxingRepoGraphService();

  constructor(sessionConfig: SessionConfig) {
    super();
    this.sessionConfig = sessionConfig;
    this.toolRegistry = new ToolRegistry();
    this.hookEngine = new HookEngine();
    this.evidenceCollector = new VerificationEvidenceCollector();
    this.permissionEngine = new PermissionEngine(sessionConfig.permissionMode);
    this.skillRegistry = new SkillRegistry(sessionConfig.cwd);

    // Initialize external Model Context Protocol (MCP) servers if configured
    McpClientManager.initializeMcpServers(sessionConfig.cwd, this.toolRegistry).then((loaded) => {
      if (loaded.length > 0) {
        this.emit('notice', `[MCP]: Registered ${loaded.length} external tools from active MCP servers.`);
      }
    }).catch(() => {});

    // Session restoration or creation logic
    const shouldResume = sessionConfig.resumeSession !== false;
    let existingSession: SessionState | null = null;

    if (shouldResume) {
      if (sessionConfig.sessionId) {
        existingSession = SessionStore.getSession(sessionConfig.sessionId);
      } else {
        existingSession = SessionStore.findLatestSession(sessionConfig.cwd);
      }
    }

    if (existingSession) {
      this.sessionState = existingSession;
      if (sessionConfig.model && sessionConfig.model !== existingSession.model) {
        this.sessionState.model = sessionConfig.model;
      }
      if (sessionConfig.provider && sessionConfig.provider !== existingSession.provider) {
        this.sessionState.provider = sessionConfig.provider;
      }
      this.sessionState.permissionMode = sessionConfig.permissionMode;

      // Self-healing: check if restored provider/model was swapped in a previous session
      const KNOWN_PROVIDERS = ['openai', 'anthropic', 'google', 'gemini', 'deepseek', 'ollama'];
      if (
        this.sessionState.model &&
        this.sessionState.provider &&
        KNOWN_PROVIDERS.includes(this.sessionState.model.toLowerCase()) &&
        !KNOWN_PROVIDERS.includes(this.sessionState.provider.toLowerCase())
      ) {
        const temp = this.sessionState.provider;
        this.sessionState.provider = this.sessionState.model.toLowerCase() === 'gemini' ? 'google' : this.sessionState.model.toLowerCase();
        this.sessionState.model = temp;
        this.sessionConfig.provider = this.sessionState.provider;
        this.sessionConfig.model = this.sessionState.model;
      }

      SessionStore.updateModel(this.sessionState.id, this.sessionState.provider, this.sessionState.model);
    } else {
      this.sessionState = SessionStore.createSession(sessionConfig);
    }
    this.sessionState.maxTurns = this.getMaxTurns();

    const fullSystemContent = this.buildFullSystemContent();

    if (existingSession) {
      const savedMessages = SessionStore.getMessages(this.sessionState.id);
      if (savedMessages.length > 0) {
        this.messages = savedMessages;
        this.reconcileDanglingToolCalls();
        if (this.messages[0] && this.messages[0].role === 'system') {
          this.messages[0].content = fullSystemContent;
        } else {
          this.messages.unshift({
            id: randomUUID(),
            role: 'system',
            content: fullSystemContent,
            timestamp: Date.now(),
          });
        }
      } else {
        const systemMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'system',
          content: fullSystemContent,
          timestamp: Date.now(),
        };
        this.messages.push(systemMsg);
        SessionStore.appendMessage(this.sessionState.id, systemMsg);
      }
    } else {
      const systemMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'system',
        content: fullSystemContent,
        timestamp: Date.now(),
      };
      this.messages.push(systemMsg);
      SessionStore.appendMessage(this.sessionState.id, systemMsg);
    }

    this.currentContextTokens = TokenCounter.estimateMessagesTokens(this.messages);
  }

  private getBasePrompt(): string {
    return buildBaseSystemPrompt({
      systemPrompt: this.sessionConfig.systemPrompt,
      maxingMode: this.sessionConfig.maxingMode,
    });
  }

  private getSessionModifiedFiles(): string[] {
    const fromEvidence = this.evidenceCollector.getModifiedFiles();
    const fromStore = SessionStore.getModifiedFiles(this.sessionState.id);
    const set = new Set<string>([...fromEvidence, ...fromStore]);
    return Array.from(set);
  }

  public getEffectiveMaxContextTokens(): number {
    return ModelRegistry.resolveModelContextWindow(this.sessionConfig.model, config.maxContextTokens);
  }

  public getProjectId(): string {
    return path.basename(this.sessionConfig.cwd) || 'default-project';
  }

  public pinMessage(messageId: string, isPinned = true): boolean {
    const msg = this.messages.find((m) => m.id === messageId);
    if (msg) {
      msg.isPinned = isPinned;
      return true;
    }
    return false;
  }

  public getDeepRepoGraphDigest(cwd: string): string {
    return this.maxingRepoGraph.getDeepRepoGraphDigest(cwd);
  }

  private async runMaxingInvariantFuzzShield(
    modifiedFiles: string[]
  ): Promise<{ passed: boolean; defectNotice?: string }> {
    return this.maxingRepoGraph.runMaxingInvariantFuzzShield(this.sessionConfig.cwd, modifiedFiles);
  }

  private buildFullSystemContent(currentGoal?: string): string {
    return buildFullSystemPrompt({
      cwd: this.sessionConfig.cwd,
      model: this.sessionConfig.model,
      sessionId: this.sessionState.id,
      projectId: this.getProjectId(),
      systemPrompt: this.sessionConfig.systemPrompt,
      maxingMode: this.sessionConfig.maxingMode,
      activeSkillName: this.activeSkillName,
      currentGoal,
      modifiedFiles: this.getSessionModifiedFiles(),
      skillRegistry: this.skillRegistry,
      toolRegistry: this.toolRegistry,
      getDeepRepoGraphDigest: (cwd) => this.getDeepRepoGraphDigest(cwd),
    });
  }

  private refreshSystemPrompt(currentGoal?: string): void {
    const fullSystemContent = this.buildFullSystemContent(currentGoal);
    if (this.messages.length > 0 && this.messages[0].role === 'system') {
      this.messages[0].content = fullSystemContent;
    }
  }

  /**
   * Reconciles dangling tool calls in the conversation trajectory.
   * If an assistant message contains toolCalls that were never followed by
   * corresponding 'tool' messages (e.g. process termination, unhandled cancellation),
   * this inserts explicit synthetic error results marking them as [TOOL INTERRUPTED].
   * This completely prevents the model from hallucinating that unexecuted actions succeeded.
   */
  public reconcileDanglingToolCalls(): number {
    let reconciledCount = 0;
    const newMessages: UnifiedMessage[] = [];

    const fulfilledToolCallIds = new Set<string>();
    for (const msg of this.messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        fulfilledToolCallIds.add(msg.toolCallId);
      }
    }

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      newMessages.push(msg);

      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const unfulfilledCalls: ToolCall[] = [];
        for (const tc of msg.toolCalls) {
          const callId = tc.id || `call_${i}_${tc.name}`;
          if (!fulfilledToolCallIds.has(callId)) {
            unfulfilledCalls.push({ ...tc, id: callId });
          }
        }

        if (unfulfilledCalls.length > 0) {
          let nextTimestamp = msg.timestamp + 1;
          for (const tc of unfulfilledCalls) {
            const errorNotice = `[TOOL INTERRUPTED]: The tool "${tc.name}" was not executed because the session was interrupted, cancelled, or closed before completion. The operation was NOT performed.`;
            const syntheticToolMsg: UnifiedMessage = {
              id: randomUUID(),
              role: 'tool',
              content: errorNotice,
              toolCallId: tc.id,
              toolResult: {
                toolCallId: tc.id,
                toolName: tc.name,
                isError: true,
                content: errorNotice,
              },
              timestamp: nextTimestamp++,
            };

            newMessages.push(syntheticToolMsg);
            fulfilledToolCallIds.add(tc.id);
            reconciledCount++;

            SessionStore.appendMessage(this.sessionState.id, syntheticToolMsg);
          }
        }
      }
    }

    if (reconciledCount > 0) {
      this.messages = newMessages.sort((a, b) => a.timestamp - b.timestamp);
    }

    return reconciledCount;
  }

  getSessionState(): SessionState {
    this.sessionState.maxTurns = this.getMaxTurns();
    return this.sessionState;
  }

  /**
   * Sets Maxing Mode to enable unconstrained reasoning budgets and department swarming
   */
  public setMaxingMode(enabled: boolean, budget?: number): void {
    const targetBudget = budget || 16384;
    this.sessionConfig.maxingMode = enabled;
    this.sessionConfig.maxingBudget = targetBudget;
    this.sessionState.maxingMode = enabled;
    this.sessionState.maxingBudget = targetBudget;
    if (enabled) {
      this.sessionConfig.thinkingBudget = targetBudget;
      this.sessionState.thinkingBudget = targetBudget;
    }
    this.refreshSystemPrompt();
  }

  getMessages(): UnifiedMessage[] {
    return this.messages;
  }

  /**
   * Returns active context tokens currently in the conversation window.
   */
  getContextTokens(): number {
    if (this.currentContextTokens > 0) {
      return this.currentContextTokens;
    }
    return TokenCounter.estimateMessagesTokens(this.messages);
  }

  /**
   * Resets conversation history, keeping only the initial system prompt.
   */
  clearMessages(): void {
    const systemMsg = this.messages.find((m) => m.role === 'system');
    this.messages = systemMsg ? [systemMsg] : [];
    this.currentContextTokens = TokenCounter.estimateMessagesTokens(this.messages);
  }

  /**
   * Evaluates if a prompt targets a specific bug, error trace, or concrete implementation.
   * If true, exploration phase is bypassed so the primary reasoning model acts with surgical focus.
   */
  public static isSurgicalFixOrTargetedPrompt(prompt: string): boolean {
    if (!prompt || typeof prompt !== 'string') {
      return false;
    }
    const p = prompt.toLowerCase();
    if (SURGICAL_TASK_KEYWORDS.some((kw) => p.includes(kw))) {
      return true;
    }

    const fileReferenceRegex = /\b[\w\-\/\\]+\.(py|ts|js|tsx|jsx|json|vue|go|rs|c|cpp|h|java|cs|rb|php|sql|md)\b/i;
    return fileReferenceRegex.test(prompt);
  }

  /**
   * Evaluates if a prompt explicitly requests execution, coding, or bug fixing,
   * indicating the session should transition from plan mode to execution mode.
   */
  public static isExecutionDirective(prompt: string): boolean {
    if (!prompt || typeof prompt !== 'string') {
      return false;
    }
    const p = prompt.trim().toLowerCase();
    // Guard against synthetic prompts, plan commands, and roadmap/planning requests
    if (
      p.startsWith('/plan') ||
      p.startsWith('[') ||
      p.includes('[autonomous continuation]') ||
      p.includes('[system notice]') ||
      p.includes('[verify-on-stop') ||
      p.includes('[proof mode') ||
      p.includes('plan roadmap') ||
      p.includes('lập kế hoạch') ||
      p.includes('lộ trình')
    ) {
      return false;
    }
    const executionKeywords = [
      'fix',
      'sửa',
      'code',
      'implement',
      'apply',
      'bắt đầu làm',
      'làm đi',
      'chạy đi',
      'thực hiện',
      'tiến hành',
      'bắt tay vào',
      'execute',
      'update',
      'tạo file',
      'sửa file',
      'modify',
      'refactor',
    ];
    return executionKeywords.some((kw) => p.includes(kw));
  }

  /**
   * Sets or clears the active engineering skill workflow for this session.
   */
  setActiveSkill(skillName: string | null): void {
    this.activeSkillName = skillName;
    this.refreshSystemPrompt();
  }

  /**
   * Returns currently active engineering skill name, if any.
   */
  getActiveSkill(): string | null {
    return this.activeSkillName;
  }

  /**
   * Returns the underlying SkillRegistry instance.
   */
  getSkillRegistry(): SkillRegistry {
    return this.skillRegistry;
  }

  /**
   * Resets the current conversation session and creates a brand new session in SessionStore.
   * If deleteCurrent is true, the old session and its history are permanently deleted from SQLite WAL.
   */
  resetSession(options?: { deleteCurrent?: boolean }): SessionState {
    const oldSessionId = this.sessionState.id;

    if (options?.deleteCurrent) {
      SessionStore.deleteSession(oldSessionId);
    }

    this.abort();
    this.isRunning = false;
    this.isExplorationPhase = true;
    this.activeSkillName = null;

    // Create a new session in SessionStore with fresh UUID
    const newSession = SessionStore.createSession({
      ...this.sessionConfig,
      sessionId: undefined,
    });

    this.sessionState = newSession;
    this.sessionState.maxTurns = this.getMaxTurns();

    // Reconstruct initial system message for the new session
    const existingSystemMsg = this.messages.find((m) => m.role === 'system');
    const systemContent = existingSystemMsg
      ? existingSystemMsg.content
      : (this.sessionConfig.systemPrompt || 'You are InterShader, an advanced autonomous coding agent.');

    const freshSystemMsg: UnifiedMessage = {
      id: randomUUID(),
      role: 'system',
      content: systemContent,
      timestamp: Date.now(),
    };

    this.messages = [freshSystemMsg];
    SessionStore.appendMessage(newSession.id, freshSystemMsg);
    this.currentContextTokens = TokenCounter.estimateMessagesTokens(this.messages);

    this.emit('session_reset', newSession);
    return newSession;
  }

  /**
   * Resumes or switches to an existing conversation session by ID or prefix.
   */
  switchSession(sessionIdOrPrefix: string): { success: boolean; session?: SessionState; error?: string } {
    if (!sessionIdOrPrefix || !sessionIdOrPrefix.trim()) {
      return { success: false, error: 'Session ID or "latest" must be specified.' };
    }

    const trimmed = sessionIdOrPrefix.trim();
    let targetSession: SessionState | null = null;

    if (trimmed.toLowerCase() === 'latest' || trimmed === '-l') {
      targetSession = SessionStore.findLatestSession();
    } else {
      targetSession = SessionStore.getSession(trimmed);
    }

    if (!targetSession) {
      return { success: false, error: `Conversation session "${trimmed}" not found.` };
    }

    this.abort();
    this.isRunning = false;
    this.isExplorationPhase = true;
    this.activeSkillName = null;

    this.sessionState = targetSession;
    this.sessionState.maxTurns = this.getMaxTurns();

    const savedMessages = SessionStore.getMessages(targetSession.id);
    const fullSystemContent = this.buildFullSystemContent();

    if (savedMessages.length > 0) {
      this.messages = savedMessages;
      this.reconcileDanglingToolCalls();
      if (this.messages[0] && this.messages[0].role === 'system') {
        this.messages[0].content = fullSystemContent;
      } else {
        this.messages.unshift({
          id: randomUUID(),
          role: 'system',
          content: fullSystemContent,
          timestamp: Date.now(),
        });
      }
    } else {
      const freshSystemMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'system',
        content: fullSystemContent,
        timestamp: Date.now(),
      };
      this.messages = [freshSystemMsg];
      SessionStore.appendMessage(targetSession.id, freshSystemMsg);
    }

    this.currentContextTokens = TokenCounter.estimateMessagesTokens(this.messages);
    this.emit('session_switched', targetSession);
    return { success: true, session: targetSession };
  }

  updateSessionModel(provider: string, model: string): void {
    const KNOWN_PROVIDERS = ['openai', 'anthropic', 'google', 'gemini', 'deepseek', 'ollama'];
    let effectiveProvider = provider;
    let effectiveModel = model;

    // Self-healing: if provider and model were swapped
    if (KNOWN_PROVIDERS.includes(model.toLowerCase()) && !KNOWN_PROVIDERS.includes(provider.toLowerCase())) {
      effectiveProvider = model.toLowerCase() === 'gemini' ? 'google' : model.toLowerCase();
      effectiveModel = provider;
    }

    this.sessionConfig.provider = effectiveProvider;
    this.sessionConfig.model = effectiveModel;
    this.sessionState.provider = effectiveProvider;
    this.sessionState.model = effectiveModel;
    SessionStore.updateModel(this.sessionState.id, effectiveProvider, effectiveModel);
  }

  updateMaxTurns(maxTurns: number): void {
    this.sessionConfig.maxTurns = maxTurns;
    if (this.sessionState) {
      this.sessionState.maxTurns = maxTurns;
    }
  }

  getMaxTurns(): number {
    if (this.sessionConfig.maxTurns !== undefined) {
      return this.sessionConfig.maxTurns;
    }
    if (this.sessionState?.maxTurns !== undefined) {
      return this.sessionState.maxTurns;
    }
    return config.maxTurns !== undefined ? config.maxTurns : 100;
  }

  appendSyntheticMessage(msg: UnifiedMessage): void {
    this.messages.push(msg);
    SessionStore.appendMessage(this.sessionState.id, msg);
    this.currentContextTokens = TokenCounter.estimateMessagesTokens(this.messages);
    this.emit('message', msg);
  }

  /**
   * Aborts the in-flight agent processing loop gracefully.
   */
  abort(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort();
    }
  }

  /**
   * Returns whether the agent is actively executing a task.
   */
  public getIsRunning(): boolean {
    return this.isRunning;
  }


  /**
   * Sanitizes and formats raw provider errors into clear, concise, actionable messages.
   * Strips lengthy JSON error payloads, URLs, and stack traces to avoid terminal viewport overflow.
   */
  public formatProviderError(rawError: string): string {
    const errorStr = String(rawError || 'Unknown provider error');
    const lower = errorStr.toLowerCase();
    const prov = (this.sessionConfig.provider || '').toLowerCase();

    // 1. Quota / Rate limit (429) / Insufficient Quota
    if (
      errorStr.includes('429') ||
      lower.includes('quota') ||
      lower.includes('rate limit') ||
      lower.includes('resource_exhausted') ||
      lower.includes('insufficient_quota')
    ) {
      // 1a. Google Gemini Quota / Rate Limit (TPM / RPM)
      if (prov === 'google' || prov === 'gemini') {
        const retryMatch = errorStr.match(/Please retry in ([^.\n\r]+)/i) || errorStr.match(/retry in ([0-9.]+[a-zA-Z]*)/i);
        const retryInfo = retryMatch ? ` (Thoi gian cho retry: ${retryMatch[1].trim()})` : '';
        const approxK = Math.max(1, Math.round(this.sessionState.totalInputTokens / 1000));
        return [
          `[Google Gemini Rate Limit / Quota Exceeded (429)]: Model '${this.sessionConfig.model}' bi vuot nguong quota/rate limit${retryInfo}.`,
          `Nguyen nhan: Context phien hien tai (~${approxK}k tokens) da vuot gioi han Tokens Per Minute (TPM) cua Google AI Studio.`,
          'Giai phap de tiep tuc ngay:',
          '  1. Thu gon context ngay: /compact',
          '  2. Chuyen sang gateway 9Router (khong gioi han TPM): /model ag/gemini-3.8-flash-high',
          '  3. Hoac chuyen sang model khac: /model deepseek-chat hoac /model gpt-4o',
          'Kiem tra trang thai key: /key test google',
        ].join('\n');
      }

      // 1b. OpenAI Insufficient Quota ($0 Balance) or Rate Limit
      if (prov === 'openai') {
        const isProxy = (process.env.OPENAI_BASE_URL || '').includes('localhost:20128');
        if (isProxy) {
          return [
            `[9Router Gateway Error (429)]: Yeu cau qua gateway 9Router tai ${process.env.OPENAI_BASE_URL} gap loi quota hoac credentials.`,
            'Nguyen nhan: Provider tren 9Router chua duoc ket noi credentials hoac phien bi het han.',
            'Giai phap: Mo http://localhost:20128 de kiem tra Providers -> Antigravity, hoac chuyen model: /model ag/gemini-3.8-flash-high',
          ].join('\n');
        }
        return [
          `[OpenAI Quota Exceeded (429)]: Tai khoan OpenAI chua co so du (Credit Balance = $0.00).`,
          'OpenAI yeu cau nap credit toi thieu $5 tai: https://platform.openai.com/account/billing',
          'Goi y: Ban co the dung DeepSeek, Gemini, hoac gateway 9Router mien phi bang lenh: /model <ten_model>.',
          'Kiem tra trang thai key truc tiep: /key test openai',
        ].join('\n');
      }

      // 1c. DeepSeek
      if (prov === 'deepseek') {
        return `[DeepSeek Quota Exceeded (429)]: Tai khoan DeepSeek da het so du hoac bi gioi han rate limit.\nVui long kiem tra tai https://platform.deepseek.com hoac chuyen model bang /model.`;
      }

      // 1d. Anthropic
      if (prov === 'anthropic') {
        return `[Anthropic Rate Limit (429)]: Vuot qua gioi han rate limit cua Claude.\nVui long thu lai sau vai giay hoac chuyen model bang /model.`;
      }

      // 1e. Fallback
      const retryMatch = errorStr.match(/Please retry in ([^.\n\r]+)/i);
      const retryInfo = retryMatch ? ` (Thoi gian cho retry: ${retryMatch[1].trim()})` : '';
      return `[Quota Exceeded (429)]: Ban da vuot qua quota cho model '${this.sessionConfig.model}'${retryInfo}.\nGoi y: Chuyen sang model khac bang lenh /model (vi du: /model gemini-3.8-flash hoac /model deepseek-chat).`;
    }

    // 2. Model Not Found / Retired (404)
    if (errorStr.includes('404') || lower.includes('not found') || lower.includes('no longer available')) {
      return `[Model Unavailable (404)]: Model '${this.sessionConfig.model}' is unavailable or has been deprecated.\nSuggestion: Use /model to switch to a supported model (e.g. /model gemini-3.8-flash or /model gpt-4o).`;
    }


    // 3. Authentication (401 / 403)
    if (errorStr.includes('401') || errorStr.includes('403') || lower.includes('api key') || lower.includes('unauthorized')) {
      return `[Authentication Error]: API key for '${this.sessionConfig.provider}' is missing or invalid.\nSuggestion: Set your API key in .env or run /setup.`;
    }

    // 4. Network / Connection errors
    if (lower.includes('econnrefused') || lower.includes('fetch failed') || lower.includes('timeout') || lower.includes('etimedout')) {
      return `[Network Error]: Connection to '${this.sessionConfig.provider}' timed out or failed.\nSuggestion: Please check your network connection or try again.`;
    }

    // 5. Generic errors: Strip trailing raw JSON arrays/objects and lengthy URLs
    let clean = errorStr
      .replace(/\s*\[\s*\{.*$/s, '')
      .replace(/\s*\{\s*".*$/s, '')
      .replace(/https:\/\/[^\s)]+/g, (url) => url.split('?')[0])
      .trim();

    const lines = clean.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    const compact = lines.slice(0, 3).join('\n');
    return compact.length > 300 ? `${compact.slice(0, 297)}...` : compact;
  }

  getPermissionEngine(): PermissionEngine {
    return this.permissionEngine;
  }

  setPermissionMode(mode: SessionConfig['permissionMode']): void {
    this.sessionConfig.permissionMode = mode;
    this.sessionState.permissionMode = mode;
    this.permissionEngine.setMode(mode);
  }

  requestConfirmation(prompt: string, details?: PermissionRequestDetails): Promise<boolean> {
    if (this.sessionConfig.permissionMode === 'bypassPermissions') {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const id = randomUUID();
      const toolName = details?.toolName || 'unknown_tool';
      const args = details?.args || {};
      const reason = details?.reason || prompt;

      const respond = (approved: boolean, remember?: boolean) => {
        if (remember && approved) {
          this.permissionEngine.addAllowRule(`${toolName}(*)`);
        }
        resolve(approved);
      };

      const req: PermissionRequest = {
        id,
        toolName,
        args,
        reason,
        respond,
      };

      this.emit('permission_request', req);
    });
  }

  requestUserQuestion(question: string, options?: string[], allowCustomInput = true): Promise<string> {
    return new Promise<string>((resolve) => {
      const id = randomUUID();
      const req: UserQuestionRequest = {
        id,
        question,
        options,
        allowCustomInput,
        respond: (answer: string) => {
          resolve(answer);
        },
      };
      this.emit('ask_question', req);
    });
  }

  private isTransientError(err: string): boolean {
    const lower = err.toLowerCase();
    return (
      lower.includes('429') ||
      lower.includes('rate_limit') ||
      lower.includes('quota') ||
      lower.includes('500') ||
      lower.includes('502') ||
      lower.includes('503') ||
      lower.includes('529') ||
      lower.includes('overloaded') ||
      lower.includes('econnreset') ||
      lower.includes('etimedout') ||
      lower.includes('fetch failed') ||
      lower.includes('socket hang up') ||
      lower.includes('network timeout') ||
      lower.includes('network error') ||
      lower.includes('connection error') ||
      lower.includes('premature close') ||
      lower.includes('stream closed') ||
      lower.includes('stream ended') ||
      lower.includes('aborted') ||
      lower.includes('terminated')
    );
  }

  private recordUsageUpdate(
    inputTokens: number,
    outputTokens: number,
    model: string,
    cacheReadTokens?: number
  ): void {
    this.currentContextTokens = inputTokens;
    this.sessionState.totalInputTokens += inputTokens;
    this.sessionState.totalOutputTokens += outputTokens;
    if (cacheReadTokens) {
      this.sessionState.totalCachedTokens = (this.sessionState.totalCachedTokens || 0) + cacheReadTokens;
    }
    const costDelta = calculateModelCost(inputTokens, outputTokens, model);
    this.sessionState.totalCostUsd += costDelta;
    SessionStore.updateUsage(this.sessionState.id, inputTokens, outputTokens, costDelta);
    this.emit('usage', this.sessionState.totalInputTokens, this.sessionState.totalOutputTokens);
  }

  private async attemptStreamChat(
    provider: BaseProvider,
    model: string,
    thinkingBudget?: number
  ): Promise<{
    assistantContent: string;
    assistantThought: string;
    pendingToolCalls: ToolCall[];
    turnInputTokens: number;
    turnOutputTokens: number;
    turnReportedUsage: boolean;
    turnFinishReason: string;
    streamError: string | null;
  }> {
    let assistantContent = '';
    let assistantThought = '';
    let streamError: string | null = null;
    let turnFinishReason = 'end_turn';
    const pendingToolCalls: ToolCall[] = [];
    let turnInputTokens = 0;
    let turnOutputTokens = 0;
    let turnReportedUsage = false;

    try {
      const stream = provider.streamChat({
        model,
        systemPrompt: this.messages[0].content,
        messages: this.messages.slice(1),
        tools: this.toolRegistry.getActiveTools(),
        temperature: this.sessionConfig.temperature,
        thinkingBudget,
        maxTokens: this.sessionConfig.maxTokens || 16384,
        signal: this.abortController?.signal,
      });

      for await (const event of stream) {
        if (event.type === 'text_delta') {
          assistantContent += event.delta;
          this.emit('text', event.delta);
          const echoCheck = RepetitionGuard.isTextRepetitionDominated(assistantContent);
          if (echoCheck.isEchoing) {
            this.emit('verification', `[Repetition Guard]: Generative stream repetition detected. Halting runaway echo.`);
            break;
          }
        } else if (event.type === 'thought_delta') {
          assistantThought += event.delta;
          this.emit('thought', event.delta);
        } else if (event.type === 'tool_call_start') {
          this.emit('tool_start', event.name, event.id);
        } else if (event.type === 'tool_call_done') {
          pendingToolCalls.push(event.toolCall);
        } else if (event.type === 'finish') {
          turnFinishReason = event.reason;
        } else if (event.type === 'usage') {
          turnReportedUsage = true;
          turnInputTokens += event.inputTokens;
          turnOutputTokens += event.outputTokens;
          this.recordUsageUpdate(event.inputTokens, event.outputTokens, model, event.cacheReadTokens);
        } else if (event.type === 'error') {
          streamError = (event as { error?: { message?: string } }).error?.message || 'Provider request failed';
          break;
        }
      }
    } catch (err: unknown) {
      streamError = err instanceof Error ? err.message : String(err);
    }

    return {
      assistantContent,
      assistantThought,
      pendingToolCalls,
      turnInputTokens,
      turnOutputTokens,
      turnReportedUsage,
      turnFinishReason,
      streamError,
    };
  }

  private trySwitchFallbackProvider(currentError: string): { provider: BaseProvider; model: string } | null {
    // If user is intentionally connected to a local proxy (like 9Router),
    // do not hijack the connection to a cloud provider with strict rate limits.
    const isCustomProxy = (process.env.OPENAI_BASE_URL || '').includes('20128') ||
                          (process.env.OPENAI_BASE_URL || '').includes('localhost') ||
                          (process.env.OPENAI_BASE_URL || '').includes('127.0.0.1');
    if (this.sessionConfig.provider === 'openai' && isCustomProxy) {
      return null;
    }

    ModelRouter.markProviderFailure(this.sessionConfig.provider);
    const fallback = ModelRouter.getActiveFallback(this.sessionConfig.provider, [
      { model: 'gemini-2.5-flash', provider: 'gemini' },
      { model: 'gpt-4o', provider: 'openai' },
      { model: 'deepseek-chat', provider: 'deepseek' },
    ]);

    if (!fallback || fallback.provider === this.sessionConfig.provider) {
      return null;
    }

    const conn = ConnectionRegistry.findByProvider(fallback.provider);
    const key = conn ? ConnectionRegistry.resolveApiKey(conn) : null;
    if (!key || key.trim().length === 0) {
      return null;
    }

    this.emit('verification', `[Provider Failover]: Switched to fallback '${fallback.provider}' (${fallback.model}) due to "${currentError}".`);
    this.sessionConfig.provider = fallback.provider;
    this.sessionConfig.model = fallback.model;
    return ProviderFactory.create(fallback.provider, fallback.model);
  }

  private async executeStreamWithRetry(
    provider: BaseProvider,
    model: string,
    thinkingBudget?: number
  ): Promise<{
    assistantContent: string;
    assistantThought: string;
    pendingToolCalls: ToolCall[];
    turnInputTokens: number;
    turnOutputTokens: number;
    turnReportedUsage: boolean;
    turnFinishReason: string;
    streamError: string | null;
  }> {
    let activeProvider = provider;
    let activeModel = model;
    let attempt = 0;
    const maxRetries = 3;

    while (attempt < maxRetries) {
      attempt++;
      const result = await this.attemptStreamChat(activeProvider, activeModel, thinkingBudget);
      if (!result.streamError || this.abortController?.signal.aborted) {
        return result;
      }

      if (this.isTransientError(result.streamError) && attempt < maxRetries) {
        const backoffMs = Math.min(3000, 1000 * Math.pow(2, attempt - 1));
        this.emit('verification', `Transient error: "${result.streamError}". Retrying (${attempt}/${maxRetries}) in ${backoffMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }

      const failover = this.trySwitchFallbackProvider(result.streamError);
      if (failover) {
        activeProvider = failover.provider;
        activeModel = failover.model;
        continue;
      }

      return result;
    }

    return {
      assistantContent: '',
      assistantThought: '',
      pendingToolCalls: [],
      turnInputTokens: 0,
      turnOutputTokens: 0,
      turnReportedUsage: false,
      turnFinishReason: 'end_turn',
      streamError: 'Max retry attempts exhausted',
    };
  }

  /**
   * Main Agentic Conversation Loop with Observation Pruning and Verification Gating
   */
  async executeUserPrompt(userPrompt: string): Promise<string> {
    if (this.isRunning) {
      throw new Error('QueryEngine is already busy processing a request.');
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    try {
      // 1. Detect and persist developer habits or styling preferences
      DeveloperHabitService.detectAndPersistHabit(userPrompt, this.getProjectId(), this.sessionState.id);

      // 2. Resolve inline context shortcuts (@diff, @git, @memories, @file:<path>)
      const resolved = ContextProviderResolver.resolve(userPrompt, this.sessionConfig.cwd, this.getProjectId());
      let effectivePrompt = resolved.cleanedPrompt;
      if (resolved.injectedContext) {
        effectivePrompt = `${effectivePrompt}\n\n[INJECTED CONTEXT SHORTCUTS (${resolved.appliedShortcuts.join(', ')})]:\n${resolved.injectedContext}`;
        this.emit('verification', `[Context Shortcuts]: Injected ${resolved.appliedShortcuts.join(', ')}`);
      }

      if (!this.activeSkillName) {
        const matched = this.skillRegistry.matchSkillsByIntent(effectivePrompt, 1);
        if (matched.length > 0) {
          this.activeSkillName = matched[0].name;
        }
      }

      this.reconcileDanglingToolCalls();
      this.refreshSystemPrompt(effectivePrompt);
      this.verifyOnStopGuard.reset();
      this.repetitionGuard.reset();
      this.turnModifiedFiles.clear();
      this.turnLastModTimestamp = 0;

      const isSurgicalTask = QueryEngine.isSurgicalFixOrTargetedPrompt(effectivePrompt);
      if (isSurgicalTask) {
        this.isExplorationPhase = false;
      }

      // Auto-transition out of Plan Mode when an explicit human coding/execution directive is given
      if (
        this.sessionConfig.permissionMode === 'plan' &&
        !effectivePrompt.trim().startsWith('[') &&
        QueryEngine.isExecutionDirective(effectivePrompt)
      ) {
        this.setPermissionMode('default');
        this.emit(
          'verification',
          '[Plan Mode Auto-Transition]: Transitioned from Plan Mode to Execution Mode to apply requested code changes.'
        );
      }

      const userMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'user',
        content: effectivePrompt,
        timestamp: Date.now(),
      };
      this.messages.push(userMsg);
      SessionStore.appendMessage(this.sessionState.id, userMsg);
      this.currentContextTokens = TokenCounter.estimateMessagesTokens(this.messages);
      this.emit('user_message', userMsg);


      // 1. Pre-flight Provider Credential Check
      const activeConnection =
        ConnectionRegistry.findByProvider(this.sessionConfig.provider) ||
        ConnectionRegistry.getDefault();
      const resolvedApiKey = ConnectionRegistry.resolveApiKey(activeConnection);

      if (activeConnection.apiKeyEnv && (!resolvedApiKey || resolvedApiKey.trim().length === 0)) {
        const guidance = [
          `[Authentication Required]: No API key is configured for provider '${activeConnection.providerId}' (model: '${this.sessionConfig.model}').`,
          '',
          `To begin coding with ${activeConnection.providerId}, please configure your API key:`,
          `  1. Set ${activeConnection.apiKeyEnv}=your_api_key in your .env or shell environment.`,
          `  2. Or run the onboarding setup wizard via: /setup`,
          `  3. Or switch to a local or alternative provider: /model (e.g. ollama, deepseek, or gemini)`,
        ].join('\n');

        const noticeMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: guidance,
          timestamp: Date.now(),
        };
        this.messages.push(noticeMsg);
        SessionStore.appendMessage(this.sessionState.id, noticeMsg);
        this.emit('done', guidance);
        return guidance;
      }

      let finalAssistantResponse = '';
      let turnCount = 0;
      let consecutiveExploratoryTurns = 0;
      let completedNaturally = false;
      let lastToolTurnHadError = false;
      this.continuationGuard.resetConsecutive();
      const maxTurns = this.getMaxTurns();

      while (maxTurns <= 0 || turnCount < maxTurns) {
        if (this.abortController?.signal.aborted) {
          finalAssistantResponse = finalAssistantResponse
            ? `${finalAssistantResponse}\n\n[Cancelled by user]`
            : '[Request cancelled by user]';
          break;
        }

        turnCount++;
        const effectiveMaxTokens = this.getEffectiveMaxContextTokens();

        // 2. Observation Pruning: Evict old verbose tool outputs with AST skeletons
        const pruneResult = ObservationPruner.pruneToolObservations(
          this.messages,
          effectiveMaxTokens
        );
        if (pruneResult.pruned) {
          this.messages = pruneResult.messages;
          this.currentContextTokens = TokenCounter.estimateMessagesTokens(this.messages);
          this.emit('prune');
        }

        const activePlan = PlanManager.getActivePlan(this.sessionState.id);
        const planSummaryStr = activePlan
          ? `${activePlan.title}:\n${activePlan.steps.map((s) => `- [${s.status || 'pending'}] ${s.title}`).join('\n')}`
          : undefined;

        // 3. Multi-Tier Micro-Compaction & Trajectory Compression
        const compactionResult = this.contextMicroCompactor.optimize(
          this.messages,
          {
            activeTasksSummary: planSummaryStr,
            recentlyTouchedFiles: this.getSessionModifiedFiles(),
          }
        );
        if (compactionResult.wasCompacted) {
          this.messages = compactionResult.messages;
          this.currentContextTokens = compactionResult.newTokens;
          this.emit('compress');
        }

        // 4. Dual-Loop Model Selection (Fast Explorer vs Deep Reasoner)
        const effectiveModel = this.sessionConfig.enableDualLoop
          ? DualLoopExecutor.selectModelTier(this.isExplorationPhase, this.sessionConfig.model, isSurgicalTask)
          : this.sessionConfig.model;

        const { provider, model } = ProviderFactory.create(this.sessionConfig.provider, effectiveModel);

        // Dynamic thinking budget:
        // - In fast speed mode, thinking is 0 (immediate generation).
        // - In multi-step intermediate tool turns (turnCount > 1), clamp to 1024 tokens to eliminate idle thinking delay between tool steps.
        // - On initial turn (turnCount === 1), retain full thinking budget for deep architectural reasoning.
        let effectiveThinkingBudget = this.sessionConfig.thinkingBudget;
        if (this.sessionConfig.maxingMode) {
          // Maxing Mode: unconstrained deep deliberation across all turns (up to 32k)
          effectiveThinkingBudget = this.sessionConfig.maxingBudget || 16384;
        } else if (this.sessionConfig.speedMode === 'fast') {
          effectiveThinkingBudget = 0;
        } else if (turnCount > 1 && effectiveThinkingBudget && effectiveThinkingBudget > 1024) {
          effectiveThinkingBudget = 1024;
        }

        const streamResult = await this.executeStreamWithRetry(
          provider,
          model,
          effectiveThinkingBudget
        );

        let assistantContent = streamResult.assistantContent;
        const assistantThought = streamResult.assistantThought;
        let streamError = streamResult.streamError;
        const pendingToolCalls = streamResult.pendingToolCalls;
        const turnFinishReason = streamResult.turnFinishReason;
        const turnReportedUsage = streamResult.turnReportedUsage;
        const turnInputTokens = streamResult.turnInputTokens;
        const turnOutputTokens = streamResult.turnOutputTokens;

        if (!turnReportedUsage || (turnInputTokens === 0 && turnOutputTokens === 0)) {
          const estInput = TokenCounter.estimateMessagesTokens(this.messages);
          this.currentContextTokens = estInput;
          const estOutput =
            TokenCounter.estimateStringTokens(assistantContent) +
            TokenCounter.estimateStringTokens(assistantThought) +
            pendingToolCalls.reduce(
              (sum, tc) =>
                sum + 10 + TokenCounter.estimateStringTokens(tc.name) + TokenCounter.estimateStringTokens(JSON.stringify(tc.arguments)),
              0
            );

          if (estInput > 0 || estOutput > 0) {
            this.sessionState.totalInputTokens += estInput;
            this.sessionState.totalOutputTokens += estOutput;
            const costDelta = calculateModelCost(estInput, estOutput, model);
            this.sessionState.totalCostUsd += costDelta;
            SessionStore.updateUsage(this.sessionState.id, estInput, estOutput, costDelta);
            this.emit('usage', this.sessionState.totalInputTokens, this.sessionState.totalOutputTokens);
          }
        }

        if (streamError) {
          const formattedErr = this.formatProviderError(streamError);
          assistantContent = assistantContent
            ? `${assistantContent}\n\n[Warning: Stream interrupted - ${formattedErr}]`
            : formattedErr;
        } else if (!assistantContent && pendingToolCalls.length === 0) {
          if (assistantThought && assistantThought.trim().length > 0) {
            assistantContent = assistantThought;
          } else if (turnFinishReason === 'content_filter') {
            assistantContent = '[Notice]: The model response was blocked by upstream safety/content filters. Please adjust your prompt.';
          } else if (turnFinishReason === 'max_tokens') {
            assistantContent = '[Notice]: The model reached the max token limit before generating a completion. Try increasing maxTokens or asking a more focused question.';
          } else {
            assistantContent = '[Notice]: The model returned an empty response. Please verify your provider settings or prompt.';
          }
          this.emit('text', assistantContent);
        }

        const assistantMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: assistantContent,
          toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
          thought: assistantThought || undefined,
          timestamp: Date.now(),
        };
        this.messages.push(assistantMsg);
        SessionStore.appendMessage(this.sessionState.id, assistantMsg);
        this.currentContextTokens = TokenCounter.estimateMessagesTokens(this.messages);

        finalAssistantResponse = assistantContent;

        if (this.abortController?.signal.aborted) {
          break;
        }

        if (streamError) {
          // If rate limit / quota exceeded and context tokens are large, auto-compact to unblock next turn
          if (this.messages.length > 3 && this.sessionState.totalInputTokens > 40000) {
            const comp = TrajectoryCompressor.compressIfNeeded(this.messages, 30000, 0.4);
            if (comp.compressed) {
              this.messages = comp.messages;
              this.emit('compress');
            }
          }
          break;
        }

        // If no tool calls -> Check continuation guard, verification gate & Proof Mode before declaring complete
        if (pendingToolCalls.length === 0) {
          const continuationDecision = this.continuationGuard.evaluateTurn({
            assistantContent,
            finishReason: turnFinishReason,
            pendingToolCallsCount: pendingToolCalls.length,
            lastToolTurnHadError,
            modifiedFilesCount: this.turnModifiedFiles.size,
            isProofModeActive: !!this.sessionConfig.proofMode,
            isPlanModeActive: this.sessionConfig.permissionMode === 'plan',
            permissionMode: this.sessionConfig.permissionMode,
            recentMessages: this.messages,
          });

          if (continuationDecision.shouldContinue && continuationDecision.nudgePrompt) {
            this.emit(
              'verification',
              `[Autonomous Continuation]: ${continuationDecision.reason} detected. Resuming agent loop...`
            );
            const autoContinuationMsg: UnifiedMessage = {
              id: randomUUID(),
              role: 'user',
              content: continuationDecision.nudgePrompt,
              timestamp: Date.now(),
            };
            this.messages.push(autoContinuationMsg);
            continue; // Self-healing continuation loop
          }

          // Verify-On-Stop Guard: Check if code files were modified in THIS turn without fresh verification (NEVER in Plan Mode)
          if (this.sessionConfig.permissionMode !== 'plan' && this.turnModifiedFiles.size > 0) {
            const verifyDecision = this.verifyOnStopGuard.evaluate(
              Array.from(this.turnModifiedFiles),
              this.turnLastModTimestamp
            );
            if (verifyDecision.shouldBlock && verifyDecision.nudgePrompt) {
              this.emit(
                'verification',
                `[Verify-On-Stop Guard]: ${verifyDecision.unverifiedFiles.length} modified code file(s) require automated verification. Nudging agent...`
              );
              const autoVerifyMsg: UnifiedMessage = {
                id: randomUUID(),
                role: 'user',
                content: verifyDecision.nudgePrompt,
                timestamp: Date.now(),
              };
              this.messages.push(autoVerifyMsg);
              continue; // Autonomous verification nudge
            }
          }

          const shouldVerifyTypecheck =
            (this.turnModifiedFiles.size > 0 && this.sessionConfig.permissionMode !== 'plan') ||
            this.sessionConfig.proofMode;

          if (shouldVerifyTypecheck) {
            const typecheck = VerificationGate.verifyTypeScript(this.sessionConfig.cwd);
            this.evidenceCollector.recordTypecheckResult(typecheck.passed ? 0 : 1);
            if (!typecheck.passed && typecheck.errorDetails) {
              this.emit('verification', `Verifying TypeScript build and resolving compiler diagnostics...`);
              const diagNotice = `The following TypeScript compiler errors were detected in the workspace. Please resolve them:\n${typecheck.errorDetails}`;
              const autoFeedbackMsg: UnifiedMessage = {
                id: randomUUID(),
                role: 'user',
                content: diagNotice,
                timestamp: Date.now(),
              };
              this.messages.push(autoFeedbackMsg);
              continue; // Self-healing loop
            } else if (typecheck.passed) {
              this.verifyOnStopGuard.recordVerification();
            }
          }

          // Mode Max: Invariant Boundary Fuzzing Shield
          if (
            this.sessionConfig.maxingMode &&
            this.turnModifiedFiles.size > 0 &&
            this.sessionConfig.permissionMode !== 'plan'
          ) {
            this.emit('verification', '[Mode Max Shield]: Running autonomous Invariant Boundary Fuzz Shield on modified functions...');
            const fuzzResult = await this.runMaxingInvariantFuzzShield(Array.from(this.turnModifiedFiles));
            if (!fuzzResult.passed && fuzzResult.defectNotice) {
              this.emit('verification', '[Mode Max Shield]: Invariant defect detected. Initiating autonomous repair loop...');
              const autoFuzzMsg: UnifiedMessage = {
                id: randomUUID(),
                role: 'user',
                content: fuzzResult.defectNotice,
                timestamp: Date.now(),
              };
              this.messages.push(autoFuzzMsg);
              continue; // Autonomous self-healing loop
            } else {
              this.emit('verification', '[Mode Max Shield]: Boundary invariant fuzz checks passed successfully.');
            }
          }

          if (this.sessionConfig.proofMode) {
            this.emit('verification', 'Proof Mode active: Running empirical 6-pillar verification...');
            const modifiedFiles = this.evidenceCollector.getModifiedFiles();
            const proofReport = await ProofEngine.verify(modifiedFiles, {
              cwd: this.sessionConfig.cwd,
            });

            if (!proofReport.overallPassed) {
              this.emit('verification', `Proof rejected (Score: ${proofReport.score}/100). Initiating autonomous repair loop...`);
              const failedChecks = proofReport.checks.filter((c) => !c.passed).map((c) => `- ${c.name}: ${c.message}`).join('\n');
              const repairNotice = `[PROOF MODE REPAIR REQUIRED]: Empirical verification did not pass (Score: ${proofReport.score}/100).\nFailed Checks:\n${failedChecks}\n\nPlease inspect the failures, correct the defects, and verify again.`;
              const autoRepairMsg: UnifiedMessage = {
                id: randomUUID(),
                role: 'user',
                content: repairNotice,
                timestamp: Date.now(),
              };
              this.messages.push(autoRepairMsg);
              continue; // Autonomous repair loop
            }

            this.emit('verification', `Proof verified (Score: ${proofReport.score}/100). All criteria satisfied.`);
            finalAssistantResponse = `${finalAssistantResponse}\n\n${proofReport.proofCard}`;
          }

          // Anti-Stubbing AST Guard: Ensure code was not written with superficial stubs or dummy returns
          if (this.sessionConfig.permissionMode !== 'plan' && this.turnModifiedFiles.size > 0) {
            const stubReport = AntiStubAstScanner.scanFiles(
              Array.from(this.turnModifiedFiles),
              this.sessionConfig.cwd
            );
            if (!stubReport.passed) {
              this.emit('verification', `[Anti-Stub Guard]: ${stubReport.findings.length} superficial stub/placeholder(s) detected. Nudging agent to implement complete logic...`);
              const stubNotice = `[ANTI-STUB GUARD VIOLATION]: Phát hiện mã nguồn viết qua loa, chứa mock/placeholder hoặc dummy return:\n` +
                stubReport.findings.map((f) => `- ${f.file}:${f.line} [${f.kind}]: ${f.message}`).join('\n') +
                `\n\nVui lòng loại bỏ các comment trốn tránh (TODO/placeholder/mock) và triển khai đầy đủ thuật toán nghiệp vụ thực tế.`;
              const autoStubMsg: UnifiedMessage = {
                id: randomUUID(),
                role: 'user',
                content: stubNotice,
                timestamp: Date.now(),
              };
              this.messages.push(autoStubMsg);
              continue; // Autonomous self-healing loop
            }
          }

          // Metric Provenance Guard: Ensure quantitative claims have empirical evidence in tool outputs
          if (this.sessionConfig.permissionMode !== 'plan' && assistantContent) {
            const metricCheck = MetricProvenanceValidator.evaluate(assistantContent, this.messages);
            if (!metricCheck.isValid && metricCheck.nudgePrompt) {
              this.emit(
                'verification',
                `[Metric Provenance Guard]: ${metricCheck.unprovenClaims.length} unproven metric claim(s) detected. Nudging agent to measure empirically...`
              );
              const autoMetricMsg: UnifiedMessage = {
                id: randomUUID(),
                role: 'user',
                content: metricCheck.nudgePrompt,
                timestamp: Date.now(),
              };
              this.messages.push(autoMetricMsg);
              continue; // Autonomous self-healing loop
            }
          }

          completedNaturally = true;
          break;
        }

        // 5. Execute Tool Calls with ParallelToolDispatcher
        const toolContext: ToolExecutionContext = {
          sessionId: this.sessionState.id,
          cwd: this.sessionConfig.cwd,
          permissionMode: this.sessionConfig.permissionMode,
          signal: this.abortController.signal,
          onProgress: (p: string) => this.emit('tool_progress', p),
          askConfirmation: (prompt: string, details?: PermissionRequestDetails) =>
            this.requestConfirmation(prompt, details),
          askQuestion: (question: string, options?: string[], allowCustomInput?: boolean) =>
            this.requestUserQuestion(question, options, allowCustomInput),
        };

        const hasMutatingTool = pendingToolCalls.some(
          (tc) => tc.name === 'file_edit' || tc.name === 'file_write' || tc.name === 'run_shell_command'
        );

        if (hasMutatingTool) {
          this.isExplorationPhase = false; // Transition to implementation phase
          consecutiveExploratoryTurns = 0;
        } else if (isSurgicalTask) {
          consecutiveExploratoryTurns++;
        }

        // Repetition Guard: Track tool signatures and detect cycles
        for (const tc of pendingToolCalls) {
          const repCheck = this.repetitionGuard.record(tc.name, tc.arguments as Record<string, unknown>);
          if (repCheck.isLooping && repCheck.interventionPrompt) {
            this.emit('verification', repCheck.interventionPrompt);
          }
        }

        const dispatchedResults = await ParallelToolDispatcher.dispatch(
          pendingToolCalls,
          this.toolRegistry,
          toolContext,
          this.hookEngine,
          (name, id, content, isError) => {
            this.emit('tool_done', name, id, content, isError);
          },
          this.permissionEngine
        );

        if (
          isSurgicalTask &&
          consecutiveExploratoryTurns >= MAX_CONSECUTIVE_EXPLORATORY_TURNS &&
          dispatchedResults.length > 0
        ) {
          const lastResult = dispatchedResults[dispatchedResults.length - 1];
          lastResult.resultContent = `${lastResult.resultContent}\n\n[Surgical Pinpoint Alert]: You have inspected sufficient context. Strictly cease further file searches or exploratory reads. Go directly to the root cause and apply the surgical modification with file_edit now.`;
        }

        lastToolTurnHadError = dispatchedResults.some((dr) => dr.isError);
        if (dispatchedResults.length > 0) {
          this.continuationGuard.resetConsecutive();
        }

        if (toolContext.permissionMode !== this.sessionConfig.permissionMode) {
          this.setPermissionMode(toolContext.permissionMode);
        }

        for (const dr of dispatchedResults) {
          if (!dr.isError && (dr.toolCall.name === 'file_edit' || dr.toolCall.name === 'file_write')) {
            const args = dr.toolCall.arguments as Record<string, unknown> | undefined;
            const targetPath = (args?.path || args?.filePath) as string | undefined;
            if (targetPath) {
              this.evidenceCollector.recordFileModification(targetPath);
              this.turnModifiedFiles.add(targetPath);
              this.turnLastModTimestamp = Date.now();
            }
          } else if (!dr.isError && dr.toolCall.name === 'run_shell_command') {
            const args = dr.toolCall.arguments as Record<string, unknown> | undefined;
            const cmd = ((args?.command || args?.cmd || '') as string).toLowerCase();
            const verificationKeywords = ['test', 'tsc', 'typecheck', 'lint', 'vitest', 'jest', 'pytest', 'cargo check', 'go test'];
            if (verificationKeywords.some((kw) => cmd.includes(kw))) {
              this.verifyOnStopGuard.recordVerification();
            }
          }

          const toolMsg: UnifiedMessage = {
            id: randomUUID(),
            role: 'tool',
            content: dr.resultContent,
            toolCallId: dr.toolCall.id,
            toolResult: {
              toolCallId: dr.toolCall.id,
              toolName: dr.toolCall.name,
              isError: dr.isError,
              content: dr.resultContent,
            },
            timestamp: Date.now(),
          };
          this.messages.push(toolMsg);
          SessionStore.appendMessage(this.sessionState.id, toolMsg);
        }
        this.currentContextTokens = TokenCounter.estimateMessagesTokens(this.messages);

        // Refresh system prompt dynamic block with latest confirmed modified files
        this.refreshSystemPrompt();
      }

      // If loop exited because turn limit was reached before the task finished naturally
      if (!completedNaturally && maxTurns > 0 && turnCount >= maxTurns) {
        const limitNotice = [
          `[Turn Limit Reached]: The agent completed ${turnCount} turns (maximum allowed: ${maxTurns}).`,
          `To continue, type 'continue' or adjust the limit: /turns <number> (use /turns unlimited or /turns 0 for continuous execution).`,
        ].join('\n');
        finalAssistantResponse = finalAssistantResponse
          ? `${finalAssistantResponse}\n\n${limitNotice}`
          : limitNotice;
        const noticeMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: limitNotice,
          timestamp: Date.now(),
        };
        this.messages.push(noticeMsg);
        SessionStore.appendMessage(this.sessionState.id, noticeMsg);
      }

      // Auto-sync plan if assistant formulated or revised a plan in natural language
      if (finalAssistantResponse) {
        const extracted = PlanManager.extractPlanFromText(finalAssistantResponse);
        if (extracted && extracted.steps.length >= 2) {
          const existingPlan = PlanManager.getActivePlan(this.sessionState.id);
          if (!existingPlan) {
            PlanManager.createOrReplacePlan(this.sessionState.id, {
              title: extracted.title || 'Architectural Implementation Plan',
              overview: extracted.overview,
              steps: extracted.steps,
              acceptanceCriteria: extracted.acceptanceCriteria,
            });
          } else {
            PlanManager.mergePlan(this.sessionState.id, {
              title: extracted.title || existingPlan.title,
              overview: extracted.overview || existingPlan.overview,
              steps: extracted.steps,
              acceptanceCriteria: extracted.acceptanceCriteria,
            });
          }
        }
      }

      // Auto-resolve any tasks left in in_progress if the prompt turn completed naturally
      try {
        const inProgressTasks = TaskManager.listTasks(this.sessionState.id).filter(
          (t) => t.status === 'in_progress'
        );
        for (const t of inProgressTasks) {
          TaskManager.updateTask(this.sessionState.id, t.id, { status: 'completed' });
        }
      } catch {
        // Non-blocking
      }

      this.emit('done', finalAssistantResponse);
      return finalAssistantResponse;
    } catch (err: unknown) {
      this.reconcileDanglingToolCalls();
      const error = err as Error;
      if (this.abortController?.signal.aborted || error.name === 'AbortError') {
        const cancelText = '[Request cancelled by user]';
        const cancelMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: cancelText,
          timestamp: Date.now(),
        };
        this.messages.push(cancelMsg);
        SessionStore.appendMessage(this.sessionState.id, cancelMsg);
        this.emit('done', cancelText);
        return cancelText;
      }
      this.emit('error', error);
      throw error;
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }

  }
}

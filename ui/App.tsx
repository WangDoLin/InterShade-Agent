import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Box, Static, useApp, useInput } from 'ink';
import { randomUUID } from 'crypto';

import { Header } from './components/Header.js';
import { StatusLine } from './components/StatusLine.js';
import { MessageView } from './components/MessageView.js';
import { ToolProgressBlock } from './components/ToolProgressBlock.js';
import { InteractivePrompt } from './components/InteractivePrompt.js';
import { PermissionPrompt } from './components/PermissionPrompt.js';
import { QuestionPrompt } from './components/QuestionPrompt.js';
import { TaskTrackerView } from './components/TaskTrackerView.js';
import { SessionTabBar } from './components/SessionTabBar.js';
import { MultiSessionPool, type SessionTab } from '../engine/swarm/MultiSessionPool.js';
import { HistoryInspectionView } from './components/HistoryInspectionView.js';
import { ReturnToBottomBar } from './components/ReturnToBottomBar.js';
import { SwarmDashboardView } from './components/SwarmDashboardView.js';
import { SwarmCoordinator } from '../engine/swarm/SwarmCoordinator.js';
import type { SwarmTask, SwarmProgressEvent, SwarmRole } from '../engine/swarm/SwarmTypes.js';
import { extractPromptTurns, truncatePromptText } from './utils/turnExtractor.js';
import { PlanManager } from '../state/PlanManager.js';
import { TaskManager } from '../state/TaskManager.js';
import { SessionStore } from '../state/SessionStore.js';
import type { TaskItem } from '../tasks/TaskGraph.js';
import type { QueryEngine } from '../orchestrator/QueryEngine.js';
import type { UnifiedMessage, PermissionRequest, UserQuestionRequest } from '../types/index.js';

import { i18n, t } from '../services/i18n/index.js';
import { SUPPORTED_LOCALES } from '../services/i18n/types.js';
import { CommandRegistry, registerBuiltinCommands } from '../cli/commands/index.js';
import { useTerminalViewport } from './hooks/useTerminalViewport.js';
import { useMultiSessionTabs } from './hooks/useMultiSessionTabs.js';
import { useQueryEngineBridge } from './hooks/useQueryEngineBridge.js';
import { formatSlashCommandHelp, formatResumeSessionList } from './services/slashCommandHelp.js';

const commandRegistry = new CommandRegistry();
registerBuiltinCommands(commandRegistry);

export interface AppProps {
  queryEngine: QueryEngine;
  initialPrompt?: string;
}

export const App: React.FC<AppProps> = ({ queryEngine, initialPrompt }) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<UnifiedMessage[]>(queryEngine.getMessages());
  const [sessionState, setSessionState] = useState(queryEngine.getSessionState());
  const [contextTokens, setContextTokens] = useState<number>(queryEngine.getContextTokens());
  const [currentToolName, setCurrentToolName] = useState<string | null>(null);
  const [progressText, setProgressText] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [queuedPrompt, setQueuedPrompt] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<UserQuestionRequest | null>(null);
  const [sessionTasks, setSessionTasks] = useState<TaskItem[]>(() =>
    TaskManager.listTasks(queryEngine.getSessionState().id)
  );
  const [viewingTurnIndex, setViewingTurnIndex] = useState<number | null>(null);
  const [swarmTasks, setSwarmTasks] = useState<SwarmTask[]>([]);
  const [swarmStatus, setSwarmStatus] = useState<SwarmProgressEvent['overallStatus'] | null>(null);

  const handleTabSwitched = useCallback((tab: SessionTab) => {
    setMessages([...tab.queryEngine.getMessages()]);
    setSessionState({ ...tab.queryEngine.getSessionState() });
    setContextTokens(tab.queryEngine.getContextTokens());
    setIsBusy(tab.status === 'running');
    setSessionTasks(TaskManager.listTasks(tab.queryEngine.getSessionState().id));
    setViewingTurnIndex(null);
  }, []);

  const { sessionTabs, activeTabId, activeEngine } = useMultiSessionTabs(queryEngine, handleTabSwitched);
  const { columns: terminalColumns, isCompact } = useTerminalViewport(isBusy);

  const promptTurns = useMemo(() => extractPromptTurns(messages), [messages]);

  const selectedTurn = useMemo(() => {
    if (viewingTurnIndex === null) return null;
    return promptTurns.find((turn) => turn.turnIndex === viewingTurnIndex) || null;
  }, [promptTurns, viewingTurnIndex]);

  const handleSelectTurn = useCallback((turnIndex: number) => {
    setViewingTurnIndex(turnIndex);
  }, []);

  const handleReturnToBottom = useCallback(() => {
    setViewingTurnIndex(null);
  }, []);

  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;
  const queuedPromptRef = useRef<string | null>(null);
  const handleUserSubmitRef = useRef<(p: string) => Promise<void>>(async () => {});
  const lastAbortTimeRef = useRef(0);

  const handleAbort = useCallback(() => {
    const now = Date.now();
    if (now - lastAbortTimeRef.current < 250) {
      return;
    }
    lastAbortTimeRef.current = now;

    const isRunning = isBusyRef.current || activeEngine.getIsRunning();

    if (isRunning) {
      if (queuedPromptRef.current) {
        queuedPromptRef.current = null;
        setQueuedPrompt(null);
      }
      if (pendingPermission) {
        pendingPermission.respond(false, false);
        setPendingPermission(null);
      }
      if (pendingQuestion) {
        pendingQuestion.respond('');
        setPendingQuestion(null);
      }

      setIsBusy(false);
      isBusyRef.current = false;
      setCurrentToolName(null);
      setProgressText(null);

      activeEngine.abort();

      setMessages([...activeEngine.getMessages()]);
      setContextTokens(activeEngine.getContextTokens());
    } else {
      exit();
    }
  }, [activeEngine, exit, pendingPermission, pendingQuestion]);

  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'C')) {
      handleAbort();
      return;
    }

    if (key.meta && /^[1-9]$/.test(input)) {
      const targetIndex = parseInt(input, 10);
      const pool = MultiSessionPool.getInstance();
      if (pool.getTabs().length > 1 && targetIndex <= pool.getTabs().length) {
        pool.switchActiveTab(targetIndex);
        return;
      }
      if (targetIndex <= promptTurns.length) {
        setViewingTurnIndex(targetIndex);
      }
    }
  });

  useEffect(() => {
    const onSigInt = () => {
      handleAbort();
    };
    process.on('SIGINT', onSigInt);
    return () => {
      process.off('SIGINT', onSigInt);
    };
  }, [handleAbort]);

  const handleClearQueue = useCallback(() => {
    queuedPromptRef.current = null;
    setQueuedPrompt(null);
  }, []);

  const handleError = useCallback((err?: unknown) => {
    setIsBusy(false);
    isBusyRef.current = false;
    if (queuedPromptRef.current) {
      queuedPromptRef.current = null;
      setQueuedPrompt(null);
    }
    setCurrentToolName(null);
    setProgressText(null);
    setPendingPermission(null);
    const currentMsgs = activeEngine.getMessages();
    const lastMsg = currentMsgs[currentMsgs.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.content) {
      const rawDetail = err instanceof Error ? err.message : String(err || 'Request failed');
      const cleanDetail = rawDetail.length > 250 ? `${rawDetail.slice(0, 247)}...` : rawDetail;
      const fallbackMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: `[Error]: ${cleanDetail}`,
        timestamp: Date.now(),
      };
      setMessages([...currentMsgs, fallbackMsg]);
      setContextTokens(activeEngine.getContextTokens());
    } else {
      setMessages([...currentMsgs]);
      setContextTokens(activeEngine.getContextTokens());
    }
  }, [activeEngine]);

  const initialPromptRanRef = useRef(false);
  useEffect(() => {
    if (initialPrompt && !initialPromptRanRef.current) {
      initialPromptRanRef.current = true;
      handleUserSubmitRef.current(initialPrompt);
    }
  }, [initialPrompt]);

  useQueryEngineBridge({
    activeEngine,
    isBusyRef,
    queuedPromptRef,
    handleUserSubmitRef,
    handleError,
    setIsBusy,
    setQueuedPrompt,
    setCurrentToolName,
    setProgressText,
    setPendingPermission,
    setPendingQuestion,
    setMessages,
    setSessionState,
    setContextTokens,
    setSessionTasks,
  });

  const handleUserSubmit = async (prompt: string) => {
    // 1. Exit / Quit (Emergency terminate)
    if (prompt === '/exit' || prompt === '/quit' || prompt === 'exit' || prompt === 'quit') {
      if (isBusyRef.current) {
        activeEngine.abort();
      }
      exit();
      return;
    }

    // 2. Unqueue / Clear Queue
    if (prompt === '/unqueue' || prompt === '/clear-queue' || prompt === '/dq' || prompt === 'unqueue') {
      if (queuedPromptRef.current) {
        queuedPromptRef.current = null;
        setQueuedPrompt(null);
        const noticeMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: '[Queue]: Cleared queued prompt.',
          timestamp: Date.now(),
        };
        activeEngine.appendSyntheticMessage(noticeMsg);
        setMessages([...activeEngine.getMessages()]);
      } else {
        const noticeMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: '[Queue]: No prompt is currently queued.',
          timestamp: Date.now(),
        };
        activeEngine.appendSyntheticMessage(noticeMsg);
        setMessages([...activeEngine.getMessages()]);
      }
      return;
    }

    // 3. Clear terminal screen
    if (prompt === '/clear' || prompt === 'clear') {
      activeEngine.clearMessages();
      setMessages([]);
      setContextTokens(activeEngine.getContextTokens());
      process.stdout.write('\x1b[2J\x1b[H\x1b[3J');
      return;
    }

    // 4. Session reset / delete commands
    if (
      prompt === '/new' ||
      prompt.startsWith('/new ') ||
      prompt === 'new' ||
      prompt.startsWith('new ') ||
      prompt === '/reset' ||
      prompt.startsWith('/reset ') ||
      prompt === '/delete' ||
      prompt.startsWith('/delete ') ||
      prompt === '/delete-session' ||
      prompt.startsWith('/delete-session ') ||
      prompt === '/drop' ||
      prompt.startsWith('/drop ')
    ) {
      const parts = prompt.split(' ');
      const cmdName = parts[0].toLowerCase();
      const args = parts.slice(1);
      const isDeleteRequested =
        cmdName === '/delete' ||
        cmdName === '/delete-session' ||
        cmdName === '/drop' ||
        args.includes('--delete') ||
        args.includes('-d');

      const oldSessionId = sessionState.id;
      const newSession = activeEngine.resetSession({ deleteCurrent: isDeleteRequested });
      TaskManager.clearAllTasks(oldSessionId);
      setSessionTasks([]);

      setMessages([]);
      setSessionState(newSession);
      setContextTokens(activeEngine.getContextTokens());
      setCurrentToolName(null);
      setProgressText(null);
      setPendingPermission(null);

      process.stdout.write('\x1b[2J\x1b[H\x1b[3J');

      const notice = isDeleteRequested
        ? t('slash.deletedSession', [oldSessionId.slice(0, 8), newSession.id.slice(0, 8)])
        : t('slash.newSession', [newSession.id.slice(0, 8)]);

      const noticeMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: notice,
        timestamp: Date.now(),
      };
      setMessages([noticeMsg]);
      return;
    }

    // 4b. Session resume / switch commands
    if (
      prompt === '/resume' ||
      prompt.startsWith('/resume ') ||
      prompt === 'resume' ||
      prompt.startsWith('resume ') ||
      prompt === '/switch' ||
      prompt.startsWith('/switch ') ||
      prompt === 'switch' ||
      prompt.startsWith('switch ') ||
      prompt === '/load' ||
      prompt.startsWith('/load ')
    ) {
      const parts = prompt.trim().split(/\s+/);
      const targetArg = parts[1];

      if (!targetArg) {
        const sessions = SessionStore.listSessions(6);
        const infoMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: formatResumeSessionList(sessions, sessionState.id),
          timestamp: Date.now() + 1,
        };
        activeEngine.appendSyntheticMessage(infoMsg);
        setMessages([...activeEngine.getMessages()]);
        return;
      }

      const res = activeEngine.switchSession(targetArg);
      if (!res.success || !res.session) {
        const errorMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: `Failed to resume session: ${res.error || 'Unknown error'}\nRun "/resume" or "/sessions" to see all available conversations.`,
          timestamp: Date.now() + 1,
        };
        activeEngine.appendSyntheticMessage(errorMsg);
        setMessages([...activeEngine.getMessages()]);
        return;
      }

      const resumed = res.session;
      TaskManager.clearAllTasks(sessionState.id);
      setSessionTasks(TaskManager.listTasks(resumed.id));

      setSessionState({ ...resumed });
      setMessages([...activeEngine.getMessages()]);
      setContextTokens(activeEngine.getContextTokens());
      setCurrentToolName(null);
      setProgressText(null);
      setPendingPermission(null);

      process.stdout.write('\x1b[2J\x1b[H\x1b[3J');

      const totalTokens = resumed.totalInputTokens + resumed.totalOutputTokens;
      const noticeMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: `[RESUMED]: Switched to conversation ${resumed.id.slice(0, 8)}...\nModel: ${resumed.model} (${resumed.provider})\nRestored Messages: ${activeEngine.getMessages().length}\nTokens: ${totalTokens.toLocaleString()} | Cost: $${resumed.totalCostUsd.toFixed(4)} USD`,
        timestamp: Date.now() + 1,
      };
      setMessages([noticeMsg]);
      return;
    }

    // 5. Language switch
    if (prompt.startsWith('/lang') || prompt.startsWith('lang ')) {
      const userCmdMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
      };
      activeEngine.appendSyntheticMessage(userCmdMsg);

      const parts = prompt.split(' ');
      const targetLang = parts[1];
      if (!targetLang) {
        const current = i18n.getLocale();
        const infoMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: `${t('header.lang')}: ${current}. Available: ${SUPPORTED_LOCALES.join(', ')}`,
          timestamp: Date.now() + 1,
        };
        activeEngine.appendSyntheticMessage(infoMsg);
        setMessages([...activeEngine.getMessages()]);
        return;
      }

      const success = i18n.setLocale(targetLang);
      const noticeText = success
        ? t('slash.langChanged', [i18n.getLocale()])
        : t('slash.langInvalid', [targetLang, SUPPORTED_LOCALES.join(', ')]);

      const noticeMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: noticeText,
        timestamp: Date.now() + 1,
      };
      activeEngine.appendSyntheticMessage(noticeMsg);
      setMessages([...activeEngine.getMessages()]);
      setSessionState({ ...activeEngine.getSessionState() });
      setContextTokens(activeEngine.getContextTokens());
      return;
    }

    // 6. Plan Mode toggle / inspection
    if (prompt === '/plan' || prompt.startsWith('/plan ') || prompt === 'plan' || prompt.startsWith('plan ')) {
      const userCmdMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
      };
      activeEngine.appendSyntheticMessage(userCmdMsg);

      const targetPath = prompt.replace(/^(\/)?plan\s*/i, '').trim();
      const sub = targetPath.toLowerCase();

      if (sub === 'view' || sub === 'show') {
        const plan = PlanManager.getActivePlan(sessionState.id);
        const content = plan
          ? PlanManager.formatPlanMarkdown(plan, { showChangelog: true })
          : '[PLAN NOTICE]: No active plan has been established for this session yet. Type your planning request or /plan to start.';
        const planMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content,
          timestamp: Date.now() + 1,
        };
        activeEngine.appendSyntheticMessage(planMsg);
        setMessages([...activeEngine.getMessages()]);
        return;
      }

      if (sub === 'reset' || sub === 'clear') {
        PlanManager.clearPlan(sessionState.id);
        const resetMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: '[PLAN RESET]: Active plan cleared from session memory. Ready to establish a new plan.',
          timestamp: Date.now() + 1,
        };
        activeEngine.appendSyntheticMessage(resetMsg);
        setMessages([...activeEngine.getMessages()]);
        return;
      }

      if (sub === 'on') {
        activeEngine.setPermissionMode('plan');
        setSessionState((prev) => ({ ...prev, permissionMode: 'plan' }));
        const noticeMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: t('slash.planModeOn'),
          timestamp: Date.now() + 1,
        };
        activeEngine.appendSyntheticMessage(noticeMsg);
        setMessages([...activeEngine.getMessages()]);
        return;
      }

      if (sub === 'off') {
        activeEngine.setPermissionMode('default');
        setSessionState((prev) => ({ ...prev, permissionMode: 'default' }));
        const noticeMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: t('slash.planModeOff'),
          timestamp: Date.now() + 1,
        };
        activeEngine.appendSyntheticMessage(noticeMsg);
        setMessages([...activeEngine.getMessages()]);
        return;
      }

      if (!targetPath) {
        const currentMode = sessionState.permissionMode;
        const nextMode = currentMode === 'plan' ? 'default' : 'plan';
        activeEngine.setPermissionMode(nextMode);
        setSessionState((prev) => ({ ...prev, permissionMode: nextMode }));
        const noticeMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: nextMode === 'plan' ? t('slash.planModeOn') : t('slash.planModeOff'),
          timestamp: Date.now() + 1,
        };
        activeEngine.appendSyntheticMessage(noticeMsg);
        setMessages([...activeEngine.getMessages()]);
        return;
      }

      activeEngine.setPermissionMode('plan');
      setSessionState((prev) => ({ ...prev, permissionMode: 'plan' }));

      if (isBusyRef.current) {
        const trimmed = prompt.trim();
        if (trimmed) {
          queuedPromptRef.current = trimmed;
          setQueuedPrompt(trimmed);
        }
        return;
      }

      const activePlan = PlanManager.getActivePlan(sessionState.id);
      const planContext = activePlan
        ? `Note: An existing plan "${activePlan.title}" exists. Formulate a comprehensive plan for the new objective.\n`
        : '';
      const planningPrompt = `[Plan Mode Active - Read-Only Architectural Planning]\nObjective: ${targetPath}\n${planContext}\nPlease investigate requirements and codebase (using read-only tools if needed), and formulate a comprehensive, step-by-step architectural plan to achieve this objective.`;

      if (process.stdout.isTTY) {
        try {
          const shortPrompt = truncatePromptText(prompt, 35);
          process.stdout.write(`\x1b]0;InterShader [Turn #${promptTurns.length + 1}]: ${shortPrompt}\x07`);
        } catch {
          // Ignore if stdout is closed
        }
      }

      setIsBusy(true);
      isBusyRef.current = true;
      try {
        await activeEngine.executeUserPrompt(planningPrompt);
      } catch (err: unknown) {
        handleError(err);
      } finally {
        setIsBusy(false);
        isBusyRef.current = false;
        setCurrentToolName(null);
        setProgressText(null);
      }
      return;
    }

    // 7. Check CommandRegistry for registered slash commands (PromptCommand, LocalCommand)
    const parsedCmd = commandRegistry.parseInput(prompt);
    if (parsedCmd) {
      const cmd = commandRegistry.get(parsedCmd.commandName);
      if (cmd) {
        if (cmd.type === 'local') {
          const userCmdMsg: UnifiedMessage = {
            id: randomUUID(),
            role: 'user',
            content: prompt,
            timestamp: Date.now(),
          };
          activeEngine.appendSyntheticMessage(userCmdMsg);

          const pool = MultiSessionPool.getInstance();
          const currentTab = pool.getActiveTab();
          const targetEngine = currentTab ? currentTab.queryEngine : activeEngine;

          const cmdCtx = {
            cwd: sessionState.cwd,
            sessionState: {
              ...sessionState,
              maxTurns: targetEngine.getMaxTurns(),
            } as unknown as Record<string, unknown>,
            args: parsedCmd.args,
          };

          const res = await cmd.execute(cmdCtx);

          const updatedTab = pool.getActiveTab();
          const finalEngine = updatedTab ? updatedTab.queryEngine : activeEngine;

          const localMsg: UnifiedMessage = {
            id: randomUUID(),
            role: 'assistant',
            content: res,
            timestamp: Date.now() + 1,
          };
          finalEngine.appendSyntheticMessage(localMsg);
          setMessages([...finalEngine.getMessages()]);

          const updatedState = { ...sessionState, ...(cmdCtx.sessionState as unknown as typeof sessionState) };
          if ((cmdCtx.sessionState as Record<string, unknown>).maxTurns !== undefined) {
            const newMaxTurns = (cmdCtx.sessionState as Record<string, unknown>).maxTurns as number;
            finalEngine.updateMaxTurns(newMaxTurns);
            activeEngine.updateMaxTurns(newMaxTurns);
            updatedState.maxTurns = newMaxTurns;
          }
          if ((cmdCtx.sessionState as Record<string, unknown>).maxingMode !== undefined) {
            const newMaxing = Boolean((cmdCtx.sessionState as Record<string, unknown>).maxingMode);
            const budget = (cmdCtx.sessionState as Record<string, unknown>).thinkingBudget as number | undefined;
            finalEngine.setMaxingMode(newMaxing, budget);
            activeEngine.setMaxingMode(newMaxing, budget);
            updatedState.maxingMode = newMaxing;
          }
          if ((cmdCtx.sessionState as Record<string, unknown>).autoMaxMode !== undefined) {
            const newAutoMax = Boolean((cmdCtx.sessionState as Record<string, unknown>).autoMaxMode);
            const cfg = (cmdCtx.sessionState as Record<string, unknown>).autoMaxConfig as any;
            finalEngine.setAutoMaxMode(newAutoMax, cfg);
            activeEngine.setAutoMaxMode(newAutoMax, cfg);
            updatedState.autoMaxMode = newAutoMax;
            updatedState.autoMaxConfig = cfg;
          }
          setSessionState(updatedState);
          if (updatedState.permissionMode && updatedState.permissionMode !== sessionState.permissionMode) {
            finalEngine.setPermissionMode(updatedState.permissionMode);
          }
          if (updatedState.provider && updatedState.model) {
            finalEngine.updateSessionModel(updatedState.provider, updatedState.model);
          }
          return;
        }

        if (cmd.type === 'prompt') {
          if (isBusyRef.current) {
            const trimmed = prompt.trim();
            if (trimmed) {
              queuedPromptRef.current = trimmed;
              setQueuedPrompt(trimmed);
            }
            return;
          }

          const userCmdMsg: UnifiedMessage = {
            id: randomUUID(),
            role: 'user',
            content: prompt,
            timestamp: Date.now(),
          };
          activeEngine.appendSyntheticMessage(userCmdMsg);

          const cmdCtx = {
            cwd: sessionState.cwd,
            sessionState: sessionState as unknown as Record<string, unknown>,
            args: parsedCmd.args,
          };

          const expandedPrompt = await cmd.getPrompt(cmdCtx);
          setIsBusy(true);
          isBusyRef.current = true;
          try {
            await activeEngine.executeUserPrompt(expandedPrompt);
          } catch {
            // Handled in event listeners
          } finally {
            setIsBusy(false);
            isBusyRef.current = false;
          }
          return;
        }
      }
    }

    // 8. History Inspection Navigation Slash Commands
    if (prompt.startsWith('/inspect') || prompt.startsWith('/turn ') || prompt.startsWith('turn ') || prompt.startsWith('inspect ') || prompt === '/turn' || prompt === 'turn') {
      const parts = prompt.trim().split(/\s+/);
      const targetTurn = parseInt(parts[1], 10);
      if (!isNaN(targetTurn) && targetTurn >= 1 && targetTurn <= promptTurns.length) {
        setViewingTurnIndex(targetTurn);
        return;
      }
    }

    if (prompt === '/history' || prompt === 'history') {
      const historySummary =
        promptTurns.length === 0
          ? 'No previous prompt turns in this session yet.'
          : [
              'Session Prompt History:',
              ...promptTurns.map(
                (turn) =>
                  `  Turn #${turn.turnIndex}: "${truncatePromptText(turn.promptText, 50)}" (Alt+${turn.turnIndex} or /turn ${turn.turnIndex})`
              ),
              '',
              'Use /turn <number> or Alt+1..9 to inspect any past turn, /return to return to bottom.',
            ].join('\n');
      const historyMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: historySummary,
        timestamp: Date.now(),
      };
      activeEngine.appendSyntheticMessage(historyMsg);
      setMessages([...activeEngine.getMessages()]);
      return;
    }

    if (prompt === '/return' || prompt === '/bottom' || prompt === 'return') {
      setViewingTurnIndex(null);
      return;
    }

    if (prompt === '/help' || prompt === 'help') {
      const userCmdMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
      };
      activeEngine.appendSyntheticMessage(userCmdMsg);

      const helpMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: formatSlashCommandHelp(commandRegistry),
        timestamp: Date.now() + 1,
      };
      activeEngine.appendSyntheticMessage(helpMsg);
      setMessages([...activeEngine.getMessages()]);
      return;
    }

    // 9. Standard User Prompt (AI Execution)
    if (isBusyRef.current) {
      const trimmed = prompt.trim();
      if (trimmed) {
        queuedPromptRef.current = trimmed;
        setQueuedPrompt(trimmed);
      }
      return;
    }

    if (process.stdout.isTTY) {
      try {
        const shortPrompt = truncatePromptText(prompt, 35);
        process.stdout.write(`\x1b]0;InterShader [Turn #${promptTurns.length + 1}]: ${shortPrompt}\x07`);
      } catch {
        // Ignore if stdout is closed
      }
    }

    setIsBusy(true);
    isBusyRef.current = true;
    try {
      await activeEngine.executeUserPrompt(prompt);
    } catch (err: unknown) {
      handleError(err);
    } finally {
      setIsBusy(false);
      isBusyRef.current = false;
      setCurrentToolName(null);
      setProgressText(null);
    }
  };

  const handleSwarmSubmit = async (promptSlots: Array<{ prompt: string; role: SwarmRole }>) => {
    setIsBusy(true);
    isBusyRef.current = true;

    const coordinator = new SwarmCoordinator();
    coordinator.on('progress', (evt: SwarmProgressEvent) => {
      setSwarmTasks([...evt.tasks]);
      setSwarmStatus(evt.overallStatus);
    });

    const userMsg: UnifiedMessage = {
      id: randomUUID(),
      role: 'user',
      content: `[Swarm Multi-Session Dispatch]:\n${promptSlots.map((s, i) => `${i + 1}. [${s.role.toUpperCase()}]: "${s.prompt}"`).join('\n')}`,
      timestamp: Date.now(),
    };
    activeEngine.appendSyntheticMessage(userMsg);
    setMessages([...activeEngine.getMessages()]);

    try {
      const { tasks, mergeResult } = await coordinator.runParallel(promptSlots, sessionState.cwd, true);
      const summaryMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: [
          `🐝 Swarm Completed (${tasks.length} Parallel Sessions):`,
          ...tasks.map((t) => `  * [${t.role.toUpperCase()}]: ${t.status === 'completed' ? 'SUCCESS' : 'FAILED'} - ${t.resultSummary || t.errorMessage || 'Done'}`),
          mergeResult ? `\n🔀 Integration: ${mergeResult.message}` : '',
        ].filter(Boolean).join('\n'),
        timestamp: Date.now() + 1,
      };
      activeEngine.appendSyntheticMessage(summaryMsg);
      setMessages([...activeEngine.getMessages()]);
    } catch (err: unknown) {
      handleError(err);
    } finally {
      setIsBusy(false);
      isBusyRef.current = false;
      setSwarmTasks([]);
      setSwarmStatus(null);
    }
  };

  handleUserSubmitRef.current = handleUserSubmit;

  const totalTokens = sessionState.totalInputTokens + sessionState.totalOutputTokens;

  const visibleMessages = useMemo(
    () => messages.filter((m) => m.role !== 'system'),
    [messages]
  );

  type StaticItem =
    | { type: 'header'; id: string }
    | {
        type: 'message';
        id: string;
        message: UnifiedMessage;
        previousPrompt?: string;
        turnIndex?: number;
      };

  const staticItems: StaticItem[] = useMemo(() => {
    const items: StaticItem[] = [{ type: 'header', id: 'session-header' }];
    let userTurnCounter = 0;
    for (const msg of visibleMessages) {
      if (msg.role === 'user') {
        userTurnCounter++;
        const prevTurn = promptTurns.find((turn) => turn.turnIndex === userTurnCounter - 1);
        items.push({
          type: 'message',
          id: msg.id,
          message: msg,
          previousPrompt: prevTurn?.promptText,
          turnIndex: userTurnCounter,
        });
      } else {
        items.push({ type: 'message', id: msg.id, message: msg });
      }
    }
    return items;
  }, [visibleMessages, promptTurns]);

  return (
    <Box flexDirection="column" paddingX={1} width={terminalColumns}>
      <Static items={staticItems}>
        {(item: StaticItem) => {
          if (item.type === 'header') {
            return (
              <Header
                key={item.id}
                model={sessionState.model}
                provider={sessionState.provider}
                cwd={sessionState.cwd}
                permissionMode={sessionState.permissionMode}
                totalTokens={totalTokens}
              />
            );
          }
          return (
            <MessageView
              key={item.id}
              message={item.message}
              previousPrompt={item.previousPrompt}
              turnIndex={item.turnIndex}
            />
          );
        }}
      </Static>

      {selectedTurn ? (
        <>
          <HistoryInspectionView
            turn={selectedTurn}
            totalTurns={promptTurns.length}
            onReturnToBottom={handleReturnToBottom}
            onSelectTurn={handleSelectTurn}
          />
          <ReturnToBottomBar
            onReturnToBottom={handleReturnToBottom}
            activeTurnIndex={selectedTurn.turnIndex}
          />
        </>
      ) : (
        <>
          <ToolProgressBlock
            currentToolName={currentToolName}
            progressText={progressText}
            isStreamingText={isBusy && !currentToolName}
          />

          {isBusy && sessionTasks.length > 0 && (
            <TaskTrackerView
              tasks={sessionTasks}
              isCompact={isCompact}
            />
          )}

          <SessionTabBar tabs={sessionTabs} activeTabId={activeTabId} />

          <StatusLine
            model={sessionState.model}
            provider={sessionState.provider}
            cwd={sessionState.cwd}
            permissionMode={sessionState.permissionMode}
            totalInputTokens={sessionState.totalInputTokens}
            totalOutputTokens={sessionState.totalOutputTokens}
            totalCachedTokens={sessionState.totalCachedTokens}
            contextTokens={contextTokens}
            totalCostUsd={sessionState.totalCostUsd}
            isBusy={isBusy}
            isCompact={isCompact}
            columns={terminalColumns}
            maxTurns={sessionState.maxTurns !== undefined ? sessionState.maxTurns : activeEngine.getMaxTurns()}
            maxingMode={Boolean(sessionState.maxingMode ?? activeEngine.getSessionState().maxingMode)}
            autoMaxMode={Boolean(sessionState.autoMaxMode ?? activeEngine.getSessionState().autoMaxMode)}
          />

          {isBusy && swarmTasks.length > 0 && (
            <SwarmDashboardView
              tasks={swarmTasks}
              overallStatus={swarmStatus || 'running'}
              isCompact={isCompact}
            />
          )}

          {pendingQuestion ? (
            <QuestionPrompt
              question={pendingQuestion.question}
              options={pendingQuestion.options}
              allowCustomInput={pendingQuestion.allowCustomInput}
              onRespond={(answer) => {
                pendingQuestion.respond(answer);
                setPendingQuestion(null);
              }}
            />
          ) : pendingPermission ? (
            <PermissionPrompt
              toolName={pendingPermission.toolName}
              args={pendingPermission.args}
              reason={pendingPermission.reason}
              onRespond={(approved, remember) => {
                pendingPermission.respond(approved, remember);
                setPendingPermission(null);
              }}
            />
          ) : (
            <InteractivePrompt
              onSubmit={handleUserSubmit}
              onSubmitSwarm={handleSwarmSubmit}
              onAbort={handleAbort}
              onClearQueue={handleClearQueue}
              isBusy={isBusy}
              isCompact={isCompact}
              queuedPrompt={queuedPrompt}
              disabled={false}
              focus={!pendingPermission && !pendingQuestion}
              availableCommands={commandRegistry.list()}
            />
          )}
        </>
      )}
    </Box>
  );
};

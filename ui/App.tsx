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
import { TerminalMouseManager } from './services/TerminalMouseManager.js';
import { extractPromptTurns, truncatePromptText } from './utils/turnExtractor.js';
import { PlanManager } from '../state/PlanManager.js';
import { TaskManager, taskEvents } from '../state/TaskManager.js';
import { SessionStore } from '../state/SessionStore.js';
import type { TaskItem } from '../tasks/TaskGraph.js';
import type { QueryEngine } from '../orchestrator/QueryEngine.js';
import type { UnifiedMessage, PermissionRequest, UserQuestionRequest } from '../types/index.js';

import { i18n, t } from '../services/i18n/index.js';
import { SUPPORTED_LOCALES } from '../services/i18n/types.js';
import { CommandRegistry, registerBuiltinCommands } from '../cli/commands/index.js';

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
  const [sessionTabs, setSessionTabs] = useState<SessionTab[]>(() => {
    const pool = MultiSessionPool.getInstance();
    pool.initPrimary(queryEngine);
    return pool.getTabs();
  });
  const [activeTabId, setActiveTabId] = useState<string>(() => {
    return MultiSessionPool.getInstance().getActiveTab().id;
  });

  const activeTab = useMemo(() => {
    const pool = MultiSessionPool.getInstance();
    return pool.getTabs().find((t) => t.id === activeTabId) || pool.getTabs()[0];
  }, [activeTabId, sessionTabs]);

  const activeEngine = activeTab ? activeTab.queryEngine : queryEngine;

  useEffect(() => {
    const pool = MultiSessionPool.getInstance();
    const handleTabSwitched = (tab: SessionTab) => {
      setActiveTabId(tab.id);
      setSessionTabs([...pool.getTabs()]);
      setMessages([...tab.queryEngine.getMessages()]);
      setSessionState({ ...tab.queryEngine.getSessionState() });
      setContextTokens(tab.queryEngine.getContextTokens());
      setIsBusy(tab.status === 'running');
      setSessionTasks(TaskManager.listTasks(tab.queryEngine.getSessionState().id));
      setViewingTurnIndex(null);
    };

    const handleTabsChanged = () => {
      setSessionTabs([...pool.getTabs()]);
    };

    pool.on('tab_switched', handleTabSwitched);
    pool.on('tab_created', handleTabsChanged);
    pool.on('tab_updated', handleTabsChanged);
    pool.on('tab_progress', handleTabsChanged);
    pool.on('tab_closed', handleTabsChanged);

    return () => {
      pool.off('tab_switched', handleTabSwitched);
      pool.off('tab_created', handleTabsChanged);
      pool.off('tab_updated', handleTabsChanged);
      pool.off('tab_progress', handleTabsChanged);
      pool.off('tab_closed', handleTabsChanged);
    };
  }, []);

  const [viewingTurnIndex, setViewingTurnIndex] = useState<number | null>(null);
  const [swarmTasks, setSwarmTasks] = useState<SwarmTask[]>([]);
  const [swarmStatus, setSwarmStatus] = useState<SwarmProgressEvent['overallStatus'] | null>(null);

  useEffect(() => {
    const mouseMgr = TerminalMouseManager.getInstance();
    mouseMgr.enable();
    return () => {
      mouseMgr.disable();
    };
  }, []);

  const [terminalDimensions, setTerminalDimensions] = useState(() => ({
    rows: process.stdout.rows || 24,
    columns: process.stdout.columns || 80,
  }));

  useEffect(() => {
    const handleResize = () => {
      setTerminalDimensions({
        rows: process.stdout.rows || 24,
        columns: process.stdout.columns || 80,
      });
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, []);

  const isCompact = isBusy || terminalDimensions.rows < 25;

  const promptTurns = useMemo(() => extractPromptTurns(messages), [messages]);

  const selectedTurn = useMemo(() => {
    if (viewingTurnIndex === null) return null;
    return promptTurns.find((t) => t.turnIndex === viewingTurnIndex) || null;
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
      return; // Debounce rapid multi-source triggers
    }
    lastAbortTimeRef.current = now;

    const isRunning = isBusyRef.current || activeEngine.getIsRunning();

    if (isRunning) {
      // Abort in-flight agent task while preserving the InterShader session
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
      // Agent is idle: Exit the InterShader CLI session cleanly
      exit();
    }
  }, [activeEngine, exit, pendingPermission]);

  // Global key interception: Ctrl+C (abort/exit) & Alt+1..9 (rewind to turn)
  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === 'C')) {
      handleAbort();
      return;
    }

    // Alt + 1..9 switches active session tab when multiple tabs exist, or jumps to turn
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


  // Global process-level SIGINT listener (handles OS signals, terminal break events)
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

  useEffect(() => {
    // 35ms UI render throttler (~28 FPS) to prevent terminal cursor stutter and 100% CPU on high-frequency stream chunks
    let lastRenderTime = 0;
    let pendingProgressText: string | null = null;
    let throttleTimer: NodeJS.Timeout | null = null;

    const flushProgress = () => {
      if (pendingProgressText !== null) {
        setProgressText(pendingProgressText);
      }
      setContextTokens(activeEngine.getContextTokens());
      lastRenderTime = Date.now();
      throttleTimer = null;
    };

    const scheduleProgressUpdate = (cleanText?: string) => {
      if (cleanText !== undefined) {
        pendingProgressText = cleanText;
      }
      const now = Date.now();
      const elapsed = now - lastRenderTime;
      if (elapsed >= 35) {
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        flushProgress();
      } else if (!throttleTimer) {
        throttleTimer = setTimeout(flushProgress, 35 - elapsed);
      }
    };

    // Listen to activeEngine events
    const handleText = (delta?: string) => {
      if (delta) {
        const clean = delta.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
        if (clean) {
          scheduleProgressUpdate(clean.length > 70 ? `${clean.slice(-67)}...` : clean);
          return;
        }
      }
      scheduleProgressUpdate();
    };

    const handleThought = (delta?: string) => {
      if (delta) {
        const clean = delta.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
        if (clean) {
          scheduleProgressUpdate(clean.length > 70 ? `${clean.slice(0, 67)}...` : clean);
        }
      }
    };

    const handleToolStart = (name: string) => {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      setCurrentToolName(name);
      setProgressText(null);
      setMessages([...activeEngine.getMessages()]);
      setContextTokens(activeEngine.getContextTokens());
    };

    const handleToolProgress = (progress: string) => {
      scheduleProgressUpdate(progress);
    };

    const handleToolDone = () => {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      setCurrentToolName(null);
      setProgressText(null);
      setMessages([...activeEngine.getMessages()]);
      setContextTokens(activeEngine.getContextTokens());
    };

    const handleUsage = () => {
      setSessionState({ ...activeEngine.getSessionState() });
      setContextTokens(activeEngine.getContextTokens());
    };

    const handleDone = () => {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
        throttleTimer = null;
      }
      setIsBusy(false);
      isBusyRef.current = false;
      setCurrentToolName(null);
      setProgressText(null);
      setPendingPermission(null);
      setMessages([...activeEngine.getMessages()]);
      setSessionState({ ...activeEngine.getSessionState() });
      setContextTokens(activeEngine.getContextTokens());

      // Clean up completed tasks from database so they do not persist into future prompts
      const currentSessionId = activeEngine.getSessionState().id;
      TaskManager.clearCompletedTasks(currentSessionId);
      const remainingTasks = TaskManager.listTasks(currentSessionId);
      setSessionTasks(remainingTasks);

      if (queuedPromptRef.current) {
        const next = queuedPromptRef.current;
        queuedPromptRef.current = null;
        setQueuedPrompt(null);
        setTimeout(() => {
          handleUserSubmitRef.current(next);
        }, 100);
      }
    };

    const handlePermissionRequest = (req: PermissionRequest) => {
      setPendingPermission(req);
    };

    const handleSessionReset = (newSession: any) => {
      setSessionState({ ...newSession });
      setSessionTasks([]);
      setMessages([...activeEngine.getMessages()]);
      setContextTokens(activeEngine.getContextTokens());
    };

    const handleUserMessage = () => {
      setMessages([...activeEngine.getMessages()]);
      setContextTokens(activeEngine.getContextTokens());
    };

    const handleSyntheticMessage = () => {
      setMessages([...activeEngine.getMessages()]);
      setContextTokens(activeEngine.getContextTokens());
    };

    const handleAskQuestion = (req: UserQuestionRequest) => {
      setPendingQuestion(req);
    };

    activeEngine.on('text', handleText);
    activeEngine.on('thought', handleThought);
    activeEngine.on('user_message', handleUserMessage);
    activeEngine.on('message', handleSyntheticMessage);
    activeEngine.on('tool_start', handleToolStart);
    activeEngine.on('tool_progress', handleToolProgress);
    activeEngine.on('tool_done', handleToolDone);
    activeEngine.on('usage', handleUsage);
    activeEngine.on('done', handleDone);
    activeEngine.on('error', handleError);
    activeEngine.on('permission_request', handlePermissionRequest);
    activeEngine.on('session_reset', handleSessionReset);
    activeEngine.on('ask_question', handleAskQuestion);

    const handleTaskChange = (changedSessionId: string) => {
      const currentSessionId = activeEngine.getSessionState().id;
      if (changedSessionId === currentSessionId) {
        setSessionTasks(TaskManager.listTasks(changedSessionId));
      }
    };
    taskEvents.on('change', handleTaskChange);

    return () => {
      if (throttleTimer) {
        clearTimeout(throttleTimer);
      }
      activeEngine.off('text', handleText);
      activeEngine.off('thought', handleThought);
      activeEngine.off('user_message', handleUserMessage);
      activeEngine.off('message', handleSyntheticMessage);
      activeEngine.off('tool_start', handleToolStart);
      activeEngine.off('tool_progress', handleToolProgress);
      activeEngine.off('tool_done', handleToolDone);
      activeEngine.off('usage', handleUsage);
      activeEngine.off('done', handleDone);
      activeEngine.off('error', handleError);
      activeEngine.off('permission_request', handlePermissionRequest);
      activeEngine.off('session_reset', handleSessionReset);
      activeEngine.off('ask_question', handleAskQuestion);
      taskEvents.off('change', handleTaskChange);
    };
  }, [activeEngine, handleError]);

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

      // Clean terminal screen and scrollback for the fresh conversation
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
        // List recent sessions for user to choose from
        const sessions = SessionStore.listSessions(6);
        const lines: string[] = ['Conversations available to resume:'];
        for (const s of sessions) {
          const isCurrent = s.id === sessionState.id ? ' [CURRENT]' : '';
          const timeStr = new Date(s.updatedAt).toLocaleString();
          const totalTokens = s.totalInputTokens + s.totalOutputTokens;
          lines.push(`- [${s.id.slice(0, 8)}] ${s.title} | ${s.model} | ${totalTokens.toLocaleString()} tokens | $${s.totalCostUsd.toFixed(4)} USD${isCurrent}`);
          lines.push(`  ID: ${s.id} (${timeStr})`);
        }
        lines.push('');
        lines.push('Usage: /resume <id> (or first 8 chars) | /resume latest');

        const infoMsg: UnifiedMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: lines.join('\n'),
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
      const restoredTasks = TaskManager.listTasks(resumed.id);
      setSessionTasks(restoredTasks);

      setSessionState({ ...resumed });
      setMessages([...activeEngine.getMessages()]);
      setContextTokens(activeEngine.getContextTokens());
      setCurrentToolName(null);
      setProgressText(null);
      setPendingPermission(null);

      // Clean terminal screen and scrollback for the resumed conversation
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

      // When targetPath is provided (e.g. "plan tự build model AI..." or "/plan design auth"):
      // 1. Enable Plan Mode (Safe Read-Only architectural mode)
      activeEngine.setPermissionMode('plan');
      setSessionState((prev) => ({ ...prev, permissionMode: 'plan' }));

      // 2. If agent is currently busy, queue the prompt
      if (isBusyRef.current) {
        const trimmed = prompt.trim();
        if (trimmed) {
          queuedPromptRef.current = trimmed;
          setQueuedPrompt(trimmed);
        }
        return;
      }

      // 3. Formulate planning instruction and execute with AI model (never freeze!)
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
        // A. LOCAL COMMAND: ALWAYS EXECUTE IMMEDIATELY, REGARDLESS OF isBusy (e.g. /tab new, /tab switch, /status, /help)
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

          // Get active tab's query engine in case the command switched tabs (e.g. /tab new or /tab switch)
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

          // Synchronize sessionState and targetEngine with model/provider/maxTurns/permissionMode changes
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
          setSessionState(updatedState);
          if (updatedState.permissionMode && updatedState.permissionMode !== sessionState.permissionMode) {
            finalEngine.setPermissionMode(updatedState.permissionMode);
          }
          if (updatedState.provider && updatedState.model) {
            finalEngine.updateSessionModel(updatedState.provider, updatedState.model);
          }
          return;
        }

        // B. PROMPT COMMAND: If agent is busy, queue prompt; otherwise execute immediately
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
                (t) =>
                  `  Turn #${t.turnIndex}: "${truncatePromptText(t.promptText, 50)}" (Alt+${t.turnIndex} or /turn ${t.turnIndex})`
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

      const allCommands = commandRegistry.list();
      const codeQualityNames = ['doctor', 'review', 'commit', 'diff', 'rewind', 'init', 'export'];
      const intelligenceNames = ['model', 'mode', 'turns', 'compact', 'status', 'stats', 'cost', 'memory', 'skills', 'worktree', 'gateway', 'sessions', 'tab', 'maxing'];

      const codeQualityCmds = allCommands.filter((c) => codeQualityNames.includes(c.name));
      const intelligenceCmds = allCommands.filter((c) => intelligenceNames.includes(c.name));

      const helpMsg: UnifiedMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: [
          'InterShader Slash Commands',
          '',
          '[System & Session Controls]',
          '  /tab new <title> - Create secondary session in isolated Git worktree',
          '  /tab switch <n>  - Switch active viewport to tab',
          '  /plan [view|rst] - Toggle Plan Mode, inspect active plan, or reset',
          '  /history         - View prompt history turns and shortcuts',
          '  /turn <id>       - Inspect historical prompt turn in rewind viewport',
          '  /return          - Return to latest bottom prompt input',
          '  /lang <id>       - Switch UI language (en, vi, ja, zh, es, fr, de, ko, ru)',
          '  /unqueue         - Delete/clear currently queued prompt',
          '  /clear           - Clear chat screen',
          '  /exit, /quit     - Exit terminal',
          '',
          '[Code Quality & Versioning]',
          ...codeQualityCmds.map((c) => `  /${c.name.padEnd(12)} - ${c.description}`),
          '',
          '[Intelligence & Multi-Session Sandboxing]',
          ...intelligenceCmds.map((c) => `  /${c.name.padEnd(12)} - ${c.description}`),
        ].join('\n'),
        timestamp: Date.now() + 1,
      };
      activeEngine.appendSyntheticMessage(helpMsg);
      setMessages([...activeEngine.getMessages()]);
      return;
    }

    // 9. Standard User Prompt (AI Execution)
    // If agent is currently busy processing, enqueue the prompt
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

  // Filter out system messages from display
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

  // All conversation messages in visibleMessages are completed turns.
  // Rendering them directly via <Static> guarantees they are printed once in full to stdout,
  // scroll naturally without truncation, and never overflow the dynamic terminal area.
  const staticItems: StaticItem[] = useMemo(() => {
    const items: StaticItem[] = [{ type: 'header', id: 'session-header' }];
    let userTurnCounter = 0;
    for (const msg of visibleMessages) {
      if (msg.role === 'user') {
        userTurnCounter++;
        const prevTurn = promptTurns.find((t) => t.turnIndex === userTurnCounter - 1);
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
    <Box flexDirection="column" paddingX={1} width={terminalDimensions.columns}>
      {/* Completed messages and header rendered once permanently via Static */}
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
            columns={terminalDimensions.columns}
            maxTurns={sessionState.maxTurns !== undefined ? sessionState.maxTurns : activeEngine.getMaxTurns()}
            maxingMode={Boolean(sessionState.maxingMode ?? activeEngine.getSessionState().maxingMode)}
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

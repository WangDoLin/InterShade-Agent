import { useEffect, type MutableRefObject } from 'react';
import { TaskManager, taskEvents } from '../../state/TaskManager.js';
import type { TaskItem } from '../../tasks/TaskGraph.js';
import type { QueryEngine } from '../../orchestrator/QueryEngine.js';
import type { UnifiedMessage, PermissionRequest, UserQuestionRequest } from '../../types/index.js';

export interface QueryEngineBridgeParams {
  readonly activeEngine: QueryEngine;
  readonly isBusyRef: MutableRefObject<boolean>;
  readonly queuedPromptRef: MutableRefObject<string | null>;
  readonly handleUserSubmitRef: MutableRefObject<(prompt: string) => Promise<void>>;
  readonly handleError: (err?: unknown) => void;
  readonly setIsBusy: (busy: boolean) => void;
  readonly setQueuedPrompt: (prompt: string | null) => void;
  readonly setCurrentToolName: (name: string | null) => void;
  readonly setProgressText: (text: string | null) => void;
  readonly setPendingPermission: (req: PermissionRequest | null) => void;
  readonly setPendingQuestion: (req: UserQuestionRequest | null) => void;
  readonly setMessages: (msgs: UnifiedMessage[]) => void;
  readonly setSessionState: (state: any) => void;
  readonly setContextTokens: (tokens: number) => void;
  readonly setSessionTasks: (tasks: TaskItem[]) => void;
}

const RENDER_THROTTLE_MS = 35;

/**
 * Bridges QueryEngine streaming events and TaskManager changes to React state
 * using a 35ms (~28 FPS) render throttler to prevent terminal cursor stutter (UI-010).
 */
export function useQueryEngineBridge(params: QueryEngineBridgeParams): void {
  const {
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
  } = params;

  useEffect(() => {
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
      if (elapsed >= RENDER_THROTTLE_MS) {
        if (throttleTimer) {
          clearTimeout(throttleTimer);
          throttleTimer = null;
        }
        flushProgress();
      } else if (!throttleTimer) {
        throttleTimer = setTimeout(flushProgress, RENDER_THROTTLE_MS - elapsed);
      }
    };

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

      const currentSessionId = activeEngine.getSessionState().id;
      TaskManager.clearCompletedTasks(currentSessionId);
      setSessionTasks(TaskManager.listTasks(currentSessionId));

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
}

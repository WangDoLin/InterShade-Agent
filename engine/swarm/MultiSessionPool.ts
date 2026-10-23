import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { QueryEngine } from '../../orchestrator/QueryEngine.js';
import { OrcaWorktreeOrchestrator } from '../orchestration/OrcaWorktreeOrchestrator.js';
import { SwarmIntegrator } from './SwarmIntegrator.js';
import { FileLockRegistry } from './FileLockRegistry.js';
import type { SwarmRole, SwarmMergeResult, SwarmTask } from './SwarmTypes.js';
import type { SessionConfig } from '../../types/index.js';

/**
 * Port interface decoupling MultiSessionPool from concrete QueryEngine implementation (NEXT-C-01).
 */
export interface SessionExecutor extends EventEmitter {
  getSessionState(): { id: string; cwd: string };
  abort(): void;
}

export type SessionExecutorFactory = (config: SessionConfig) => SessionExecutor;

export interface SessionTab {
  id: string;
  title: string;
  role: SwarmRole;
  queryEngine: QueryEngine;
  executor: SessionExecutor;
  isPrimary: boolean;
  worktreePath: string;
  branch?: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  assignedScope?: string[];
  createdAt: number;
  unreadOutputs: number;
  lastActiveAt: number;
}

export interface CreateTabOptions {
  title: string;
  role?: SwarmRole;
  scope?: string[];
  baseBranch?: string;
}

/**
 * MultiSessionPool manages concurrent user session tabs within a single project.
 * Isolates each secondary agent in a dedicated Git worktree (.intershade/worktrees/<id>)
 * and prevents race conditions via FileLockRegistry and SwarmIntegrator.
 */
export class MultiSessionPool extends EventEmitter {
  private static instance: MultiSessionPool | null = null;
  private tabs: SessionTab[] = [];
  private activeTabId: string = '';
  private baseCwd: string = process.cwd();
  private executorFactory: SessionExecutorFactory = (cfg) => new QueryEngine(cfg);

  constructor(executorFactory?: SessionExecutorFactory) {
    super();
    if (executorFactory) {
      this.executorFactory = executorFactory;
    }
  }

  static getInstance(): MultiSessionPool {
    if (!this.instance) {
      this.instance = new MultiSessionPool();
    }
    return this.instance;
  }

  /**
   * Override the SessionExecutor factory for dependency injection / testing (NEXT-C-01).
   */
  setExecutorFactory(factory: SessionExecutorFactory): void {
    this.executorFactory = factory;
  }

  /**
   * Reset the singleton instance (useful for testing or session reset).
   */
  static resetInstance(): void {
    if (this.instance) {
      this.instance.clearAll();
      this.instance = null;
    }
  }

  /**
   * Initialize the primary session (Tab 1: Main workspace).
   */
  initPrimary(primaryEngine: SessionExecutor, title = 'Main Workspace'): SessionTab {
    const existing = this.tabs.find((t) => t.isPrimary);
    if (existing) {
      return existing;
    }

    const state = primaryEngine.getSessionState();
    this.baseCwd = state.cwd;

    const primaryTab: SessionTab = {
      id: state.id,
      title,
      role: 'general',
      queryEngine: primaryEngine as QueryEngine,
      executor: primaryEngine,
      isPrimary: true,
      worktreePath: state.cwd,
      status: 'idle',
      createdAt: Date.now(),
      unreadOutputs: 0,
      lastActiveAt: Date.now(),
    };

    this.wireEngineEvents(primaryTab);
    this.tabs.push(primaryTab);
    this.activeTabId = primaryTab.id;

    this.emit('tab_created', primaryTab);
    this.emit('tab_switched', primaryTab);
    return primaryTab;
  }

  /**
   * Create a new secondary agent session tab with an isolated Git worktree.
   */
  async createTab(options: CreateTabOptions, configTemplate?: SessionConfig): Promise<SessionTab> {
    const safeTitle = options.title.trim() || 'Worker Session';
    const slug = safeTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '_').slice(0, 16);
    const id = `tab_${slug}_${randomUUID().slice(0, 6)}`;
    const role: SwarmRole = options.role || 'general';

    let worktreePath = this.baseCwd;
    let branch: string | undefined;

    // Check if git is available to create isolated worktree
    const isGit = await OrcaWorktreeOrchestrator.isGitRepository(this.baseCwd);
    if (isGit) {
      try {
        const wt = await OrcaWorktreeOrchestrator.createWorktree(id, options.baseBranch || 'HEAD', this.baseCwd);
        worktreePath = wt.worktreePath;
        branch = wt.branch;
      } catch {
        // Fallback to shared workspace if worktree creation fails
        worktreePath = this.baseCwd;
      }
    }

    // Configure dedicated SessionExecutor for this secondary tab
    const primaryTab = this.tabs.find((t) => t.isPrimary);
    const template = configTemplate || (primaryTab ? (primaryTab.executor as any).sessionConfig : undefined);

    const sessionConfig: SessionConfig = {
      ...(template || {}),
      sessionId: id,
      cwd: worktreePath,
      provider: template?.provider || 'gemini',
      model: template?.model || 'gemini-2.5-flash',
      permissionMode: template?.permissionMode || 'default',
      maxTokens: template?.maxTokens || 8192,
      resumeSession: false,
    };

    const secondaryEngine = this.executorFactory(sessionConfig);

    // Register assigned scopes in FileLockRegistry if specified
    if (options.scope && options.scope.length > 0) {
      FileLockRegistry.setSessionScope(id, options.scope);
    }

    const tab: SessionTab = {
      id,
      title: safeTitle,
      role,
      queryEngine: secondaryEngine as QueryEngine,
      executor: secondaryEngine,
      isPrimary: false,
      worktreePath,
      branch,
      status: 'idle',
      assignedScope: options.scope,
      createdAt: Date.now(),
      unreadOutputs: 0,
      lastActiveAt: Date.now(),
    };

    this.wireEngineEvents(tab);
    this.tabs.push(tab);

    this.emit('tab_created', tab);
    return tab;
  }

  /**
   * Get all active session tabs.
   */
  getTabs(): SessionTab[] {
    return this.tabs;
  }

  /**
   * Get currently active session tab.
   */
  getActiveTab(): SessionTab {
    const active = this.tabs.find((t) => t.id === this.activeTabId);
    if (active) return active;
    if (this.tabs.length > 0) return this.tabs[0];
    throw new Error('No session tabs currently initialized in MultiSessionPool.');
  }

  /**
   * Get tab by ID or 1-based index.
   */
  getTab(idOrIndex: string | number): SessionTab | undefined {
    if (typeof idOrIndex === 'number') {
      const idx = idOrIndex - 1;
      return this.tabs[idx];
    }
    return this.tabs.find((t) => t.id === idOrIndex || t.title.toLowerCase() === idOrIndex.toLowerCase());
  }

  /**
   * Switch the active viewport tab.
   */
  switchActiveTab(idOrIndex: string | number): SessionTab {
    const tab = this.getTab(idOrIndex);
    if (!tab) {
      throw new Error(`Session tab "${idOrIndex}" not found.`);
    }

    this.activeTabId = tab.id;
    tab.unreadOutputs = 0; // Clear unread badge
    tab.lastActiveAt = Date.now();

    this.emit('tab_switched', tab);
    return tab;
  }

  /**
   * Close a secondary session tab, cleanup worktree and release leases.
   */
  async closeTab(idOrIndex: string | number): Promise<boolean> {
    const tab = this.getTab(idOrIndex);
    if (!tab) return false;

    if (tab.isPrimary) {
      throw new Error('Primary workspace session (Tab 1) cannot be closed.');
    }

    // Abort any ongoing query
    try {
      tab.executor.abort();
    } catch {
      // ignore
    }

    // Cleanup Git worktree if secondary
    if (tab.worktreePath !== this.baseCwd) {
      await OrcaWorktreeOrchestrator.cleanupWorktree(tab.id, true, this.baseCwd).catch(() => {});
    }

    // Clear file lock scopes
    FileLockRegistry.clearSessionScope(tab.id);

    // Remove tab
    const index = this.tabs.findIndex((t) => t.id === tab.id);
    if (index !== -1) {
      this.tabs.splice(index, 1);
    }

    // If active tab was closed, switch back to primary
    if (this.activeTabId === tab.id) {
      const primary = this.tabs.find((t) => t.isPrimary) || this.tabs[0];
      if (primary) {
        this.activeTabId = primary.id;
        this.emit('tab_switched', primary);
      }
    }

    this.emit('tab_closed', tab.id);
    return true;
  }

  /**
   * Merge code changes from a secondary worktree branch into the base branch.
   */
  async mergeTab(idOrIndex: string | number): Promise<SwarmMergeResult> {
    const tab = this.getTab(idOrIndex);
    if (!tab) {
      return {
        success: false,
        mergedBranches: [],
        failedBranches: [{ branch: String(idOrIndex), reason: 'Tab not found.' }],
        verificationPassed: false,
        message: `Session tab "${idOrIndex}" not found.`,
      };
    }

    if (tab.isPrimary || !tab.branch || tab.worktreePath === this.baseCwd) {
      return {
        success: true,
        mergedBranches: [],
        failedBranches: [],
        verificationPassed: true,
        message: 'Tab changes are already in the primary workspace.',
      };
    }

    const swarmTask: SwarmTask = {
      id: tab.id,
      role: tab.role,
      prompt: tab.title,
      status: 'completed',
      progressPercent: 100,
      worktreePath: tab.worktreePath,
      branch: tab.branch,
      leasedFiles: [],
    };

    return SwarmIntegrator.mergeSwarmTasks([swarmTask], 'HEAD', this.baseCwd);
  }

  private wireEngineEvents(tab: SessionTab): void {
    tab.executor.on('tool_start', (name: string) => {
      tab.status = 'running';
      this.emit('tab_progress', { tabId: tab.id, status: 'running', tool: name });
    });

    tab.executor.on('tool_done', () => {
      if (this.activeTabId !== tab.id) {
        tab.unreadOutputs++;
      }
      this.emit('tab_updated', tab);
    });

    tab.executor.on('done', () => {
      tab.status = 'idle';
      if (this.activeTabId !== tab.id) {
        tab.unreadOutputs++;
      }
      this.emit('tab_progress', { tabId: tab.id, status: 'idle' });
      this.emit('tab_updated', tab);
    });

    tab.executor.on('error', () => {
      tab.status = 'error';
      this.emit('tab_progress', { tabId: tab.id, status: 'error' });
      this.emit('tab_updated', tab);
    });
  }

  /**
   * Clear all tabs and cleanup resources.
   */
  clearAll(): void {
    for (const tab of this.tabs) {
      if (!tab.isPrimary && tab.worktreePath !== this.baseCwd) {
        OrcaWorktreeOrchestrator.cleanupWorktree(tab.id, true, this.baseCwd).catch(() => {});
      }
      FileLockRegistry.clearSessionScope(tab.id);
    }
    this.tabs = [];
    this.activeTabId = '';
  }
}

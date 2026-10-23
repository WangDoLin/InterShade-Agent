import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import type { LocalCommand, PromptCommand } from '../types.js';
import { ShadowWorktree } from '../../../security/ShadowWorktree.js';
import { McpClientManager } from '../../../services/mcp/McpClientManager.js';
import { RepoMapTool } from '../../../tools/context/RepoMapTool.js';
import { TaskManager } from '../../../state/TaskManager.js';
import { SerenaSemanticEngine } from '../../../engine/semantic/SerenaSemanticEngine.js';
import { TaskScheduler } from '../../../services/scheduler/TaskScheduler.js';
import { SessionStore } from '../../../state/SessionStore.js';

export const sessionsCommand: LocalCommand = {
  name: 'sessions',
  description: 'List recent conversation sessions stored in SQLite WAL',
  type: 'local',
  aliases: ['history'],
  execute: () => {
    try {
      const rows = SessionStore.listSessions(10);
      if (rows.length === 0) {
        return 'No stored sessions in database. Use /new to start a new session.';
      }

      const lines: string[] = ['Recent Conversation Sessions:'];
      for (const r of rows) {
        const timeStr = new Date(r.updatedAt).toLocaleString();
        const totTokens = r.totalInputTokens + r.totalOutputTokens;
        lines.push(`- [${r.id.slice(0, 8)}] ${r.title} | ${r.model} | ${totTokens.toLocaleString()} tokens | $${r.totalCostUsd.toFixed(4)} USD`);
        lines.push(`  ID: ${r.id} (${timeStr})`);
      }
      lines.push('\nTips:');
      lines.push('  - /resume <id> (or /resume latest) to switch to any previous conversation');
      lines.push('  - /cost all to view total tokens and cost across all sessions');
      lines.push('  - /new to start fresh, or /delete to permanently remove current session');
      return lines.join('\n');
    } catch {
      return 'Unable to query sessions table from SQLite.';
    }
  },
};

export const resumeCommand: LocalCommand = {
  name: 'resume',
  description: 'Resume or switch to a previous conversation session (usage: /resume [id|latest])',
  type: 'local',
  aliases: ['switch', 'load'],
  execute: (ctx) => {
    const targetId = ctx.args[0]?.trim();
    if (!targetId) {
      const sessions = SessionStore.listSessions(6);
      const lines = ['Conversations available to resume:'];
      for (const s of sessions) {
        const tot = s.totalInputTokens + s.totalOutputTokens;
        lines.push(`- [${s.id.slice(0, 8)}] ${s.title} | ${s.model} | ${tot.toLocaleString()} tokens | $${s.totalCostUsd.toFixed(4)} USD`);
        lines.push(`  ID: ${s.id} (${new Date(s.updatedAt).toLocaleString()})`);
      }
      lines.push('\nUsage: /resume <id> or /resume latest');
      return lines.join('\n');
    }
    return `Resuming session ${targetId}...`;
  },
};

export const newCommand: LocalCommand = {
  name: 'new',
  description: 'Start a fresh conversation session (use --delete or -d to delete current session)',
  type: 'local',
  aliases: ['reset'],
  execute: () => {
    return 'Starting new conversation...';
  },
};

export const deleteSessionCommand: LocalCommand = {
  name: 'delete',
  description: 'Permanently delete current conversation from database and start a fresh session',
  type: 'local',
  aliases: ['delete-session', 'drop'],
  execute: () => {
    return 'Deleting conversation and starting new session...';
  },
};

export const worktreeCommand: LocalCommand = {
  name: 'worktree',
  description: 'Manage and inspect Git Shadow Worktree Sandboxes',
  type: 'local',
  aliases: ['wt'],
  execute: (ctx) => {
    const action = ctx.args[0]?.toLowerCase();
    const shadowDir = path.join(ctx.cwd, '.intershader', 'shadow');

    if (action === 'cleanup') {
      if (fs.existsSync(shadowDir)) {
        const subdirs = fs.readdirSync(shadowDir);
        for (const dir of subdirs) {
          try {
            ShadowWorktree.removeShadow(path.join(shadowDir, dir), ctx.cwd);
          } catch {
            // Ignore removal errors
          }
        }
        return 'Cleaned up all shadow worktree sandboxes in .intershader/shadow/';
      }
      return 'No active shadow worktree directory to clean.';
    }

    if (!fs.existsSync(shadowDir)) {
      return 'No Git Shadow Worktrees currently active.';
    }

    const entries = fs.readdirSync(shadowDir);
    if (entries.length === 0) {
      return 'No Git Shadow Worktrees currently active.';
    }

    return [
      `Active Git Shadow Worktrees (${entries.length}):`,
      ...entries.map((e) => `  - ${e}`),
      'Usage: /worktree cleanup to purge isolated sandboxes',
    ].join('\n');
  },
};

export const gatewayCommand: LocalCommand = {
  name: 'gateway',
  description: 'Inspect multi-channel remote gateway daemon status',
  type: 'local',
  aliases: ['gw'],
  execute: () => {
    return [
      'Multi-Channel Gateway Daemon',
      'Supported Channels: REST API, Telegram Interactive Bot',
      'Default Port:       3847',
      'Status:             Available for headless dispatch',
      'Usage: Launch Gateway daemon using GatewayServer class',
    ].join('\n');
  },
};

export const mcpCommand: LocalCommand = {
  name: 'mcp',
  description: 'Inspect Model Context Protocol (MCP) servers and active external tools',
  type: 'local',
  aliases: ['mcps'],
  execute: (ctx) => {
    const configPath = McpClientManager.findConfigFile(ctx.cwd);
    const connected = McpClientManager.getConnectedServers();

    if (!configPath) {
      return [
        'Model Context Protocol (MCP) Ecosystem',
        'Status: No MCP configuration file detected.',
        'To connect external servers (Postgres, GitHub, SQLite, Sentry):',
        '  Create .intershader/mcp.json or .mcp.json with:',
        '  {',
        '    "mcpServers": {',
        '      "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }',
        '    }',
        '  }',
      ].join('\n');
    }

    return [
      'Model Context Protocol (MCP) Runtime',
      `Config Path:       ${configPath}`,
      `Active Servers:    ${connected.length > 0 ? connected.join(', ') : 'None running or awaiting connection'}`,
      'Servers provide dynamic domain tools to the agent seamlessly.',
    ].join('\n');
  },
};

export const repoMapCommand: LocalCommand = {
  name: 'repomap',
  description: 'Display an AST structural symbol architecture map of the codebase',
  type: 'local',
  aliases: ['map', 'symbols'],
  execute: async (ctx) => {
    const tool = new RepoMapTool();
    return await tool.execute(
      { subDir: ctx.args[0] },
      { sessionId: (ctx.sessionState?.id as string) || 'cli', cwd: ctx.cwd, permissionMode: 'bypassPermissions' }
    );
  },
};

export const tasksCommand: LocalCommand = {
  name: 'tasks',
  description: 'Display active task checklist, tick tasks done, or clear tasks (/tasks [done <id>|tick <id>|clear|prune])',
  type: 'local',
  aliases: ['todos', 'todo'],
  execute: (ctx) => {
    const sessionId = (ctx.sessionState?.id as string) || '';
    if (!sessionId) {
      return 'No active session found.';
    }

    const sub = ctx.args[0]?.toLowerCase();
    const targetArg = ctx.args[1];

    if (sub === 'prune' || sub === 'clear-done' || (sub === 'clear' && targetArg?.toLowerCase() === 'completed')) {
      const cleared = TaskManager.clearCompletedTasks(sessionId);
      return `[TASKS]: Cleared ${cleared} completed task(s) from session checklist.`;
    }

    if (sub === 'clear' || sub === 'reset') {
      const cleared = TaskManager.clearAllTasks(sessionId);
      return `[TASKS]: Cleared ${cleared} task(s) from session checklist.`;
    }

    const isTickCmd = sub === 'tick' || sub === 'done' || sub === 'complete' || sub === 'check';
    const isReverseTick = /^\d+$/.test(sub || '') && (targetArg?.toLowerCase() === 'done' || targetArg?.toLowerCase() === 'tick');
    if (isTickCmd || isReverseTick) {
      const taskId = isReverseTick ? sub : targetArg;
      if (!taskId) {
        return '[TASKS]: Please specify the task ID to complete, e.g. /tasks done 1';
      }
      const task = TaskManager.getTask(sessionId, taskId);
      if (!task) {
        return `[TASKS]: Task #${taskId} not found in session.`;
      }
      TaskManager.updateTask(sessionId, taskId, { status: 'completed' });
      return `[TASKS]: Marked task #${taskId} ("${task.subject}") as [✔] COMPLETED.`;
    }

    const isUntickCmd = sub === 'untick' || sub === 'pending' || sub === 'uncheck';
    if (isUntickCmd) {
      const taskId = targetArg;
      if (!taskId) {
        return '[TASKS]: Please specify the task ID, e.g. /tasks untick 1';
      }
      const task = TaskManager.getTask(sessionId, taskId);
      if (!task) {
        return `[TASKS]: Task #${taskId} not found in session.`;
      }
      TaskManager.updateTask(sessionId, taskId, { status: 'pending' });
      return `[TASKS]: Marked task #${taskId} ("${task.subject}") as [○] PENDING.`;
    }

    if (sub === 'start' || sub === 'in_progress' || sub === 'run') {
      const taskId = targetArg;
      if (!taskId) {
        return '[TASKS]: Please specify the task ID, e.g. /tasks start 1';
      }
      const task = TaskManager.getTask(sessionId, taskId);
      if (!task) {
        return `[TASKS]: Task #${taskId} not found in session.`;
      }
      TaskManager.updateTask(sessionId, taskId, { status: 'in_progress' });
      return `[TASKS]: Marked task #${taskId} ("${task.subject}") as [▶] IN_PROGRESS.`;
    }

    const tasks = TaskManager.listTasks(sessionId);
    if (tasks.length === 0) {
      return 'No tasks currently registered in session. Use task_manage to create tasks or ask the agent to break down a plan into steps.';
    }
    const completed = tasks.filter((t) => t.status === 'completed').length;
    const lines = [
      `Session Task Checklist (${completed}/${tasks.length} completed):`,
      '------------------------------------------------------------',
    ];
    for (const t of tasks) {
      const mark = t.status === 'completed' ? '[✔]' : t.status === 'in_progress' ? '[▶]' : '[○]';
      const active = t.activeForm ? ` (${t.activeForm})` : '';
      lines.push(`${mark} #${t.id}: ${t.subject} [${t.status.toUpperCase()}]${active}`);
      if (t.description && t.description !== t.subject) {
        lines.push(`     ${t.description}`);
      }
    }
    lines.push('------------------------------------------------------------');
    lines.push('Commands: /tasks done <id> | /tasks untick <id> | /tasks prune | /tasks clear');
    return lines.join('\n');
  },
};

export const interviewCommand: PromptCommand = {
  name: 'interview',
  description: 'Trigger interactive Socratic clarification interview before writing code',
  type: 'prompt',
  aliases: ['grill-me', 'clarify'],
  getPrompt: (ctx) => {
    const topic = ctx.args.length > 0 ? ctx.args.join(' ') : 'the current task';
    return [
      `Please conduct an interactive Socratic clarification interview with me regarding ${topic}.`,
      'Guidelines:',
      '1. Do not start coding or editing files yet.',
      '2. Identify ambiguities, edge cases, or architecture decisions that need alignment.',
      '3. Use the `ask_user` tool with structured multiple-choice options to ask me one or two targeted questions at a time.',
      '4. Once we align, summarize the agreed specification and implementation steps.',
    ].join('\n');
  },
};

export const lintCommand: LocalCommand = {
  name: 'lint',
  description: 'Run TypeScript compiler and syntax diagnostics on workspace files',
  type: 'local',
  aliases: ['diagnostics', 'diag'],
  execute: (ctx) => {
    const targetFile = ctx.args[0];
    if (targetFile) {
      const resolved = path.isAbsolute(targetFile) ? targetFile : path.join(ctx.cwd, targetFile);
      const diags = SerenaSemanticEngine.getDiagnostics(resolved);
      if (diags.length === 0) {
        return `[LINT]: No errors or warnings found in ${targetFile}.`;
      }
      return [
        `[LINT]: ${diags.length} issue(s) found in ${targetFile}:`,
        ...diags.map((d) => `  - [${d.category.toUpperCase()} TS${d.code}] Line ${d.line}:${d.character} - ${d.message}`),
      ].join('\n');
    }

    try {
      const gitOut = execSync('git status --porcelain', { cwd: ctx.cwd, encoding: 'utf-8', timeout: 3000 });
      const modifiedFiles = gitOut
        .split('\n')
        .map((l) => l.trim().slice(3))
        .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx'));

      if (modifiedFiles.length === 0) {
        return '[LINT]: No modified code files detected in git working tree to lint.';
      }

      const reportLines: string[] = [`[LINT]: Inspecting ${modifiedFiles.length} modified file(s):`];
      let totalIssues = 0;
      for (const f of modifiedFiles.slice(0, 10)) {
        const resolved = path.join(ctx.cwd, f);
        const diags = SerenaSemanticEngine.getDiagnostics(resolved);
        if (diags.length > 0) {
          totalIssues += diags.length;
          reportLines.push(`\n📄 ${f} (${diags.length} issue(s)):`);
          for (const d of diags.slice(0, 5)) {
            reportLines.push(`   - [${d.category.toUpperCase()} TS${d.code}] Line ${d.line}:${d.character} - ${d.message}`);
          }
        }
      }
      if (totalIssues === 0) {
        return `[LINT]: All ${modifiedFiles.length} modified files passed compiler diagnostics with 0 issues!`;
      }
      return reportLines.join('\n');
    } catch {
      return '[LINT]: Please specify a target file: /lint <filePath>';
    }
  },
};

export const scheduleCommand: LocalCommand = {
  name: 'schedule',
  description: 'Manage background timers and cron schedules for the agent',
  type: 'local',
  execute: async (ctx) => {
    const scheduler = TaskScheduler.getInstance();
    const args = ctx.args;

    if (args.length === 0 || args[0] === 'list') {
      const tasks = scheduler.listTasks();
      if (tasks.length === 0) {
        return '[SCHEDULE]: No scheduled timers or cron jobs currently active.\nUsage:\n  /schedule in <seconds>s <prompt>\n  /schedule cron "<expression>" <prompt>\n  /schedule cancel <taskId>';
      }
      const lines = tasks.map((t) => {
        const nextIn = Math.max(0, Math.round((t.nextRunAt - Date.now()) / 1000));
        return `- **${t.id}** [${t.type}] Status: ${t.status} | In: ${nextIn}s | Prompt: "${t.prompt}"`;
      });
      return `### Active Schedules (${tasks.length}):\n${lines.join('\n')}`;
    }

    if (args[0] === 'cancel' && args[1]) {
      const ok = scheduler.cancel(args[1]);
      return ok ? `[SCHEDULE]: Cancelled task ${args[1]}` : `[SCHEDULE]: Task ${args[1]} not found.`;
    }

    if (args[0] === 'in' && args[1]) {
      let seconds = parseInt(args[1].replace(/s$/, ''), 10);
      if (args[1].endsWith('m')) {
        seconds = parseInt(args[1].replace(/m$/, ''), 10) * 60;
      }
      const prompt = args.slice(2).join(' ') || 'Scheduled reminder';
      const task = scheduler.scheduleTimer({ durationSeconds: seconds, prompt });
      return `[SCHEDULE]: Timer scheduled for ${seconds}s (Task ID: ${task.id}). Prompt: "${prompt}"`;
    }

    return '[SCHEDULE]: Usage: /schedule in <seconds/minutes> <prompt> | /schedule cancel <taskId> | /schedule list';
  },
};

export const tabCommand: LocalCommand = {
  name: 'tab',
  description: 'Manage concurrent multi-session tabs in isolated Git worktrees (/tab new, /tab switch, /tab list, /tab merge, /tab close)',
  type: 'local',
  aliases: ['tabs', 'session_tab'],
  execute: async (ctx) => {
    const { MultiSessionPool } = await import('../../../engine/swarm/MultiSessionPool.js');
    const pool = MultiSessionPool.getInstance();
    const sub = ctx.args[0]?.toLowerCase();

    if (!sub || sub === 'list') {
      const tabs = pool.getTabs();
      if (tabs.length === 0) {
        return '[TABS]: No session tabs currently initialized in MultiSessionPool.\nUsage:\n  /tab new <title> [role]   - Create a secondary agent session tab in isolated Git worktree\n  /tab switch <number>      - Switch active view to tab\n  /tab merge [number]       - Merge worktree code back into main branch\n  /tab close <number>       - Close secondary tab and delete worktree';
      }
      const active = pool.getActiveTab();
      const lines = [
        `📑 Active Session Tabs (${tabs.length}):`,
        ...tabs.map((t, i) => {
          const marker = t.id === active.id ? '▶ [ACTIVE]' : '  ';
          const wt = t.isPrimary ? '(Primary Workspace)' : `(Worktree: ${t.branch || path.basename(t.worktreePath)})`;
          return `${marker} Tab ${i + 1}: "${t.title}" [${t.role.toUpperCase()}] -> ${t.status.toUpperCase()} ${wt}`;
        }),
        '',
        'Usage:',
        '  /tab new <title> [role]   - Create a secondary agent session tab in isolated Git worktree',
        '  /tab switch <number>      - Switch active view to tab',
        '  /tab merge [number]       - Merge worktree code back into main branch with VerificationGate',
        '  /tab close <number>       - Close secondary tab and delete its worktree',
      ];
      return lines.join('\n');
    }

    if (sub === 'new' || sub === 'create') {
      const title = ctx.args[1] || 'Worker Session';
      const role = (ctx.args[2] || 'general') as any;
      try {
        const newTab = await pool.createTab({ title, role });
        pool.switchActiveTab(newTab.id);
        const tabNumber = pool.getTabs().findIndex((t) => t.id === newTab.id) + 1;
        return `[TABS]: Successfully created and switched to Tab ${tabNumber}: "${newTab.title}" [Role: ${newTab.role}].\nIsolated Worktree: ${newTab.worktreePath}\nGit Branch: ${newTab.branch || 'N/A'}\n🚀 Ready for concurrent prompt execution! Previous tab continues running in background.\nShortcut: Press Alt+1..${pool.getTabs().length} or /tab switch <n> to switch between tabs.`;
      } catch (err: unknown) {
        return `[TABS ERROR]: Failed to create worktree session: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (sub === 'switch') {
      const target = ctx.args[1];
      if (!target) {
        return '[TABS]: Please specify a tab number or title: /tab switch <number>';
      }
      const num = parseInt(target, 10);
      try {
        const switched = pool.switchActiveTab(!isNaN(num) ? num : target);
        return `[TABS]: Switched active tab to "${switched.title}" (Tab ${pool.getTabs().findIndex((t) => t.id === switched.id) + 1}).`;
      } catch (err: unknown) {
        return `[TABS ERROR]: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    if (sub === 'merge') {
      const target = ctx.args[1] ? parseInt(ctx.args[1], 10) || ctx.args[1] : pool.getActiveTab().id;
      const res = await pool.mergeTab(target);
      return `[TABS MERGE]: ${res.message}`;
    }

    if (sub === 'close' || sub === 'delete') {
      const target = ctx.args[1] ? parseInt(ctx.args[1], 10) || ctx.args[1] : pool.getActiveTab().id;
      try {
        const ok = await pool.closeTab(target);
        return ok
          ? `[TABS]: Successfully closed tab "${target}". Worktree cleaned up.`
          : `[TABS]: Tab "${target}" not found.`;
      } catch (err: unknown) {
        return `[TABS ERROR]: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return '[TABS]: Unknown command. Usage: /tab list | /tab new <title> | /tab switch <number> | /tab merge | /tab close';
  },
};

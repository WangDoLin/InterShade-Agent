import type { CommandRegistry } from '../../cli/commands/CommandRegistry.js';

export function formatSlashCommandHelp(commandRegistry: CommandRegistry): string {
  const allCommands = commandRegistry.list();
  const codeQualityNames = ['doctor', 'review', 'commit', 'diff', 'rewind', 'init', 'export'];
  const intelligenceNames = [
    'model',
    'mode',
    'turns',
    'compact',
    'status',
    'stats',
    'cost',
    'memory',
    'skills',
    'worktree',
    'gateway',
    'sessions',
    'tab',
    'maxing',
  ];

  const codeQualityCmds = allCommands.filter((c) => codeQualityNames.includes(c.name));
  const intelligenceCmds = allCommands.filter((c) => intelligenceNames.includes(c.name));

  return [
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
  ].join('\n');
}

export function formatResumeSessionList(
  sessions: Array<{
    id: string;
    title: string;
    model: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: number;
    updatedAt: number;
  }>,
  currentSessionId: string
): string {
  const lines: string[] = ['Conversations available to resume:'];
  for (const s of sessions) {
    const isCurrent = s.id === currentSessionId ? ' [CURRENT]' : '';
    const timeStr = new Date(s.updatedAt).toLocaleString();
    const totalTokens = s.totalInputTokens + s.totalOutputTokens;
    lines.push(
      `- [${s.id.slice(0, 8)}] ${s.title} | ${s.model} | ${totalTokens.toLocaleString()} tokens | $${s.totalCostUsd.toFixed(4)} USD${isCurrent}`
    );
    lines.push(`  ID: ${s.id} (${timeStr})`);
  }
  lines.push('');
  lines.push('Usage: /resume <id> (or first 8 chars) | /resume latest');
  return lines.join('\n');
}

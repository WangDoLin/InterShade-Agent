import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { exec } from 'child_process';
import { THEME } from '../theme.js';
import { ModelRegistry } from '../../orchestrator/ModelRegistry.js';

const GIT_REFRESH_INTERVAL_MS = 10_000;

export interface StatusLineProps {
  model: string;
  provider: string;
  cwd: string;
  permissionMode: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  contextTokens?: number;
  maxContextTokens?: number;
  totalCostUsd?: number;
  totalCachedTokens?: number;
  isBusy?: boolean;
  isCompact?: boolean;
  columns?: number;
  maxTurns?: number;
  maxingMode?: boolean;
}

function getContextBar(pct: number, width: number = 8): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

export function resolveMaxContext(model: string, explicitMax?: number): number {
  return ModelRegistry.resolveModelContextWindow(model, explicitMax);
}

/**
 * Fetches git branch and dirty-state asynchronously.
 * Returns a cleanup function to abort in-flight calls.
 */
function fetchGitInfo(cwd: string, callback: (info: string) => void): () => void {
  let cancelled = false;

  exec('git branch --show-current', { cwd, timeout: 3000 }, (errBranch, branchOut) => {
    if (cancelled) return;
    if (errBranch) {
      callback('no-git');
      return;
    }
    const branch = branchOut.trim() || 'detached';

    exec('git status --porcelain', { cwd, timeout: 3000 }, (errStatus, statusOut) => {
      if (cancelled) return;
      if (errStatus) {
        callback(branch);
        return;
      }
      callback(statusOut.trim() ? `${branch}*` : branch);
    });
  });

  return () => { cancelled = true; };
}

export function formatTokenCount(num: number): string {
  if (num >= 1_000_000) {
    const val = num / 1_000_000;
    return val >= 10 ? `${val.toFixed(1)}M` : `${val.toFixed(2)}M`;
  }
  if (num >= 1_000) {
    return `${Math.round(num / 1_000)}k`;
  }
  return `${num}`;
}

export const StatusLine: React.FC<StatusLineProps> = ({
  model,
  provider,
  cwd,
  permissionMode,
  totalInputTokens,
  totalOutputTokens,
  contextTokens,
  maxContextTokens,
  totalCostUsd,
  totalCachedTokens,
  isBusy = false,
  isCompact = false,
  columns = 80,
  maxTurns,
  maxingMode = false,
}) => {
  const [gitInfo, setGitInfo] = useState('...');
  const lastCwdRef = useRef(cwd);

  useEffect(() => {
    lastCwdRef.current = cwd;

    // Fetch immediately on mount or cwd change
    let cleanup = fetchGitInfo(cwd, setGitInfo);

    const interval = setInterval(() => {
      cleanup();
      cleanup = fetchGitInfo(lastCwdRef.current, setGitInfo);
    }, GIT_REFRESH_INTERVAL_MS);

    return () => {
      cleanup();
      clearInterval(interval);
    };
  }, [cwd]);

  const totalTokens = totalInputTokens + totalOutputTokens;
  const maxContext = resolveMaxContext(model, maxContextTokens);
  const activeTokens = contextTokens !== undefined ? contextTokens : Math.min(totalInputTokens, maxContext);
  const contextPct = Math.min(100, Math.round((activeTokens / maxContext) * 100));

  const showProvider = columns >= 140;
  const showCache = columns >= 140;
  const showTurns = columns >= 120;
  const showGit = columns >= 105;
  const showContextBar = columns >= 90;

  const barWidth = isCompact || columns < 120 ? 5 : 8;
  const bar = getContextBar(contextPct, barWidth);
  const cost =
    totalCostUsd !== undefined
      ? totalCostUsd
      : (totalInputTokens / 1_000_000) * 3.0 + (totalOutputTokens / 1_000_000) * 15.0;

  const modeColor =
    permissionMode === 'plan'
      ? THEME.colors.warn
      : permissionMode === 'auto'
      ? THEME.colors.ok
      : permissionMode === 'bypassPermissions'
      ? THEME.colors.error
      : THEME.colors.accent;

  const statusLabel = isBusy ? 'running' : 'idle';
  const statusColor = isBusy ? THEME.colors.warn : THEME.colors.ok;

  const modelLimit = columns < 90 ? 10 : columns < 115 ? 14 : columns < 140 ? 18 : 28;
  const displayModel = model.length > modelLimit ? `${model.slice(0, modelLimit - 2)}..` : model;
  const displayGit = gitInfo.length > 10 ? `${gitInfo.slice(0, 8)}..` : gitInfo;

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      paddingX={1}
      marginY={0}
    >
      {/* Left: Status indicator, Model & Context Bar */}
      <Box gap={1} alignItems="center">
        <Text bold color={statusColor} wrap="truncate-end">
          [{statusLabel}]
        </Text>
        <Text color={THEME.colors.border} wrap="truncate-end">{'\u2502'}</Text>
        <Text bold color={THEME.colors.text} wrap="truncate-end">
          {displayModel}
        </Text>
        {showProvider && <Text color={THEME.colors.muted} wrap="truncate-end">({provider})</Text>}
        <Text color={THEME.colors.border} wrap="truncate-end">{'\u2502'}</Text>
        <Text color={THEME.colors.accent} wrap="truncate-end">
          {formatTokenCount(totalTokens)} tok
        </Text>
        <Text color={THEME.colors.border} wrap="truncate-end">{'\u2502'}</Text>
        <Text color={contextPct > 80 ? THEME.colors.warn : THEME.colors.ok} wrap="truncate-end">
          {showContextBar ? `ctx:[${bar}] ${contextPct}%` : `ctx:${contextPct}%`}
        </Text>
        {showCache && totalCachedTokens !== undefined && totalCachedTokens > 0 && (
          <>
            <Text color={THEME.colors.border} wrap="truncate-end">{'\u2502'}</Text>
            <Text color={THEME.colors.statusGood} wrap="truncate-end">
              cache:({formatTokenCount(totalCachedTokens)})
            </Text>
          </>
        )}
      </Box>

      {/* Right: Mode, Cost & Git info */}
      <Box gap={1} alignItems="center">
        {showTurns && maxTurns !== undefined && (
          <>
            <Text bold color={maxTurns <= 0 ? THEME.colors.statusGood : THEME.colors.muted} wrap="truncate-end">
              {maxTurns <= 0 ? 'turns:∞' : `turns:${maxTurns}`}
            </Text>
            <Text color={THEME.colors.border} wrap="truncate-end">{'\u2502'}</Text>
          </>
        )}
        {maxingMode && (
          <>
            <Text bold color="#FF0055" wrap="truncate-end">
              [🚀 MAX]
            </Text>
            <Text color={THEME.colors.border} wrap="truncate-end">{'\u2502'}</Text>
          </>
        )}
        <Text bold color={modeColor} wrap="truncate-end">
          [{permissionMode.toUpperCase()}]
        </Text>
        <Text color={THEME.colors.border} wrap="truncate-end">{'\u2502'}</Text>
        <Text bold color={THEME.colors.ok} wrap="truncate-end">
          ${cost >= 10 ? cost.toFixed(2) : cost.toFixed(3)}
        </Text>
        {showGit && (
          <>
            <Text color={THEME.colors.border} wrap="truncate-end">{'\u2502'}</Text>
            <Text bold color={THEME.colors.primary} wrap="truncate-end">
              git:({displayGit})
            </Text>
          </>
        )}
      </Box>
    </Box>
  );
};

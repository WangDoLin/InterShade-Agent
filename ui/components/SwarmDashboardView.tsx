import React from 'react';
import { Box, Text } from 'ink';
import type { SwarmTask, SwarmProgressEvent } from '../../engine/swarm/SwarmTypes.js';
import { THEME } from '../theme.js';

export interface SwarmDashboardViewProps {
  tasks: SwarmTask[];
  overallStatus?: SwarmProgressEvent['overallStatus'];
  isCompact?: boolean;
  onClose?: () => void;
}

export const SwarmDashboardView: React.FC<SwarmDashboardViewProps> = ({
  tasks,
  overallStatus = 'running',
  isCompact = false,
}) => {
  if (tasks.length === 0) return null;

  if (isCompact) {
    const completedCount = tasks.filter((t) => t.status === 'completed').length;
    const runningTask = tasks.find((t) => t.status === 'running' || t.status === 'verifying');
    return (
      <Box flexDirection="row" alignItems="center" gap={1} paddingLeft={1} marginY={0}>
        <Text bold color="cyan">
          🐝 SWARM ({tasks.length}):
        </Text>
        <Text bold color={overallStatus === 'completed' ? 'green' : 'yellow'}>
          [{overallStatus.toUpperCase()}]
        </Text>
        <Text color={THEME.colors.muted}>
          ({completedCount}/{tasks.length} done)
        </Text>
        {runningTask && (
          <Box flexDirection="row" gap={1}>
            <Text color={THEME.colors.border}>│</Text>
            <Text color={THEME.colors.accent}>
              Active: {runningTask.role} ({runningTask.id})
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  const renderProgressBar = (percent: number, width = 20) => {
    const clamped = Math.max(0, Math.min(100, percent));
    const filledLength = Math.round((clamped / 100) * width);
    const emptyLength = Math.max(0, width - filledLength);

    const filledBar = '█'.repeat(filledLength);
    const emptyBar = '░'.repeat(emptyLength);

    return `[${filledBar}${emptyBar}] ${clamped}%`;
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'backend':
        return { icon: '⚙️', color: 'blue', label: 'Backend Specialist' };
      case 'frontend':
        return { icon: '🎨', color: 'magenta', label: 'Frontend Specialist' };
      case 'architect':
        return { icon: '🏗️', color: 'yellow', label: 'Lead Architect' };
      case 'tester':
        return { icon: '🧪', color: 'green', label: 'Test Specialist' };
      case 'reviewer':
        return { icon: '🔍', color: 'cyan', label: 'Code Reviewer' };
      default:
        return { icon: '🤖', color: 'white', label: 'Worker Agent' };
    }
  };

  const getStatusColor = (status: SwarmTask['status']) => {
    switch (status) {
      case 'completed':
        return 'green';
      case 'failed':
        return 'red';
      case 'running':
      case 'verifying':
        return 'cyan';
      default:
        return 'yellow';
    }
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={overallStatus === 'completed' ? 'green' : 'cyan'}
      paddingX={1}
      marginY={1}
    >
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text bold color="cyan">
          🐝 InterShader Swarm Active Dashboard ({tasks.length} Sessions)
        </Text>
        <Text color={overallStatus === 'completed' ? 'green' : 'yellow'} bold>
          [{overallStatus.toUpperCase()}]
        </Text>
      </Box>

      {tasks.map((task, idx) => {
        const badge = getRoleBadge(task.role);
        const statusColor = getStatusColor(task.status);

        return (
          <Box
            key={task.id || idx}
            flexDirection="column"
            marginBottom={1}
            paddingLeft={1}
            borderStyle="single"
            borderColor="gray"
          >
            <Box flexDirection="row" alignItems="center">
              <Text bold color={badge.color as any}>
                {badge.icon} [Session #{idx + 1} - {badge.label}]
              </Text>
              <Text color="gray"> ({task.id})</Text>
              <Text bold color={statusColor}>
                {' '}
                - {task.status.toUpperCase()}
              </Text>
            </Box>

            <Box flexDirection="row">
              <Text color="gray">  Prompt: </Text>
              <Text italic>
                "{task.prompt.length > 70 ? task.prompt.slice(0, 67) + '...' : task.prompt}"
              </Text>
            </Box>

            <Box flexDirection="row" alignItems="center" marginTop={0}>
              <Text color="gray">  Progress: </Text>
              <Text bold color={statusColor}>
                {renderProgressBar(task.progressPercent)}
              </Text>
              {task.currentTool && (
                <Text color="yellow"> | Tool: {task.currentTool}</Text>
              )}
            </Box>

            <Box flexDirection="row" marginTop={0}>
              {task.branch && (
                <Text color="gray">
                  {'  '}Branch: <Text color="magenta">{task.branch}</Text>
                </Text>
              )}
              {task.leasedFiles.length > 0 && (
                <Text color="gray">
                  {' | '}Locks: <Text color="yellow">{task.leasedFiles.join(', ')}</Text>
                </Text>
              )}
            </Box>

            {task.errorMessage && (
              <Box flexDirection="row">
                <Text color="red">  Error: {task.errorMessage}</Text>
              </Box>
            )}

            {task.resultSummary && task.status === 'completed' && (
              <Box flexDirection="row">
                <Text color="green">
                  {'  '}Result: {task.resultSummary.slice(0, 80)}...
                </Text>
              </Box>
            )}
          </Box>
        );
      })}

      <Box flexDirection="row" justifyContent="space-between" marginTop={0}>
        <Text color="gray">
          Hotkeys: [Tab] Switch Panes | [Esc] Close Deck | [Ctrl+C] Abort Swarm
        </Text>
        <Text color="gray">Conflict Prevention: Worktree + Scope Lease Active</Text>
      </Box>
    </Box>
  );
};

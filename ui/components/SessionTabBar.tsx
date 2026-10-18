import React from 'react';
import { Box, Text } from 'ink';
import type { SessionTab } from '../../engine/swarm/MultiSessionPool.js';

export interface SessionTabBarProps {
  tabs: SessionTab[];
  activeTabId: string;
  onSelectTab?: (tabId: string) => void;
}

export const SessionTabBar: React.FC<SessionTabBarProps> = ({ tabs, activeTabId }) => {
  // Only render tab bar if there are at least 2 tabs, or if user explicitly created tabs
  if (!tabs || tabs.length <= 1) {
    return null;
  }

  return (
    <Box flexDirection="column" marginY={0} paddingX={1} borderStyle="single" borderColor="gray">
      <Box flexDirection="row" alignItems="center">
        <Text color="cyan" bold>
          📑 SESSIONS ({tabs.length}):{' '}
        </Text>
        <Box flexDirection="row" gap={1}>
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTabId;
            const tabNum = index + 1;
            const isRunning = tab.status === 'running';
            const hasUnread = tab.unreadOutputs > 0;

            let statusLabel = '';
            if (isRunning) {
              statusLabel = ' ⠋';
            } else if (hasUnread) {
              statusLabel = ` *(${tab.unreadOutputs})`;
            }

            if (isActive) {
              return (
                <Box key={tab.id} paddingX={1}>
                  <Text color="black" backgroundColor="cyan" bold>
                    {tabNum}: {tab.title}
                    {statusLabel}
                  </Text>
                </Box>
              );
            }

            return (
              <Box key={tab.id} paddingX={1}>
                <Text color={isRunning ? 'yellow' : hasUnread ? 'magenta' : 'gray'}>
                  {tabNum}: {tab.title}
                  {statusLabel}
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>

      <Box flexDirection="row" marginTop={0}>
        <Text dimColor color="gray" wrap="truncate-end">
          Phím tắt: Alt+1..{Math.min(9, tabs.length)}: Chuyển tab | /tab new &lt;tên&gt; | /tab merge | /tab close
        </Text>
      </Box>
    </Box>
  );
};

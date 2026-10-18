import React from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { THEME } from '../theme.js';

export interface ToolProgressBlockProps {
  currentToolName: string | null;
  progressText: string | null;
  isStreamingText: boolean;
}

export const ToolProgressBlock: React.FC<ToolProgressBlockProps> = ({
  currentToolName,
  progressText,
  isStreamingText,
}) => {
  if (!currentToolName && !isStreamingText && !progressText) {
    return null;
  }

  const cleanProgress = progressText
    ? progressText.replace(/\s+/g, ' ').trim()
    : null;

  return (
    <Box flexDirection="column" paddingLeft={1} marginY={0}>
      <Box flexDirection="row" alignItems="center">
        <Text color={THEME.colors.muted}>├─ </Text>
        <Text color={THEME.colors.accent}>
          <Spinner type="dots" />{' '}
        </Text>
        {currentToolName && (
          <Text bold color={THEME.colors.accent}>
            Running Tool: <Text color={THEME.colors.text}>{currentToolName}</Text>
          </Text>
        )}
        {isStreamingText && !currentToolName && (
          <Text bold color={THEME.colors.primary}>
            {THEME.brand.name} is formulating thought and response...
          </Text>
        )}
      </Box>

      {cleanProgress && (
        <Box marginTop={0} paddingLeft={3}>
          <Text color={THEME.colors.muted}>
            └─ {cleanProgress.length > 80 ? `${cleanProgress.slice(0, 77)}...` : cleanProgress}
          </Text>
        </Box>
      )}
    </Box>
  );
};

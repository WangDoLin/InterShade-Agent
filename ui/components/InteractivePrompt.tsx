import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TerminalTextInput } from './TerminalTextInput.js';
import { t } from '../../services/i18n/index.js';
import type { SlashCommand } from '../../cli/commands/types.js';
import { CommandAutocomplete } from './CommandAutocomplete.js';
import { SwarmCoordinator } from '../../engine/swarm/SwarmCoordinator.js';
import type { SwarmRole } from '../../engine/swarm/SwarmTypes.js';
import { THEME } from '../theme.js';

export interface InteractivePromptProps {
  onSubmit: (value: string) => void;
  onSubmitSwarm?: (prompts: Array<{ prompt: string; role: SwarmRole }>) => void;
  onAbort?: () => void;
  onClearQueue?: () => void;
  disabled?: boolean;
  isBusy?: boolean;
  isCompact?: boolean;
  queuedPrompt?: string | null;
  focus?: boolean;
  availableCommands?: SlashCommand[];
}

interface PromptSlot {
  id: string;
  text: string;
  role: SwarmRole;
}

export const InteractivePrompt: React.FC<InteractivePromptProps> = ({
  onSubmit,
  onSubmitSwarm,
  onAbort,
  onClearQueue,
  disabled = false,
  isBusy = false,
  isCompact = false,
  queuedPrompt = null,
  focus,
  availableCommands = [],
}) => {
  const [slots, setSlots] = useState<PromptSlot[]>([
    { id: 'slot-1', text: '', role: 'general' },
  ]);
  const [activeSlotIndex, setActiveSlotIndex] = useState(0);

  // Global keyboard shortcut listener for Multi-Session Slot Navigation
  useInput(
    (input, key) => {
      if (disabled || isBusy) return;

      // Ctrl+N (ASCII 14 / '\x0e'): Add an extra prompt box for another concurrent session!
      if (input === '\x0e') {
        setSlots((prev) => {
          if (prev.length >= 4) return prev; // max 4 parallel session slots
          const newId = `slot-${Date.now().toString(36).slice(-4)}`;
          const next: PromptSlot[] = [...prev, { id: newId, text: '', role: 'general' }];
          setActiveSlotIndex(next.length - 1);
          return next;
        });
        return;
      }

      // Tab: Switch focus between session prompt boxes
      if (key.tab && slots.length > 1) {
        setActiveSlotIndex((idx) => (idx + 1) % slots.length);
        return;
      }

      // Escape: If multiple slots exist and current slot is empty, remove it
      if (key.escape) {
        if (slots.length > 1 && !slots[activeSlotIndex]?.text) {
          setSlots((prev) => {
            const next = prev.filter((_, i) => i !== activeSlotIndex);
            setActiveSlotIndex(Math.max(0, activeSlotIndex - 1));
            return next;
          });
          return;
        }
      }
    },
    { isActive: !disabled && !isBusy }
  );

  const handleSlotChange = (newText: string, index: number) => {
    setSlots((prev) => {
      const next = [...prev];
      const inferred = SwarmCoordinator.inferRoleAndScope(newText);
      next[index] = {
        ...next[index],
        text: newText,
        role: inferred.role,
      };
      return next;
    });
  };

  const handleSubmit = (submittedText: string, index: number) => {
    if (disabled) return;

    const updatedSlots = slots.map((s, i) => (i === index ? { ...s, text: submittedText } : s));
    const validSlots = updatedSlots.filter((s) => s.text.trim().length > 0);

    if (validSlots.length > 1 && onSubmitSwarm) {
      // Dispatch multi-session parallel swarm execution
      onSubmitSwarm(
        validSlots.map((s) => ({
          prompt: s.text.trim(),
          role: s.role,
        }))
      );
      setSlots([{ id: 'slot-1', text: '', role: 'general' }]);
      setActiveSlotIndex(0);
    } else if (validSlots.length >= 1) {
      // Normal single session prompt execution
      const singleText = validSlots[0].text.trim();
      setSlots([{ id: 'slot-1', text: '', role: 'general' }]);
      setActiveSlotIndex(0);
      onSubmit(singleText);
    }
  };

  const handleUpArrow = () => {
    if (slots.length === 1 && !slots[0].text && queuedPrompt) {
      setSlots([{ id: 'slot-1', text: queuedPrompt, role: 'general' }]);
      if (onClearQueue) {
        onClearQueue();
      }
    }
  };

  const handleEscape = () => {
    if (slots.length > 1) {
      setSlots((prev) => {
        const next = prev.filter((_, i) => i !== activeSlotIndex);
        setActiveSlotIndex(Math.max(0, activeSlotIndex - 1));
        return next;
      });
      return;
    }

    if (!slots[0]?.text && queuedPrompt && onClearQueue) {
      onClearQueue();
      return;
    }
    if (onAbort) {
      onAbort();
    }
  };

  const getRoleBadge = (role: SwarmRole) => {
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
        return { icon: '🤖', color: 'white', label: 'General Worker' };
    }
  };

  const activeSlot = slots[activeSlotIndex] || slots[0];

  return (
    <Box flexDirection="column" marginY={0}>
      {/* Autocomplete suggestion popup when user types '/' in single slot */}
      {slots.length === 1 && (
        <CommandAutocomplete input={activeSlot.text} commands={availableCommands} />
      )}

      {slots.map((slot, index) => {
        const isFocused = index === activeSlotIndex;
        const badge = getRoleBadge(slot.role);
        const borderColor = queuedPrompt
          ? 'yellow'
          : isBusy
          ? 'cyan'
          : isFocused
          ? THEME.colors.accent
          : 'gray';

        return (
          <Box
            key={slot.id}
            flexDirection="column"
            borderStyle="round"
            borderColor={borderColor}
            paddingX={1}
            marginBottom={slots.length > 1 && index < slots.length - 1 ? 1 : 0}
            marginTop={0}
          >
            {/* Header when multiple session slots are open */}
            {slots.length > 1 && (
              <Box flexDirection="row" justifyContent="space-between" marginBottom={0}>
                <Text bold color={badge.color as any}>
                  {badge.icon} [Session #{index + 1} - {badge.label}]
                  {isFocused ? ' ◄ Active Input' : ''}
                </Text>
                <Text color="gray">
                  Slot {index + 1} of {slots.length} (Press Tab to switch)
                </Text>
              </Box>
            )}

            <Box flexDirection="row" alignItems="center">
              <Text bold color={isFocused ? (isBusy ? 'cyan' : THEME.colors.accent) : 'gray'}>
                {THEME.brand.promptSymbol}{' '}
              </Text>
              <TerminalTextInput
                value={slot.text}
                onChange={(txt) => handleSlotChange(txt, index)}
                onSubmit={(txt) => handleSubmit(txt, index)}
                onAbort={onAbort}
                onEscape={handleEscape}
                onUpArrow={handleUpArrow}
                focus={isFocused && (focus !== undefined ? focus : !disabled)}
                placeholder={
                  isBusy
                    ? queuedPrompt
                      ? t('prompt.queuedReplace')
                      : t('prompt.busyPlaceholder')
                    : slots.length > 1
                    ? `Nhập prompt cho Session #${index + 1} (${badge.label})...`
                    : disabled
                    ? t('prompt.submitting')
                    : t('prompt.placeholder')
                }
              />
            </Box>

            {queuedPrompt && slots.length === 1 && (
              <Box marginTop={0}>
                <Text color="yellow" wrap="truncate-end">
                  [Queued next]: &quot;
                  {queuedPrompt.length > 60 ? `${queuedPrompt.slice(0, 57)}...` : queuedPrompt}
                  &quot;
                </Text>
              </Box>
            )}

            {isFocused && (!isBusy || queuedPrompt) && !isCompact && (
              <Box marginTop={0}>
                <Text color={THEME.colors.muted} wrap="truncate-end">
                  {slots.length > 1
                    ? '[Tab] Chuyển khung session │ [Ctrl+N] Thêm session │ [Enter] Chạy song song │ [Esc] Hủy khung'
                    : isBusy
                    ? '[Up Arrow] Edit queue │ [Esc] Delete queue │ [Enter] Replace │ [Ctrl+C] Stop agent'
                    : '[Enter] Gửi │ [Ctrl+N] Thêm khung session khác │ [/swarm] Swarm │ [/help] Lệnh'}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
};

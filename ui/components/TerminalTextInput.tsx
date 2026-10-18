import React, { useState, useEffect, useRef } from 'react';
import { Text, useInput } from 'ink';

export interface TerminalTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: (value: string) => void;
  onAbort?: () => void;
  onEscape?: () => void;
  onUpArrow?: () => void;
  placeholder?: string;
  focus?: boolean;
  showCursor?: boolean;
}

/**
 * Processes a raw input chunk character-by-character,
 * properly handling embedded backspaces (\x08, \x7F) from Vietnamese IMEs (UniKey, EVKey, Windows IME).
 */
export function processRawTerminalInput(
  currentValue: string,
  currentOffset: number,
  rawInput: string
): { nextValue: string; nextOffset: number } {
  const withoutAnsi = rawInput.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  let val = currentValue;
  let offset = currentOffset;

  for (let i = 0; i < withoutAnsi.length; i++) {
    const char = withoutAnsi[i];
    const code = char.charCodeAt(0);

    if (code === 8 || code === 127) {
      if (offset > 0) {
        val = val.slice(0, offset - 1) + val.slice(offset);
        offset = offset - 1;
      }
    } else if (code >= 32) {
      val = val.slice(0, offset) + char + val.slice(offset);
      offset = offset + 1;
    }
  }

  return { nextValue: val, nextOffset: offset };
}

export const TerminalTextInput: React.FC<TerminalTextInputProps> = ({
  value,
  onChange,
  onSubmit,
  onAbort,
  onEscape,
  onUpArrow,
  placeholder = '',
  focus = true,
  showCursor = true,
}) => {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const valueRef = useRef(value);
  const cursorOffsetRef = useRef(cursorOffset);

  // Keep refs synchronized immediately on every render/prop change to prevent stale closures
  valueRef.current = value;
  cursorOffsetRef.current = Math.max(0, Math.min(cursorOffset, value.length));

  // Keep cursor strictly clamped to valid string bounds whenever value changes
  useEffect(() => {
    setCursorOffset((prev) => Math.max(0, Math.min(prev, value.length)));
  }, [value]);

  const updateValueAndCursor = (nextVal: string, nextOffset: number) => {
    valueRef.current = nextVal;
    cursorOffsetRef.current = nextOffset;
    onChange(nextVal);
    setCursorOffset(nextOffset);
  };

  useInput(
    (input, key) => {
      // Ignore down arrow navigation
      if (key.downArrow) {
        return;
      }

      // Up arrow navigation (e.g. edit queue or command history)
      if (key.upArrow || input === '\x1b[A') {
        if (onUpArrow) {
          onUpArrow();
        }
        return;
      }

      // Exit / Abort combo (Ctrl+C)
      if (key.ctrl && input === 'c') {
        if (onAbort) {
          onAbort();
        }
        return;
      }

      // Escape key (clear input, clear queue, or abort)
      if (key.escape || (input === '\x1b' && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow)) {
        if (valueRef.current.length > 0) {
          updateValueAndCursor('', 0);
          return;
        }
        if (onEscape) {
          onEscape();
          return;
        }
        if (onAbort) {
          onAbort();
          return;
        }
        return;
      }

      // Submit: Comprehensive Enter detection across Windows PowerShell, Linux, and macOS
      const isEnter =
        Boolean(key.return) ||
        (key as any).name === 'enter' ||
        input === '\r' ||
        input === '\n' ||
        input === '\r\n';

      if (isEnter) {
        if (onSubmit) {
          onSubmit(valueRef.current);
        }
        return;
      }

      // Left arrow
      if (key.leftArrow || input === '\x1b[D') {
        const next = Math.max(0, cursorOffsetRef.current - 1);
        cursorOffsetRef.current = next;
        setCursorOffset(next);
        return;
      }

      // Right arrow
      if (key.rightArrow || input === '\x1b[C') {
        const next = Math.min(valueRef.current.length, cursorOffsetRef.current + 1);
        cursorOffsetRef.current = next;
        setCursorOffset(next);
        return;
      }

      // Home key (Ctrl+A or terminal home escape)
      if ((key.ctrl && input === 'a') || input === '\x1b[H' || input === '\x1b[1~') {
        cursorOffsetRef.current = 0;
        setCursorOffset(0);
        return;
      }

      // End key (Ctrl+E or terminal end escape)
      if ((key.ctrl && input === 'e') || input === '\x1b[F' || input === '\x1b[4~') {
        const next = valueRef.current.length;
        cursorOffsetRef.current = next;
        setCursorOffset(next);
        return;
      }

      // Clear entire line (Ctrl+U)
      if (key.ctrl && input === 'u') {
        updateValueAndCursor('', 0);
        return;
      }

      // Delete previous word (Ctrl+W)
      if (key.ctrl && input === 'w') {
        const off = cursorOffsetRef.current;
        const cur = valueRef.current;
        if (off > 0) {
          const before = cur.slice(0, off);
          const trimmedBefore = before.replace(/\s+$/, '');
          const lastSpace = trimmedBefore.lastIndexOf(' ');
          const cutIndex = lastSpace === -1 ? 0 : lastSpace + 1;
          const nextVal = cur.slice(0, cutIndex) + cur.slice(off);
          updateValueAndCursor(nextVal, cutIndex);
        }
        return;
      }

      // Delete to end of line (Ctrl+K)
      if (key.ctrl && input === 'k') {
        const off = cursorOffsetRef.current;
        const cur = valueRef.current;
        updateValueAndCursor(cur.slice(0, off), off);
        return;
      }

      // Physical forward Delete key (\x1b[3~)
      if (input === '\x1b[3~') {
        const off = cursorOffsetRef.current;
        const cur = valueRef.current;
        if (off < cur.length) {
          const nextVal = cur.slice(0, off) + cur.slice(off + 1);
          updateValueAndCursor(nextVal, off);
        }
        return;
      }

      // Tab completion / formatting
      if (key.tab) {
        return;
      }

      // Single standalone Backspace or Delete
      if (key.backspace || key.delete || input === '\x08' || input === '\x7F') {
        const off = cursorOffsetRef.current;
        const cur = valueRef.current;
        if (off > 0) {
          const nextVal = cur.slice(0, off - 1) + cur.slice(off);
          updateValueAndCursor(nextVal, off - 1);
        }
        return;
      }

      // Regular text input and Vietnamese IME composition sequences
      // (Handles chunks where IME combines Backspace \x08 with replacement Unicode characters)
      const { nextValue, nextOffset } = processRawTerminalInput(
        valueRef.current,
        cursorOffsetRef.current,
        input
      );

      if (nextValue !== valueRef.current || nextOffset !== cursorOffsetRef.current) {
        updateValueAndCursor(nextValue, nextOffset);
      }
    },
    { isActive: focus }
  );


  // If input is empty and placeholder exists
  if (value.length === 0) {
    if (!focus || !showCursor) {
      return <Text color="gray" wrap="truncate-end">{placeholder}</Text>;
    }

    if (placeholder.length > 0) {
      return (
        <Text color="gray" wrap="truncate-end">
          <Text inverse>{placeholder[0]}</Text>
          {placeholder.slice(1)}
        </Text>
      );
    }

    return <Text inverse>{' '}</Text>;
  }

  // If cursor is disabled or input not focused
  if (!focus || !showCursor) {
    return <Text wrap="truncate-end">{value}</Text>;
  }

  // Render text with inverted cursor block at cursorOffset
  const safeOffset = Math.max(0, Math.min(cursorOffset, value.length));

  if (safeOffset < value.length) {
    return (
      <Text wrap="truncate-end">
        {value.slice(0, safeOffset)}
        <Text inverse>{value[safeOffset]}</Text>
        {value.slice(safeOffset + 1)}
      </Text>
    );
  }

  // Cursor is at the end of the text
  return (
    <Text wrap="truncate-end">
      {value}
      <Text inverse>{' '}</Text>
    </Text>
  );
};

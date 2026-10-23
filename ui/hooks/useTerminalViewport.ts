import { useState, useEffect } from 'react';
import { TerminalMouseManager } from '../services/TerminalMouseManager.js';

export interface TerminalViewportState {
  readonly rows: number;
  readonly columns: number;
  readonly isCompact: boolean;
}

/**
 * Manages terminal resize events, compact height budget calculation,
 * and TerminalMouseManager lifecycle (UI-010).
 */
export function useTerminalViewport(isBusy: boolean): TerminalViewportState {
  useEffect(() => {
    const mouseMgr = TerminalMouseManager.getInstance();
    mouseMgr.enable();
    return () => {
      mouseMgr.disable();
    };
  }, []);

  const [terminalDimensions, setTerminalDimensions] = useState(() => ({
    rows: process.stdout.rows || 24,
    columns: process.stdout.columns || 80,
  }));

  useEffect(() => {
    const handleResize = () => {
      setTerminalDimensions({
        rows: process.stdout.rows || 24,
        columns: process.stdout.columns || 80,
      });
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, []);

  const isCompact = isBusy || terminalDimensions.rows < 25;

  return {
    rows: terminalDimensions.rows,
    columns: terminalDimensions.columns,
    isCompact,
  };
}

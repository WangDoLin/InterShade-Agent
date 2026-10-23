import { useState, useEffect, useMemo, useRef } from 'react';
import { MultiSessionPool, type SessionTab } from '../../engine/swarm/MultiSessionPool.js';
import type { QueryEngine } from '../../orchestrator/QueryEngine.js';

export interface MultiSessionTabsHook {
  readonly sessionTabs: SessionTab[];
  readonly activeTabId: string;
  readonly activeTab: SessionTab;
  readonly activeEngine: QueryEngine;
}

/**
 * Subscribes to MultiSessionPool tab lifecycle events and tracks the active QueryEngine (UI-010).
 */
export function useMultiSessionTabs(
  primaryEngine: QueryEngine,
  onTabSwitched: (tab: SessionTab) => void
): MultiSessionTabsHook {
  const onTabSwitchedRef = useRef(onTabSwitched);
  onTabSwitchedRef.current = onTabSwitched;

  const [sessionTabs, setSessionTabs] = useState<SessionTab[]>(() => {
    const pool = MultiSessionPool.getInstance();
    pool.initPrimary(primaryEngine);
    return pool.getTabs();
  });

  const [activeTabId, setActiveTabId] = useState<string>(() => {
    return MultiSessionPool.getInstance().getActiveTab().id;
  });

  const activeTab = useMemo(() => {
    const pool = MultiSessionPool.getInstance();
    return pool.getTabs().find((t) => t.id === activeTabId) || pool.getTabs()[0];
  }, [activeTabId, sessionTabs]);

  const activeEngine = activeTab ? activeTab.queryEngine : primaryEngine;

  useEffect(() => {
    const pool = MultiSessionPool.getInstance();
    const handleTabSwitched = (tab: SessionTab) => {
      setActiveTabId(tab.id);
      setSessionTabs([...pool.getTabs()]);
      onTabSwitchedRef.current(tab);
    };

    const handleTabsChanged = () => {
      setSessionTabs([...pool.getTabs()]);
    };

    pool.on('tab_switched', handleTabSwitched);
    pool.on('tab_created', handleTabsChanged);
    pool.on('tab_updated', handleTabsChanged);
    pool.on('tab_progress', handleTabsChanged);
    pool.on('tab_closed', handleTabsChanged);

    return () => {
      pool.off('tab_switched', handleTabSwitched);
      pool.off('tab_created', handleTabsChanged);
      pool.off('tab_updated', handleTabsChanged);
      pool.off('tab_progress', handleTabsChanged);
      pool.off('tab_closed', handleTabsChanged);
    };
  }, []);

  return {
    sessionTabs,
    activeTabId,
    activeTab,
    activeEngine,
  };
}

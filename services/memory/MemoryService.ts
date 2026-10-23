import path from 'path';
import fs from 'fs';
import {
  FtsMemoryService,
  type MemoryEntry,
  type FtsSearchOptions,
  type FtsSearchResult,
} from './FtsMemoryService.js';

export type { MemoryEntry, FtsSearchOptions, FtsSearchResult };

/**
 * Unified MemoryService facade delegating storage, retrieval, and BM25 FTS5 search
 * to FtsMemoryService (SVC-MEM-01).
 */
export class MemoryService {
  static recordMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): MemoryEntry {
    return FtsMemoryService.recordMemory(entry);
  }

  static getMemoriesForProject(projectId: string): MemoryEntry[] {
    return FtsMemoryService.getMemoriesForProject(projectId);
  }

  static searchMemories(query: string, options: FtsSearchOptions = {}): FtsSearchResult[] {
    return FtsMemoryService.searchMemories(query, options);
  }

  /**
   * Formats project memories into a concise Markdown section for LLM context injection
   */
  static formatMemoriesForContext(projectId: string, currentGoal?: string): string {
    const entries = currentGoal
      ? FtsMemoryService.searchMemories(currentGoal, { projectId, limit: 5 })
      : this.getMemoriesForProject(projectId);
    const resolvedEntries = entries.length > 0 ? entries : this.getMemoriesForProject(projectId);
    if (resolvedEntries.length === 0) {
      return '';
    }

    const lines = [
      '# Project Durable Memories & Architectural Lessons',
      'The following guidelines and lessons were recorded from previous tasks in this codebase:',
    ];

    for (const mem of resolvedEntries) {
      lines.push(`- [${mem.type.toUpperCase()}] ${mem.title}: ${mem.content}`);
    }

    return lines.join('\n');
  }

  /**
   * Exports project memories to a local markdown file (.intershader/session-memory.md)
   */
  static exportToMarkdown(cwd: string, projectId: string): string {
    const targetDir = path.join(cwd, '.intershader');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const filePath = path.join(targetDir, 'session-memory.md');
    const content = this.formatMemoriesForContext(projectId);
    fs.writeFileSync(filePath, content || '# No memories recorded yet.\n', 'utf-8');

    return filePath;
  }
}

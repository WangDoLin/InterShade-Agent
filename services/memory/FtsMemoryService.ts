import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { getDatabase, foldVietnameseText } from '../../state/Database.js';
import { SecretScrubber } from '../../security/SecretScrubber.js';

export interface MemoryEntry {
  id: string;
  sessionId?: string;
  projectId: string;
  type: 'decision' | 'lesson' | 'architecture' | 'bug_pattern' | 'skill';
  title: string;
  content: string;
  createdAt: number;
}

export interface FtsSearchResult extends MemoryEntry {
  rank: number;
  snippet: string;
}

export interface FtsSearchOptions {
  projectId?: string;
  type?: string;
  limit?: number;
}

const RRF_K = 60;
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'how', 'what', 'when', 'where', 'why', 'who',
  'trong', 'cua', 'cho', 'voi', 'nhu', 'the', 'nao', 'khi', 'tai', 'sao', 'cac', 'nhung', 'mot',
]);

export class FtsMemoryService {
  /**
   * Save a durable memory record to SQLite WAL database and FTS5 virtual table.
   * Automatically scrubs secrets (NEXT-B-08) and populates Vietnamese folded columns (NEXT-C-09).
   */
  static recordMemory(entry: Omit<MemoryEntry, 'id' | 'createdAt'>): MemoryEntry {
    const db = getDatabase();
    const id = randomUUID();
    const createdAt = Date.now();

    const safeTitle = SecretScrubber.scrub(entry.title).text;
    const safeContent = SecretScrubber.scrub(entry.content).text;
    const titleFolded = foldVietnameseText(safeTitle);
    const contentFolded = foldVietnameseText(safeContent);

    const stmt = db.prepare(`
      INSERT INTO memories (
        id, session_id, project_id, type, title, content, title_folded, content_folded, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      entry.sessionId || null,
      entry.projectId,
      entry.type,
      safeTitle,
      safeContent,
      titleFolded,
      contentFolded,
      createdAt
    );

    return {
      id,
      ...entry,
      title: safeTitle,
      content: safeContent,
      createdAt,
    };
  }

  /**
   * Sanitize search term for SQLite FTS5 syntax
   */
  private static sanitizeFtsQuery(query: string, columnFilter?: string): string {
    const cleaned = query
      .replace(/['"“”‘’]/g, ' ')
      .replace(/[*+\-^:(){}[\]\\/.,;?!@#$%&~`|<>]/g, ' ')
      .trim();

    const rawTokens = cleaned
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 1);

    const filteredTokens = rawTokens.filter((t) => !STOP_WORDS.has(t.toLowerCase()));
    const activeTokens = filteredTokens.length > 0 ? filteredTokens : rawTokens;

    const tokens = activeTokens.map((t) =>
      columnFilter ? `${columnFilter} : "${t}"*` : `"${t}"*`
    );

    return tokens.length > 0 ? tokens.join(' OR ') : '""';
  }

  /**
   * Dual-path full-text search (exact Unicode + Vietnamese diacritic-folded)
   * combined via Reciprocal Rank Fusion (RRF, k=60) and calibrated BM25 weights (NEXT-C-08..10).
   */
  static searchMemories(query: string, options: FtsSearchOptions = {}): FtsSearchResult[] {
    const db = getDatabase();
    const limit = options.limit || 10;
    const exactQuery = this.sanitizeFtsQuery(query, '{title content type}');
    const foldedText = foldVietnameseText(query);
    const foldedQuery = this.sanitizeFtsQuery(foldedText, '{title_folded content_folded}');

    if (exactQuery === '""' && foldedQuery === '""') {
      return [];
    }

    const executePath = (ftsMatchExpr: string): FtsSearchResult[] => {
      if (ftsMatchExpr === '""') return [];
      let sql = `
        SELECT m.id, m.session_id as sessionId, m.project_id as projectId, m.type, m.title, m.content, m.created_at as createdAt,
               bm25(memories_fts, 0.0, 0.0, 0.0, 1.5, 4.0, 2.0, 3.0, 1.5) as rank,
               snippet(memories_fts, 5, '**', '**', '...', 32) as snippet
        FROM memories_fts f
        JOIN memories m ON m.id = f.id
        WHERE memories_fts MATCH ?
      `;
      const params: any[] = [ftsMatchExpr];

      if (options.projectId) {
        sql += ` AND m.project_id = ?`;
        params.push(options.projectId);
      }

      if (options.type) {
        sql += ` AND m.type = ?`;
        params.push(options.type);
      }

      sql += ` ORDER BY rank ASC LIMIT ?`;
      params.push(Math.max(limit * 3, 20));

      const stmt = db.prepare(sql);
      const rows = stmt.all(...params) as any[];
      return rows.map((r) => ({
        id: r.id,
        sessionId: r.sessionId,
        projectId: r.projectId,
        type: r.type,
        title: r.title,
        content: r.content,
        createdAt: r.createdAt,
        rank: Number(r.rank),
        snippet: r.snippet || r.content.slice(0, 120),
      }));
    };

    try {
      const exactResults = executePath(exactQuery);
      const foldedResults = executePath(foldedQuery);

      // Reciprocal Rank Fusion (RRF) across exact and folded paths
      const fusedMap = new Map<
        string,
        { entry: FtsSearchResult; rrfScore: number; bestBm25: number }
      >();

      exactResults.forEach((item, idx) => {
        const rrf = 1.25 / (RRF_K + idx + 1);
        fusedMap.set(item.id, {
          entry: item,
          rrfScore: rrf,
          bestBm25: item.rank,
        });
      });

      foldedResults.forEach((item, idx) => {
        const rrf = 1.0 / (RRF_K + idx + 1);
        const existing = fusedMap.get(item.id);
        if (existing) {
          existing.rrfScore += rrf;
          if (item.rank < existing.bestBm25) {
            existing.bestBm25 = item.rank;
          }
        } else {
          fusedMap.set(item.id, {
            entry: item,
            rrfScore: rrf,
            bestBm25: item.rank,
          });
        }
      });

      const merged = Array.from(fusedMap.values())
        .sort((a, b) => {
          if (Math.abs(b.rrfScore - a.rrfScore) > 1e-6) {
            return b.rrfScore - a.rrfScore;
          }
          return a.bestBm25 - b.bestBm25;
        })
        .slice(0, limit)
        .map((x) => ({
          ...x.entry,
          // Preserve negative BM25 convention where lower = more relevant
          rank: -Number(x.rrfScore.toFixed(6)),
        }));

      return merged;
    } catch {
      // Fallback to LIKE on both original and folded columns
      let fallbackSql = `
        SELECT id, session_id as sessionId, project_id as projectId, type, title, content, created_at as createdAt,
               0 as rank,
               substr(content, 1, 100) as snippet
        FROM memories
        WHERE (title LIKE ? OR content LIKE ? OR title_folded LIKE ? OR content_folded LIKE ?)
      `;
      const fallbackParams: any[] = [
        `%${query}%`,
        `%${query}%`,
        `%${foldedText}%`,
        `%${foldedText}%`,
      ];

      if (options.projectId) {
        fallbackSql += ` AND project_id = ?`;
        fallbackParams.push(options.projectId);
      }

      if (options.type) {
        fallbackSql += ` AND type = ?`;
        fallbackParams.push(options.type);
      }

      fallbackSql += ` ORDER BY created_at DESC LIMIT ?`;
      fallbackParams.push(limit);

      const stmt = db.prepare(fallbackSql);
      return stmt.all(...fallbackParams) as FtsSearchResult[];
    }
  }

  /**
   * Retrieve all memories for a specific project
   */
  static getMemoriesForProject(projectId: string): MemoryEntry[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT id, session_id as sessionId, project_id as projectId, type, title, content, created_at as createdAt
      FROM memories
      WHERE project_id = ?
      ORDER BY created_at ASC
    `);

    return stmt.all(projectId) as MemoryEntry[];
  }

  /**
   * Prune oldest memories when project memory count exceeds retention limit (NEXT-C-12).
   */
  static pruneOldMemories(projectId: string, maxMemoriesPerProject: number = 1000): number {
    const db = getDatabase();
    const countRow = db
      .prepare('SELECT COUNT(*) as total FROM memories WHERE project_id = ?')
      .get(projectId) as { total: number } | undefined;
    const total = countRow?.total ?? 0;
    if (total <= maxMemoriesPerProject) {
      return 0;
    }

    const toDelete = total - maxMemoriesPerProject;
    const result = db
      .prepare(`
        DELETE FROM memories
        WHERE id IN (
          SELECT id FROM memories
          WHERE project_id = ?
          ORDER BY created_at ASC
          LIMIT ?
        )
      `)
      .run(projectId, toDelete);
    return result.changes;
  }

  /**
   * Format relevant memories into markdown for LLM prompt context injection
   * with strict token budget and automatic secret scrubbing (NEXT-C-14, NEXT-B-08).
   */
  static formatMemoriesForContext(
    projectId: string,
    currentGoal?: string,
    maxTokens: number = 2000
  ): string {
    let entries: MemoryEntry[] = [];

    if (currentGoal) {
      const ftsResults = this.searchMemories(currentGoal, { projectId, limit: 8 });
      if (ftsResults.length > 0) {
        entries = ftsResults;
      }
    }

    if (entries.length === 0) {
      entries = this.getMemoriesForProject(projectId);
    }

    if (entries.length === 0) {
      return '';
    }

    const maxChars = Math.max(256, maxTokens * 4);
    const header = '# Project Durable Memories & Architectural Lessons';
    const lines: string[] = [header];
    let usedChars = header.length;

    for (const mem of entries) {
      const safeTitle = SecretScrubber.scrub(mem.title).text;
      const safeContent = SecretScrubber.scrub(mem.content).text;
      const line = `- [${mem.type.toUpperCase()}] **${safeTitle}**: ${safeContent}`;
      if (usedChars + line.length + 1 > maxChars && lines.length > 1) {
        break;
      }
      lines.push(line);
      usedChars += line.length + 1;
    }

    return lines.join('\n');
  }

  /**
   * Export memories to `.intershader/session-memory.md`
   */
  static exportToMarkdown(workspaceDir: string, projectId: string): string {
    const targetDir = path.join(workspaceDir, '.intershader');
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetFile = path.join(targetDir, 'session-memory.md');
    const content = this.formatMemoriesForContext(projectId);
    fs.writeFileSync(targetFile, content, 'utf-8');

    return targetFile;
  }
}

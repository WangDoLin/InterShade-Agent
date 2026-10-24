import path from 'path';
import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { FtsMemoryService } from '../../services/memory/FtsMemoryService.js';

export interface MemoryRecordInput {
  type?: string;
  category?: string;
  title?: string;
  topic?: string;
  name?: string;
  content?: string;
  summary?: string;
  body?: string;
  tags?: string[];
}

export class MemoryRecordTool extends BaseTool<MemoryRecordInput, string> {
  readonly name = 'memory_record';
  readonly description =
    'Persist a critical architectural decision, bug pattern fix, lesson learned, or project convention into the permanent SQLite FTS5 memory store. Allows the agent and user to remember facts across long sessions.';
  readonly isReadOnly = false;
  readonly isDestructive = false;

  readonly inputSchema = z.object({
    type: z
      .string()
      .optional()
      .describe(
        'Category of memory to record (e.g. decision, lesson, architecture, bug_pattern, skill, convention, gotcha, bug, research)'
      ),
    category: z.string().optional().describe('Alias for type'),
    title: z.string().optional().describe('Short descriptive title summarizing the decision or insight'),
    topic: z.string().optional().describe('Alias for title'),
    name: z.string().optional().describe('Alias for title'),
    content: z
      .string()
      .optional()
      .describe('Detailed content, code invariant, rule, or explanation to remember permanently'),
    summary: z.string().optional().describe('Alias for content'),
    body: z.string().optional().describe('Alias for content'),
    tags: z.array(z.string()).optional().describe('Optional tags for indexing'),
  });

  async execute(args: MemoryRecordInput, context: ToolExecutionContext): Promise<string> {
    const projectId = path.basename(context.cwd) || 'default-project';

    // Normalize type with resilient fallback
    const rawType = (args.type || args.category || 'decision').toLowerCase();
    let normType: 'decision' | 'lesson' | 'architecture' | 'bug_pattern' | 'skill' = 'decision';
    if (rawType.includes('bug') || rawType.includes('defect') || rawType.includes('fix')) {
      normType = 'bug_pattern';
    } else if (rawType.includes('arch') || rawType.includes('design') || rawType.includes('struct')) {
      normType = 'architecture';
    } else if (rawType.includes('skill') || rawType.includes('tool') || rawType.includes('prompt')) {
      normType = 'skill';
    } else if (
      rawType.includes('lesson') ||
      rawType.includes('gotcha') ||
      rawType.includes('learn') ||
      rawType.includes('research') ||
      rawType.includes('note')
    ) {
      normType = 'lesson';
    } else {
      normType = 'decision';
    }

    const title = (args.title || args.topic || args.name || args.summary || 'Unspecified Memory Item').trim();
    const content = (args.content || args.body || args.summary || title).trim();

    const recorded = FtsMemoryService.recordMemory({
      projectId,
      sessionId: context.sessionId,
      type: normType,
      title,
      content,
    });

    return [
      `[Memory Recorded Successfully]:`,
      `- ID: ${recorded.id}`,
      `- Type: [${recorded.type.toUpperCase()}] (derived from "${rawType}")`,
      `- Title: "${recorded.title}"`,
      `- Project: ${projectId}`,
      `This memory is now permanently indexed in SQLite FTS5 BM25 and will automatically assist future prompts.`,
    ].join('\n');
  }
}

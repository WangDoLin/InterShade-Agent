import path from 'path';
import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { FtsMemoryService } from '../../services/memory/FtsMemoryService.js';

export interface MemoryRecordInput {
  type?: string;
  category?: string;
  kind?: string;
  title?: string;
  topic?: string;
  name?: string;
  key?: string;
  heading?: string;
  subject?: string;
  content?: unknown;
  summary?: unknown;
  body?: unknown;
  text?: unknown;
  description?: unknown;
  details?: unknown;
  note?: unknown;
  notes?: unknown;
  data?: unknown;
  value?: unknown;
  val?: unknown;
  insight?: unknown;
  tags?: string[] | string | unknown;
  [key: string]: unknown;
}

export class MemoryRecordTool extends BaseTool<MemoryRecordInput, string> {
  readonly name = 'memory_record';
  readonly description =
    'Persist a critical architectural decision, bug pattern fix, lesson learned, or project convention into the permanent SQLite FTS5 memory store. Allows the agent and user to remember facts across long sessions.';
  readonly isReadOnly = false;
  readonly isDestructive = false;

  readonly inputSchema = z
    .object({
      type: z
        .any()
        .optional()
        .describe(
          'Category of memory to record (e.g. decision, lesson, architecture, bug_pattern, skill, convention, gotcha, bug, research)'
        ),
      category: z.any().optional().describe('Alias for type'),
      kind: z.any().optional().describe('Alias for type'),
      title: z.any().optional().describe('Short descriptive title summarizing the decision or insight'),
      topic: z.any().optional().describe('Alias for title'),
      name: z.any().optional().describe('Alias for title'),
      key: z.any().optional().describe('Alias for title'),
      heading: z.any().optional().describe('Alias for title'),
      subject: z.any().optional().describe('Alias for title'),
      content: z
        .any()
        .optional()
        .describe('Detailed content, code invariant, rule, or explanation to remember permanently'),
      summary: z.any().optional().describe('Alias for content'),
      body: z.any().optional().describe('Alias for content'),
      text: z.any().optional().describe('Alias for content'),
      description: z.any().optional().describe('Alias for content'),
      details: z.any().optional().describe('Alias for content'),
      note: z.any().optional().describe('Alias for content'),
      notes: z.any().optional().describe('Alias for content'),
      data: z.any().optional().describe('Alias for content'),
      value: z.any().optional().describe('Alias for content'),
      val: z.any().optional().describe('Alias for content'),
      insight: z.any().optional().describe('Alias for content'),
      tags: z.union([z.array(z.any()), z.string(), z.number()]).optional().describe('Optional tags for indexing'),
    })
    .passthrough();

  async execute(args: MemoryRecordInput, context: ToolExecutionContext): Promise<string> {
    const projectId = path.basename(context.cwd) || 'default-project';

    // Normalize type with resilient fallback
    const rawTypeVal = args.type ?? args.category ?? args.kind ?? 'decision';
    const rawType = String(rawTypeVal).toLowerCase();
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

    const rawTitle =
      args.title ??
      args.topic ??
      args.name ??
      args.key ??
      args.heading ??
      args.subject ??
      args.summary ??
      'Unspecified Memory Item';
    const title = (
      typeof rawTitle === 'object' && rawTitle !== null ? JSON.stringify(rawTitle) : String(rawTitle)
    ).trim();

    const rawContent =
      args.content ??
      args.body ??
      args.text ??
      args.description ??
      args.details ??
      args.note ??
      args.notes ??
      args.data ??
      args.value ??
      args.val ??
      args.insight ??
      args.summary ??
      title;
    const content = (
      typeof rawContent === 'object' && rawContent !== null
        ? JSON.stringify(rawContent, null, 2)
        : String(rawContent)
    ).trim();

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

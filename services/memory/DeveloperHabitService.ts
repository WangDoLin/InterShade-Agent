import { FtsMemoryService } from './FtsMemoryService.js';

export interface DetectedHabit {
  category: string;
  preference: string;
  directive: string;
}

export class DeveloperHabitService {
  /**
   * Scans user prompt for explicit developer conventions, rules, and preferences.
   * If detected, persists them into SQLite FTS5 Memory for lifelong recall.
   */
  static detectAndPersistHabit(
    userPrompt: string,
    projectId: string,
    sessionId?: string
  ): DetectedHabit | null {
    const text = userPrompt.toLowerCase().trim();

    return (
      this.detectLanguageHabit(text, projectId, sessionId) ||
      this.detectStylingHabit(text, projectId, sessionId) ||
      this.detectTestingHabit(text, projectId, sessionId) ||
      this.detectEnvironmentHabit(text, userPrompt, projectId, sessionId) ||
      this.detectModern2026Habit(text, projectId, sessionId)
    );
  }

  private static detectLanguageHabit(text: string, projectId: string, sessionId?: string): DetectedHabit | null {
    if (text.includes('tiếng việt') || text.includes('tieng viet') || text.includes('vietnamese')) {
      return this.recordHabit(
        projectId,
        sessionId,
        'Language Preference',
        'Developer communicates strictly in Vietnamese. All thoughts, explanations, and commit notes must be in natural Vietnamese.',
        'Vietnamese Language Standard'
      );
    }
    return null;
  }

  private static detectStylingHabit(text: string, projectId: string, sessionId?: string): DetectedHabit | null {
    if (text.includes('không dùng tailwind') || text.includes('no tailwind') || text.includes('vanilla css')) {
      return this.recordHabit(
        projectId,
        sessionId,
        'Frontend Styling Invariant',
        'Do not use Tailwind CSS. Prefer standard Vanilla CSS with custom properties or CSS Modules.',
        'Styling Framework: Vanilla CSS'
      );
    }
    if (text.includes('dùng tailwind') || text.includes('use tailwind')) {
      return this.recordHabit(
        projectId,
        sessionId,
        'Frontend Styling Invariant',
        'Developer prefers Tailwind CSS utility classes for styling.',
        'Styling Framework: Tailwind CSS'
      );
    }
    return null;
  }

  private static detectTestingHabit(text: string, projectId: string, sessionId?: string): DetectedHabit | null {
    if (text.includes('dùng vitest') || text.includes('use vitest')) {
      return this.recordHabit(
        projectId,
        sessionId,
        'Testing Framework Preference',
        'Developer prefers Vitest as the primary test runner over Jest.',
        'Test Framework: Vitest'
      );
    }
    return null;
  }

  private static detectEnvironmentHabit(
    text: string,
    rawPrompt: string,
    projectId: string,
    sessionId?: string
  ): DetectedHabit | null {
    const portMatch = rawPrompt.match(/port\s+(\d{4,5})/i);
    if (portMatch && (text.includes('quy định') || text.includes('luôn') || text.includes('mặc định') || text.includes('always'))) {
      const port = portMatch[1];
      return this.recordHabit(
        projectId,
        sessionId,
        'Server Port Invariant',
        `Always configure development servers to run on port ${port}.`,
        `Fixed Server Port: ${port}`
      );
    }
    return null;
  }

  private static detectModern2026Habit(text: string, projectId: string, sessionId?: string): DetectedHabit | null {
    if (text.includes('uv') || text.includes('pyproject') || text.includes('modern python')) {
      return this.recordHabit(
        projectId,
        sessionId,
        'Modern 2026 Toolchain Invariant',
        'Use uv exclusively for Python dependency management, virtual environments, and fast script execution.',
        'Toolchain: uv Python 2026'
      );
    }
    if (text.includes('alphagenome') || text.includes('encode') || text.includes('biosequence') || text.includes('variant effect')) {
      return this.recordHabit(
        projectId,
        sessionId,
        'Scientific Foundation Model Invariant',
        'Ground all genomic variant scoring and cis-regulatory element annotations using AlphaGenome and ENCODE SCREEN oracles.',
        'Scientific Oracle: AlphaGenome & ENCODE 2026'
      );
    }
    return null;
  }

  private static recordHabit(
    projectId: string,
    sessionId: string | undefined,
    category: string,
    directive: string,
    title: string
  ): DetectedHabit {
    const existing = FtsMemoryService.searchMemories(title, { projectId, limit: 1 });
    if (existing.length === 0) {
      FtsMemoryService.recordMemory({
        projectId,
        sessionId,
        type: 'architecture',
        title: `[PREFERENCE] ${title}`,
        content: directive,
      });
    }

    return {
      category,
      preference: title,
      directive,
    };
  }
}

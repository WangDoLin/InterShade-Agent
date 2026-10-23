import { EventEmitter } from 'node:events';
import { SwarmSessionManager, type SpawnWorkerOptions } from './SwarmSessionManager.js';
import { SwarmIntegrator } from './SwarmIntegrator.js';
import { SwarmPolicy, resolveAutoMerge } from './SwarmPolicy.js';
import type { SwarmRole, SwarmTask, SwarmProgressEvent, SwarmMergeResult } from './SwarmTypes.js';

export interface PromptInputSpec {
  prompt: string;
  role?: SwarmRole;
  scope?: string[];
}

export class SwarmCoordinator extends EventEmitter {
  private sessionManager: SwarmSessionManager;

  constructor() {
    super();
    this.sessionManager = new SwarmSessionManager();

    // Forward progress updates from SessionManager
    this.sessionManager.on('progress', (event: SwarmProgressEvent) => {
      this.emit('progress', event);
    });
  }

  getSessionManager(): SwarmSessionManager {
    return this.sessionManager;
  }

  /**
   * Infer appropriate Swarm role and default file scope from prompt text
   */
  static inferRoleAndScope(promptText: string): { role: SwarmRole; scope: string[] } {
    const lower = promptText.toLowerCase();

    if (
      lower.includes('test') ||
      lower.includes('spec') ||
      lower.includes('verify') ||
      lower.includes('kiem thu') ||
      lower.includes('kiểm thử')
    ) {
      return {
        role: 'tester',
        scope: ['tests/**', 'test/**', '**/*.test.*', '**/*.spec.*'],
      };
    }

    if (
      lower.includes('ui') ||
      lower.includes('frontend') ||
      lower.includes('component') ||
      lower.includes('style') ||
      lower.includes('css') ||
      lower.includes('react') ||
      lower.includes('view') ||
      lower.includes('giao diện')
    ) {
      return {
        role: 'frontend',
        scope: ['src/ui/**', 'src/components/**', 'src/views/**', 'src/styles/**', 'ui/**'],
      };
    }

    if (
      lower.includes('api') ||
      lower.includes('backend') ||
      lower.includes('service') ||
      lower.includes('db') ||
      lower.includes('database') ||
      lower.includes('endpoint') ||
      lower.includes('server') ||
      lower.includes('route')
    ) {
      return {
        role: 'backend',
        scope: ['src/api/**', 'src/services/**', 'src/db/**', 'src/models/**', 'src/routes/**', 'services/**'],
      };
    }

    if (
      lower.includes('architect') ||
      lower.includes('schema') ||
      lower.includes('interface') ||
      lower.includes('type') ||
      lower.includes('thiết kế') ||
      lower.includes('kế hoạch')
    ) {
      return {
        role: 'architect',
        scope: ['src/types/**', 'src/interfaces/**', 'types/**'],
      };
    }

    if (
      lower.includes('security') ||
      lower.includes('cve') ||
      lower.includes('dependency') ||
      lower.includes('license') ||
      lower.includes('bao mat') ||
      lower.includes('bảo mật')
    ) {
      return {
        role: 'security',
        scope: ['package.json', 'requirements.txt', 'pyproject.toml', '.agent/audits/**', 'security/**'],
      };
    }

    if (
      lower.includes('paper') ||
      lower.includes('openalex') ||
      lower.includes('arxiv') ||
      lower.includes('literature') ||
      lower.includes('sota') ||
      lower.includes('nghien cuu') ||
      lower.includes('nghiên cứu')
    ) {
      return {
        role: 'research',
        scope: ['docs/**', 'research/**', 'references/**'],
      };
    }

    if (lower.includes('review') || lower.includes('audit') || lower.includes('kiem tra')) {
      return {
        role: 'reviewer',
        scope: ['*'],
      };
    }

    if (
      lower.includes('protein') ||
      lower.includes('alphafold') ||
      lower.includes('genome') ||
      lower.includes('gene') ||
      lower.includes('dna') ||
      lower.includes('rna') ||
      lower.includes('variant') ||
      lower.includes('encode') ||
      lower.includes('sinh hoc') ||
      lower.includes('sinh học') ||
      lower.includes('bio')
    ) {
      return {
        role: 'bioinformatics',
        scope: ['data/**', 'results/**', 'analysis/**', 'scripts/**'],
      };
    }

    return {
      role: 'general',
      scope: ['*'],
    };
  }

  /**
   * Dispatch multiple concurrent prompts with role assignment and worktree isolation
   */
  async runParallel(
    prompts: PromptInputSpec[],
    baseCwd: string = process.cwd(),
    autoMerge: boolean = SwarmPolicy.autoMerge
  ): Promise<{ tasks: SwarmTask[]; mergeResult?: SwarmMergeResult }> {
    if (prompts.length === 0) {
      return { tasks: [] };
    }

    const workerSpecs: SpawnWorkerOptions[] = prompts.map((item) => {
      const inferred = SwarmCoordinator.inferRoleAndScope(item.prompt);
      const role = item.role || inferred.role;
      const assignedScope = item.scope && item.scope.length > 0 ? item.scope : inferred.scope;

      return {
        role,
        prompt: item.prompt,
        assignedScope,
        useWorktree: true,
        baseCwd,
      };
    });

    this.emit('swarm_start', { count: workerSpecs.length });

    // Execute all tasks in parallel
    const completedTasks = await this.sessionManager.executeBatch(workerSpecs, baseCwd);

    let mergeResult: SwarmMergeResult | undefined;
    if (resolveAutoMerge(autoMerge)) {
      this.emit('merge_start');
      mergeResult = await SwarmIntegrator.mergeSwarmTasks(completedTasks, 'HEAD', baseCwd);
      this.emit('merge_done', mergeResult);
    }

    this.emit('swarm_done', { tasks: completedTasks, mergeResult });
    return { tasks: completedTasks, mergeResult };
  }

  /**
   * Cancel and cleanup running swarm
   */
  async cancel(baseCwd: string = process.cwd()): Promise<void> {
    await this.sessionManager.cleanup(baseCwd);
    this.emit('swarm_cancelled');
  }
}

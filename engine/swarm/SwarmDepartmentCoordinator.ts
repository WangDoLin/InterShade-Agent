import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { SwarmSessionManager, type SpawnWorkerOptions } from './SwarmSessionManager.js';
import { SwarmIntegrator } from './SwarmIntegrator.js';
import { DepartmentBlackboard } from './DepartmentBlackboard.js';
import { resolveAutoMerge } from './SwarmPolicy.js';
import { PromptEnhancerTool } from '../../tools/agentic/PromptEnhancerTool.js';
import type {
  SwarmRole,
  SwarmTask,
  DepartmentContract,
  DepartmentMissionReport,
  SwarmMergeResult,
  SwarmProgressEvent,
} from './SwarmTypes.js';

export interface DepartmentMissionOptions {
  missionGoal: string;
  baseCwd?: string;
  maxingBudget?: number;
  autoMerge?: boolean;
  requiredRoles?: SwarmRole[];
  onProgress?: (msg: string) => void;
}

const DEFAULT_THINKING_BUDGET = 16384;

/**
 * SwarmDepartmentCoordinator orchestrates a full multi-threaded Software Engineering Department.
 * Coordinates Lead Architect, Core Engineers, Domain Specialists, Security Auditors, and Reviewers.
 */
export class SwarmDepartmentCoordinator extends EventEmitter {
  private sessionManager: SwarmSessionManager;
  private blackboard: DepartmentBlackboard;

  constructor(sessionManager?: SwarmSessionManager) {
    super();
    this.sessionManager = sessionManager || new SwarmSessionManager();
    this.blackboard = DepartmentBlackboard.getInstance();

    this.sessionManager.on('progress', (event: SwarmProgressEvent) => {
      this.emit('progress', event);
    });
  }

  getSessionManager(): SwarmSessionManager {
    return this.sessionManager;
  }

  getBlackboard(): DepartmentBlackboard {
    return this.blackboard;
  }

  /**
   * Executes an end-to-end multi-threaded department mission
   */
  async executeMission(options: DepartmentMissionOptions): Promise<DepartmentMissionReport> {
    const startTime = Date.now();
    const baseCwd = options.baseCwd || process.cwd();
    const autoMerge = resolveAutoMerge(options.autoMerge);
    const thinkingBudget = options.maxingBudget || DEFAULT_THINKING_BUDGET;

    this.notify(options.onProgress, `[DEPARTMENT]: Initializing Maxing Department Swarm for "${options.missionGoal}"...`);
    this.blackboard.clear();

    // 1. Phase 1: Requirement Formalization
    const enhancedSpec = await this.formalizeRequirements(options.missionGoal, baseCwd);
    this.notify(options.onProgress, `[DEPARTMENT]: Lead Architect formalized 6-dimension mission specification.`);

    // 2. Phase 2: Derive Roles & Publish Initial Architectural Contract
    const roles = options.requiredRoles || this.determineDepartmentRoles(options.missionGoal);
    this.publishInitialContracts(options.missionGoal, roles);

    // 3. Phase 3: Parallel Departmental Dispatch
    this.notify(options.onProgress, `[DEPARTMENT]: Dispatching ${roles.length} specialized department desks concurrently in isolated worktrees...`);
    const workerSpecs = this.buildWorkerSpecs(options.missionGoal, roles, baseCwd, thinkingBudget);
    const completedTasks = await this.sessionManager.executeBatch(workerSpecs, baseCwd);

    // 4. Phase 4: Atomic Merge & Verification
    let mergeResult: SwarmMergeResult | undefined;
    let overallSuccess = completedTasks.every((t) => t.status === 'completed');

    if (autoMerge && completedTasks.some((t) => t.status === 'completed' && t.branch)) {
      this.notify(options.onProgress, `[DEPARTMENT]: Reviewer Sentinel verifying and integrating branches...`);
      mergeResult = await SwarmIntegrator.mergeSwarmTasks(completedTasks, 'HEAD', baseCwd);
      if (!mergeResult.success) overallSuccess = false;
    }

    const durationMs = Date.now() - startTime;
    const summary = this.generateMissionSummary(options.missionGoal, completedTasks, mergeResult, durationMs, overallSuccess);

    return {
      missionGoal: options.missionGoal,
      success: overallSuccess,
      tasks: completedTasks,
      contracts: this.blackboard.getContracts(),
      mergeResult,
      tokensConsumed: completedTasks.length * thinkingBudget,
      durationMs,
      summary,
    };
  }

  private async formalizeRequirements(goal: string, cwd: string): Promise<string> {
    const enhancer = new PromptEnhancerTool();
    return await enhancer.execute(
      { action: 'enhance_prompt', rawPrompt: goal },
      { sessionId: 'dept-architect', cwd, permissionMode: 'auto' }
    );
  }

  private determineDepartmentRoles(goal: string): SwarmRole[] {
    const lower = goal.toLowerCase();
    const roles: SwarmRole[] = ['architect', 'backend', 'tester', 'reviewer'];

    if (/ui|view|frontend|interface|css|giao diện/i.test(lower)) {
      roles.push('frontend');
    }
    if (/protein|variant|gene|dna|rna|encode|alphafold|sinh hoc/i.test(lower)) {
      roles.push('bioinformatics');
    }
    if (/paper|literature|sota|openalex|arxiv|research|nghiên cứu/i.test(lower)) {
      roles.push('research');
    }
    if (/security|cve|dependency|audit|license|bảo mật/i.test(lower)) {
      roles.push('security');
    }

    return roles;
  }

  private publishInitialContracts(goal: string, roles: SwarmRole[]): void {
    const contract: DepartmentContract = {
      id: `contract-${randomUUID().slice(0, 6)}`,
      name: 'SystemInterfaceSpecification',
      sourceRole: 'architect',
      targetRoles: roles.filter((r) => r !== 'architect'),
      interfaceCode: `// Architecture blueprint for: ${goal}\nexport interface DepartmentOutput { status: string; timestamp: number; }`,
      publishedAt: Date.now(),
    };
    this.blackboard.publishContract(contract);
  }

  private buildWorkerSpecs(
    goal: string,
    roles: SwarmRole[],
    baseCwd: string,
    thinkingBudget: number
  ): SpawnWorkerOptions[] {
    const digest = this.blackboard.getDigest();
    return roles.map((role) => ({
      role,
      prompt: `[Department Assignment - ${role.toUpperCase()}]: ${goal}\n\nShared Blackboard Contracts:\n${digest}`,
      useWorktree: true,
      baseCwd,
      assignedScope: this.getScopeForRole(role),
    }));
  }

  private getScopeForRole(role: SwarmRole): string[] {
    switch (role) {
      case 'frontend':
        return ['src/ui/**', 'src/components/**', 'ui/**'];
      case 'backend':
        return ['src/api/**', 'src/services/**', 'services/**', 'src/models/**'];
      case 'tester':
        return ['tests/**', '**/*.test.*', '**/*.spec.*'];
      case 'security':
        return ['package.json', 'requirements.txt', '.agent/audits/**'];
      case 'bioinformatics':
        return ['data/**', 'results/**', 'analysis/**'];
      case 'research':
        return ['docs/**', 'research/**'];
      default:
        return ['*'];
    }
  }

  private generateMissionSummary(
    goal: string,
    tasks: SwarmTask[],
    mergeResult: SwarmMergeResult | undefined,
    durationMs: number,
    success: boolean
  ): string {
    return [
      `🏛️ [Maxing Department Swarm Mission Report]:`,
      `- **Mission Goal**: "${goal}"`,
      `- **Overall Status**: ${success ? '✅ SUCCESS' : '⚠️ PARTIAL / FAILED'}`,
      `- **Department Desks Mobilized**: ${tasks.length}`,
      ...tasks.map((t) => `  * [${t.role.toUpperCase()}]: ${t.status.toUpperCase()} -> ${t.resultSummary || t.errorMessage || 'Complete'}`),
      mergeResult ? `\n🔀 **Branch Integration**: ${mergeResult.message}` : '',
      `- **Duration**: ${durationMs}ms`,
    ].filter(Boolean).join('\n');
  }

  private notify(callback: ((msg: string) => void) | undefined, message: string): void {
    if (callback) callback(message);
    this.emit('telemetry', message);
  }
}

import type { ToolDefinition } from '../types/index.js';
import { FileReadTool } from './filesystem/FileReadTool.js';
import { FileEditTool } from './filesystem/FileEditTool.js';
import { FileWriteTool } from './filesystem/FileWriteTool.js';
import { GrepTool } from './search/GrepTool.js';
import { GlobTool } from './search/GlobTool.js';
import { ShellTool } from './execution/ShellTool.js';
import { AskUserTool } from './agentic/AskUserTool.js';
import { PlanModeTool } from './agentic/PlanModeTool.js';
import { SubagentTool } from './agentic/SubagentTool.js';
import { RepomixTool } from './context/RepomixTool.js';
import { SemanticSearchTool } from './search/SemanticSearchTool.js';
import { TaskTool } from './task/TaskTool.js';
import { ToolSearchTool } from './meta/ToolSearchTool.js';
import { MemorySearchTool } from './search/MemorySearchTool.js';
import { MemoryRecordTool } from './search/MemoryRecordTool.js';
import { SkillDiscoveryTool } from './agentic/SkillDiscoveryTool.js';
import { SkillActivateTool } from './agentic/SkillActivateTool.js';
import { SkillAuditTool } from './agentic/SkillAuditTool.js';
import { LspTool } from './code/LspTool.js';
import { BatchExecuteTool } from './execution/BatchExecuteTool.js';
import { GitCommitTool } from './execution/GitCommitTool.js';
import { RepoMapTool } from './context/RepoMapTool.js';
import { CodeReviewSentinelTool } from './code/CodeReviewSentinelTool.js';
import { ScheduleTaskTool } from './agentic/ScheduleTaskTool.js';
import { PromptEnhancerTool } from './agentic/PromptEnhancerTool.js';
import { DependencyAuditTool } from './code/DependencyAuditTool.js';
import { MaxingDepartmentTool } from './agentic/MaxingDepartmentTool.js';
import { InvariantFuzzTool } from './execution/InvariantFuzzTool.js';

import { WebFetchTool } from './web/WebFetchTool.js';
import {
  SerenaOutlineTool,
  SerenaDefinitionTool,
  SerenaReferencesTool,
  SerenaDiagnosticsTool,
} from './semantic/SemanticTools.js';
import {
  ReachWebSearchTool,
  ReachWebReadTool,
  ReachGithubResearchTool,
  ReachDoctorTool,
} from './reach/ReachTools.js';
import {
  OrcaWorktreeCreateTool,
  OrcaWorktreeListTool,
  OrcaWorktreeDiffTool,
  OrcaWorktreeCleanupTool,
} from './orchestration/OrchestrationTools.js';
import { DecomposeAndDispatchTool } from './agentic/DecomposeAndDispatchTool.js';
import { AlphaFoldTool } from './science/AlphaFoldTool.js';
import { AlphaGenomeTool } from './science/AlphaGenomeTool.js';
import { HumanProteinAtlasTool } from './science/HumanProteinAtlasTool.js';
import { EncodeCcresTool } from './science/EncodeCcresTool.js';
import { HuggingFaceHubTool } from './ai/HuggingFaceHubTool.js';
import { LiteratureSearchTool } from './ai/LiteratureSearchTool.js';
import { BrowserAutomationTool } from './web/BrowserAutomationTool.js';
import { PyTorchModelBuilderTool } from './ai/PyTorchModelBuilderTool.js';

export class ToolRegistry {
  private tools: Map<string, ToolDefinition<any, any>> = new Map();
  private activeDeferredTools: Set<string> = new Set();

  constructor() {
    this.registerDefaultTools();
  }

  private registerDefaultTools(): void {
    // Core tools (always active)
    this.register(new FileReadTool());
    this.register(new FileEditTool());
    this.register(new FileWriteTool());
    this.register(new GrepTool());
    this.register(new GlobTool());
    this.register(new ShellTool());
    this.register(new AskUserTool());
    this.register(new PlanModeTool());
    this.register(new TaskTool());
    this.register(new ScheduleTaskTool());
    this.register(new ToolSearchTool(this));
    this.register(new MemorySearchTool());
    this.register(new MemoryRecordTool());
    this.register(new SkillDiscoveryTool());
    this.register(new SkillActivateTool());
    this.register(new SkillAuditTool());
    this.register(new LspTool());
    this.register(new BatchExecuteTool(this));
    this.register(new GitCommitTool());
    this.register(new RepoMapTool());
    this.register(new CodeReviewSentinelTool());
    this.register(new PromptEnhancerTool());
    this.register(new DependencyAuditTool());
    this.register(new InvariantFuzzTool());

    // Serena Semantic Engine tools
    this.register(new SerenaOutlineTool());
    this.register(new SerenaDefinitionTool());
    this.register(new SerenaReferencesTool());
    this.register(new SerenaDiagnosticsTool());

    // Agent Reach tools
    this.register(new ReachWebSearchTool());
    this.register(new ReachWebReadTool());
    this.register(new ReachGithubResearchTool());
    this.register(new ReachDoctorTool());

    // Orca Worktree Orchestrator tools
    this.register(new OrcaWorktreeCreateTool());
    this.register(new OrcaWorktreeListTool());
    this.register(new OrcaWorktreeDiffTool());
    this.register(new OrcaWorktreeCleanupTool());

    // Subagent Orchestrator & Multi-Agent Concurrency
    this.register(new DecomposeAndDispatchTool());
    this.register(new MaxingDepartmentTool());

    // Deferred tools (activated on-demand)
    this.register(new SubagentTool());
    this.register(new RepomixTool());
    this.register(new SemanticSearchTool());
    this.register(new WebFetchTool());

    // Biological Science Tools (activated on-demand)
    this.register(new AlphaFoldTool());
    this.register(new AlphaGenomeTool());
    this.register(new HumanProteinAtlasTool());
    this.register(new EncodeCcresTool());

    // AI & Machine Learning Model Building Tools
    this.register(new HuggingFaceHubTool());
    this.register(new LiteratureSearchTool());
    this.register(new BrowserAutomationTool());
    this.register(new PyTorchModelBuilderTool());
  }

  register(tool: ToolDefinition<any, any>): void {
    this.tools.set(tool.name, tool);
  }

  activateDeferredTool(name: string): boolean {
    if (this.tools.has(name)) {
      this.activeDeferredTools.add(name);
      return true;
    }
    return false;
  }

  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  getActiveTools(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values()).filter(
      (t) => !t.isDeferred || this.activeDeferredTools.has(t.name)
    );
  }

  getDeferredTools(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values()).filter((t) => t.isDeferred);
  }
}

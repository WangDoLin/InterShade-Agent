import type { SessionConfig, PermissionMode, UnifiedMessage } from '../../types/index.js';
import type { ClaudeAgentRoleType } from '../../services/agent/ClaudeAgentRoles.js';

export type SwarmRole =
  | 'architect'
  | 'backend'
  | 'frontend'
  | 'tester'
  | 'reviewer'
  | 'security'
  | 'research'
  | 'bioinformatics'
  | 'general';

export interface DepartmentContract {
  id: string;
  sourceRole: SwarmRole;
  targetRoles: SwarmRole[];
  name: string;
  interfaceCode: string;
  publishedAt: number;
}

export type BlackboardCategory =
  | 'contract'
  | 'endpoint'
  | 'test_result'
  | 'security_finding'
  | 'literature_baseline'
  | 'state';

export interface DepartmentBlackboardEntry<T = any> {
  key: string;
  category: BlackboardCategory;
  authorRole: SwarmRole;
  data: T;
  version?: number;
  timestamp: number;
}

export interface DepartmentMissionReport {
  missionGoal: string;
  success: boolean;
  tasks: SwarmTask[];
  contracts: DepartmentContract[];
  mergeResult?: SwarmMergeResult;
  tokensConsumed: number;
  durationMs: number;
  summary: string;
}

export interface SubtaskSpec {
  id: string;
  role: SwarmRole;
  title: string;
  prompt: string;
  scope?: string[];
  dependsOn?: string[];
}

export type SwarmSessionStatus =
  | 'idle'
  | 'planning'
  | 'running'
  | 'waiting_lease'
  | 'verifying'
  | 'completed'
  | 'failed';

export interface FileLease {
  filePath: string;
  sessionId: string;
  role: SwarmRole | ClaudeAgentRoleType;
  fencingToken: number;
  grantedAt: number;
  expiresAt: number;
}

export interface SwarmTask {
  id: string;
  role: SwarmRole | ClaudeAgentRoleType;
  prompt: string;
  assignedScope?: string[];
  status: SwarmSessionStatus;
  progressPercent: number;
  currentTool?: string;
  worktreePath?: string;
  branch?: string;
  leasedFiles: string[];
  resultSummary?: string;
  errorMessage?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface SwarmSessionState {
  sessionId: string;
  role: SwarmRole | ClaudeAgentRoleType;
  task: SwarmTask;
  worktreePath?: string;
  branch?: string;
  permissionMode: PermissionMode;
  totalTokens: number;
}

export interface SwarmProgressEvent {
  swarmId: string;
  tasks: SwarmTask[];
  overallStatus: 'running' | 'completed' | 'partial_failure' | 'failed';
  activeCount: number;
  completedCount: number;
  totalCount: number;
}

export interface MergeProposal {
  proposalId: string;
  baseBranch: string;
  candidateBranches: Array<{
    taskId: string;
    role: string;
    branch: string;
    worktreePath: string;
    modifiedFiles: string[];
  }>;
  collisionCheckPassed: boolean;
  collisions: Array<{ file: string; branches: string[] }>;
  createdAt: number;
}

export interface SwarmMergeResult {
  success: boolean;
  mergedBranches: string[];
  failedBranches: Array<{ branch: string; reason: string }>;
  verificationPassed: boolean;
  testOutput?: string;
  proposal?: MergeProposal;
  message: string;
}

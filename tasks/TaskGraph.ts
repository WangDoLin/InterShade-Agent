export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskItem {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export class TaskGraph {
  private tasks: Map<string, TaskItem> = new Map();

  constructor(initialTasks: TaskItem[] = []) {
    for (const task of initialTasks) {
      this.tasks.set(task.id, {
        ...task,
        blocks: Array.isArray(task.blocks) ? task.blocks : [],
        blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : [],
      });
    }
  }

  addTask(task: TaskItem): void {
    if (this.tasks.has(task.id)) {
      throw new Error(`Task with id "${task.id}" already exists.`);
    }
    this.tasks.set(task.id, {
      ...task,
      blocks: Array.isArray(task.blocks) ? task.blocks : [],
      blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : [],
    });
    this.syncDualEdges();
    this.validateNoCycles();
  }

  updateTask(id: string, updates: Partial<Omit<TaskItem, 'id' | 'createdAt'>>): TaskItem {
    const existing = this.tasks.get(id);
    if (!existing) {
      throw new Error(`Task with id "${id}" does not exist.`);
    }

    // Strip explicit undefined values so partial updates do not overwrite existing valid properties
    const cleanUpdates: Partial<Omit<TaskItem, 'id' | 'createdAt'>> = {};
    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) {
        (cleanUpdates as any)[key] = val;
      }
    }

    const updated: TaskItem = {
      ...existing,
      ...cleanUpdates,
      blocks: Array.isArray(cleanUpdates.blocks) ? cleanUpdates.blocks : (Array.isArray(existing.blocks) ? existing.blocks : []),
      blockedBy: Array.isArray(cleanUpdates.blockedBy) ? cleanUpdates.blockedBy : (Array.isArray(existing.blockedBy) ? existing.blockedBy : []),
      updatedAt: Date.now(),
    };

    this.tasks.set(id, updated);
    this.syncDualEdges();
    this.validateNoCycles();
    return updated;
  }

  getTask(id: string): TaskItem | undefined {
    return this.tasks.get(id);
  }

  getAllTasks(): TaskItem[] {
    return Array.from(this.tasks.values()).sort((a, b) => {
      const idA = parseInt(a.id, 10);
      const idB = parseInt(b.id, 10);
      if (!isNaN(idA) && !isNaN(idB)) {
        return idA - idB;
      }
      return a.createdAt - b.createdAt;
    });
  }

  deleteTask(id: string): boolean {
    if (!this.tasks.delete(id)) {
      return false;
    }
    // Remove references to deleted task
    for (const task of this.tasks.values()) {
      task.blocks = task.blocks.filter(bId => bId !== id);
      task.blockedBy = task.blockedBy.filter(bId => bId !== id);
    }
    return true;
  }

  getReadyTasks(): TaskItem[] {
    return this.getAllTasks().filter(task => {
      if (task.status !== 'pending') {
        return false;
      }
      return task.blockedBy.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === 'completed';
      });
    });
  }

  hasVerificationStep(): boolean {
    const verificationPattern = /(verif|test|check|lint|audit|validate|eval)/i;
    for (const task of this.tasks.values()) {
      if (verificationPattern.test(task.subject) || verificationPattern.test(task.description)) {
        return true;
      }
    }
    return false;
  }

  isVerificationNudgeNeeded(): boolean {
    const allTasks = this.getAllTasks();
    if (allTasks.length < 3) {
      return false;
    }
    const allCompleted = allTasks.every(t => t.status === 'completed');
    if (!allCompleted) {
      return false;
    }
    return !this.hasVerificationStep();
  }

  private syncDualEdges(): void {
    for (const task of this.tasks.values()) {
      const blocks = Array.isArray(task.blocks) ? task.blocks : [];
      const blockedBy = Array.isArray(task.blockedBy) ? task.blockedBy : [];
      task.blocks = blocks;
      task.blockedBy = blockedBy;

      for (const blockId of blocks) {
        const target = this.tasks.get(blockId);
        if (target) {
          if (!Array.isArray(target.blockedBy)) target.blockedBy = [];
          if (!target.blockedBy.includes(task.id)) {
            target.blockedBy.push(task.id);
          }
        }
      }
      for (const blockedById of blockedBy) {
        const source = this.tasks.get(blockedById);
        if (source) {
          if (!Array.isArray(source.blocks)) source.blocks = [];
          if (!source.blocks.includes(task.id)) {
            source.blocks.push(task.id);
          }
        }
      }
    }
  }

  private validateNoCycles(): void {
    const visited = new Set<string>();
    const recStack = new Set<string>();

    const dfs = (taskId: string): boolean => {
      visited.add(taskId);
      recStack.add(taskId);

      const task = this.tasks.get(taskId);
      if (task) {
        for (const nextId of task.blocks) {
          if (!this.tasks.has(nextId)) continue;
          if (!visited.has(nextId) && dfs(nextId)) {
            return true;
          } else if (recStack.has(nextId)) {
            return true;
          }
        }
      }

      recStack.delete(taskId);
      return false;
    };

    for (const taskId of this.tasks.keys()) {
      if (!visited.has(taskId)) {
        if (dfs(taskId)) {
          throw new Error(`Circular dependency detected involving task "${taskId}".`);
        }
      }
    }
  }
}

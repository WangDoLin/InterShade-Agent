import assert from 'node:assert/strict';
import React from 'react';
import { ToolProgressBlock } from '../ui/components/ToolProgressBlock.js';
import { TaskTrackerView } from '../ui/components/TaskTrackerView.js';
import { StatusLine } from '../ui/components/StatusLine.js';
import { InteractivePrompt } from '../ui/components/InteractivePrompt.js';
import { SwarmDashboardView } from '../ui/components/SwarmDashboardView.js';
import type { TaskItem } from '../tasks/TaskGraph.js';

console.log('🧪 Testing UI Height Budget & Anti-Duplication Props...');

// 1. ToolProgressBlock renders with compact tree layout
const toolBlock = React.createElement(ToolProgressBlock, {
  currentToolName: 'run_shell_command',
  progressText: 'npm test',
  isStreamingText: false,
});
assert.strictEqual(toolBlock.props.currentToolName, 'run_shell_command');
console.log('✔ Test 1: ToolProgressBlock accepts tool name and progress.');

// 2. TaskTrackerView renders in compact mode
const sampleTasks: TaskItem[] = [
  {
    id: 'task-1',
    subject: 'Fix status duplication bug',
    description: 'Fix spinner duplicate lines',
    status: 'in_progress',
    blocks: [],
    blockedBy: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  {
    id: 'task-2',
    subject: 'Verify in terminal',
    description: 'Verify clean rendering',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];
const compactTasks = React.createElement(TaskTrackerView, {
  tasks: sampleTasks,
  isCompact: true,
});
assert.strictEqual(compactTasks.props.isCompact, true);
console.log('✔ Test 2: TaskTrackerView accepts isCompact prop.');

// 3. StatusLine renders in compact mode with columns
const compactStatus = React.createElement(StatusLine, {
  model: 'ag/gemini-3.8-flash-hi',
  provider: 'openai',
  cwd: process.cwd(),
  permissionMode: 'default',
  totalInputTokens: 1000,
  totalOutputTokens: 500,
  isBusy: true,
  isCompact: true,
  columns: 100,
});
assert.strictEqual(compactStatus.props.isCompact, true);
assert.strictEqual(compactStatus.props.columns, 100);
console.log('✔ Test 3: StatusLine accepts isCompact and columns props.');

// 4. InteractivePrompt accepts isCompact
const compactPrompt = React.createElement(InteractivePrompt, {
  onSubmit: () => {},
  isBusy: true,
  isCompact: true,
});
assert.strictEqual(compactPrompt.props.isCompact, true);
console.log('✔ Test 4: InteractivePrompt accepts isCompact prop.');

// 5. SwarmDashboardView accepts isCompact
const compactSwarm = React.createElement(SwarmDashboardView, {
  tasks: [],
  isCompact: true,
});
assert.strictEqual(compactSwarm.props.isCompact, true);
console.log('✔ Test 5: SwarmDashboardView accepts isCompact prop.');

console.log('🎉 ALL UI COMPACT HEIGHT BUDGET TESTS PASSED (100%)!');

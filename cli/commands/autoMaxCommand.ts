import type { LocalCommand, CommandContext } from './types.js';
import { AutoMaxEngine } from '../../engine/autonomous/AutoMaxEngine.js';

let sharedAutoMaxEngine: AutoMaxEngine | null = null;

export function getSharedAutoMaxEngine(): AutoMaxEngine {
  if (!sharedAutoMaxEngine) {
    sharedAutoMaxEngine = new AutoMaxEngine();
  }
  return sharedAutoMaxEngine;
}

export const autoMaxCommand: LocalCommand = {
  name: 'automax',
  description:
    'Activate AutoMax Mode: combines unconstrained reasoning with fully autonomous execution across goal or time horizons (/automax [on|off|status|run <goal>])',
  type: 'local',
  aliases: ['auto-max', 'evolve'],
  async execute(ctx: CommandContext): Promise<string> {
    const st = ctx.sessionState as Record<string, unknown>;
    const sub = (ctx.args[0] || '').toLowerCase().trim();

    // 1. /automax on [goal] [--duration <mins>] [--iterations <N>]
    if (sub === 'on' || sub === 'enable' || sub === 'start') {
      const restArgs = ctx.args.slice(1);
      let durationMinutes: number | undefined;
      let maxIterations: number | undefined;
      const filteredWords: string[] = [];

      for (let i = 0; i < restArgs.length; i++) {
        const arg = restArgs[i];
        if (arg === '--duration' || arg === '-d') {
          const val = parseInt(restArgs[i + 1], 10);
          if (!isNaN(val)) {
            durationMinutes = val;
            i++;
          }
        } else if (arg === '--iterations' || arg === '-n') {
          const val = parseInt(restArgs[i + 1], 10);
          if (!isNaN(val)) {
            maxIterations = val;
            i++;
          }
        } else {
          filteredWords.push(arg);
        }
      }

      const goal = filteredWords.join(' ').trim() || undefined;

      st.autoMaxMode = true;
      st.maxingMode = true;
      st.permissionMode = 'auto';
      st.thinkingBudget = 16384;
      st.autoMaxConfig = {
        goal,
        durationMinutes,
        maxIterations,
        thinkingBudget: 16384,
      };

      const horizonInfo = [
        goal ? `- Mission Goal: "${goal}"` : '- Horizon: Continuous self-directed evolution',
        durationMinutes ? `- Duration Limit: ${durationMinutes} minute(s)` : '- Duration: Goal completion bounded',
        maxIterations ? `- Max Iterations: ${maxIterations}` : '- Max Iterations: 10 per cycle',
      ].join('\n');

      return [
        '⚡ [MODE AUTOMAX: ACTIVE]',
        '- Unconstrained Deliberation: Enabled (16,384 tokens thinking).',
        '- Full Autonomy: Active (permissionMode: "auto", no human approval blocking).',
        '- Whole-Repo Omniscience & Invariant Fuzz Shield: Engaged.',
        horizonInfo,
        '',
        'Agent is operating autonomously. All subsequent prompts or goals will be solved from end-to-end without requiring incremental commands.',
      ].join('\n');
    }

    // 2. /automax off / stop / disable
    if (sub === 'off' || sub === 'disable' || sub === 'stop') {
      st.autoMaxMode = false;
      st.maxingMode = false;
      st.permissionMode = 'default';
      st.thinkingBudget = 2048;
      st.autoMaxConfig = undefined;

      const engine = getSharedAutoMaxEngine();
      if (engine.isActive()) {
        engine.stop();
      }

      return '🛑 [MODE AUTOMAX: DISABLED]\n- Reverted to standard interactive mode and single-turn token budget.\n- Permission mode restored to "default".';
    }

    // 3. /automax status
    if (sub === 'status') {
      const isAutoMax = Boolean(st.autoMaxMode);
      const cfg = st.autoMaxConfig as Record<string, unknown> | undefined;
      const engine = getSharedAutoMaxEngine();
      const liveStatus = engine.getStatus();

      return [
        `⚡ [MODE AUTOMAX STATUS]: ${isAutoMax ? '🟣 ACTIVE' : '⚪ INACTIVE'}`,
        `- Permission Mode: ${(st.permissionMode as string) || 'default'}`,
        `- Thinking Budget: ${st.thinkingBudget || (isAutoMax ? 16384 : 2048)} tokens`,
        `- Mission Goal: ${cfg?.goal || liveStatus.goal || '(None set / Continuous Evolution)'}`,
        `- Time Horizon: ${cfg?.durationMinutes || liveStatus.durationMinutes ? `${cfg?.durationMinutes || liveStatus.durationMinutes}m` : 'None (Goal-bounded)'}`,
        `- Engine State: ${liveStatus.active ? `🟢 RUNNING (Phase: ${liveStatus.currentPhase}, Cycle: ${liveStatus.iterationsCompleted})` : '⚪ IDLE'}`,
        liveStatus.elapsedMs > 0 ? `- Elapsed Time: ${(liveStatus.elapsedMs / 1000).toFixed(1)}s` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }

    // 4. /automax run <goal> [--duration <mins>] [--iterations <N>]
    if (sub === 'run') {
      const restArgs = ctx.args.slice(1);
      let durationMinutes: number | undefined;
      let maxIterations: number | undefined;
      const filteredWords: string[] = [];

      for (let i = 0; i < restArgs.length; i++) {
        const arg = restArgs[i];
        if (arg === '--duration' || arg === '-d') {
          const val = parseInt(restArgs[i + 1], 10);
          if (!isNaN(val)) {
            durationMinutes = val;
            i++;
          }
        } else if (arg === '--iterations' || arg === '-n') {
          const val = parseInt(restArgs[i + 1], 10);
          if (!isNaN(val)) {
            maxIterations = val;
            i++;
          }
        } else {
          filteredWords.push(arg);
        }
      }

      const goal = filteredWords.join(' ').trim();
      if (!goal) {
        return '[AUTOMAX]: Please provide a goal or objective. Usage: /automax run <goal> [--duration <mins>] [--iterations <N>]';
      }

      const engine = getSharedAutoMaxEngine();
      const report = await engine.runMission({
        sessionId: String(ctx.sessionState.id || 'cli-automax'),
        cwd: ctx.cwd,
        goal,
        durationMinutes,
        maxIterations,
        thinkingBudget: 16384,
      });

      return report.summary;
    }

    // 5. Toggle fallback
    const nextState = !st.autoMaxMode;
    st.autoMaxMode = nextState;
    if (nextState) {
      st.maxingMode = true;
      st.permissionMode = 'auto';
      st.thinkingBudget = 16384;
      st.autoMaxConfig = { thinkingBudget: 16384 };
      return '⚡ [MODE AUTOMAX: ACTIVE]\n- Full autonomy & unconstrained deliberation enabled.\n- Usage: /automax [on|off|status|run <goal> [--duration <mins>] [--iterations <N>]]';
    } else {
      st.maxingMode = false;
      st.permissionMode = 'default';
      st.thinkingBudget = 2048;
      st.autoMaxConfig = undefined;
      return '🛑 [MODE AUTOMAX: DISABLED]\n- Reverted to standard interactive mode.';
    }
  },
};

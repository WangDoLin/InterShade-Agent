import { SkillRegistry } from '../../../services/skills/SkillRegistry.js';
import { SkillCrystallizer } from '../../../services/skills/SkillCrystallizer.js';
import { SkillSecurityAuditor } from '../../../services/skills/SkillSecurityAuditor.js';
import { SkillHubClient } from '../../../services/skills/SkillHubClient.js';
import type { LocalCommand } from '../types.js';

function formatSkillCatalogEntry(pkg: {
  metadata: { name: string; version: string; description: string; tags?: string[] };
  tier: string;
}): string {
  const tagsStr =
    pkg.metadata.tags && pkg.metadata.tags.length > 0 ? ` [${pkg.metadata.tags.slice(0, 3).join(', ')}]` : '';
  const firstLineDesc = pkg.metadata.description.split('\n')[0].slice(0, 100);
  return `  - ${pkg.metadata.name} (v${pkg.metadata.version}, ${pkg.tier})${tagsStr}: ${firstLineDesc}`;
}

function handleListSkills(registry: SkillRegistry, cwd: string): string {
  const discovered = registry.discoverAllSkills();
  const crystallized = SkillCrystallizer.loadSkills(cwd);

  const lines: string[] = [`InterShader Integrated Skills Ecosystem (${discovered.length} total active skills):`];

  const tiers: Array<{ name: string; tier: 'workspace' | 'user' | 'global' | 'builtin' }> = [
    { name: 'Workspace Tier (.intershader/skills, .agents/skills)', tier: 'workspace' },
    { name: 'User Tier (~/.intershader/skills)', tier: 'user' },
    { name: 'Global IDE Tier (~/.gemini/config/skills, ~/.claude/skills)', tier: 'global' },
    { name: 'Built-in Core Tier (packageRoot/skills)', tier: 'builtin' },
  ];

  for (const t of tiers) {
    const tierSkills = discovered.filter((s) => s.tier === t.tier);
    if (tierSkills.length > 0) {
      lines.push(`\n[${t.name}] - ${tierSkills.length} skills:`);
      for (const s of tierSkills) {
        lines.push(formatSkillCatalogEntry(s));
      }
    }
  }

  if (crystallized.length > 0) {
    lines.push(`\n[Autonomously Crystallized Skills] (${crystallized.length}):`);
    for (const sk of crystallized) {
      lines.push(
        `  - [${sk.name}] Triggers: [${sk.intentTriggers.slice(0, 4).join(', ')}] (${(sk.confidence * 100).toFixed(0)}%)`
      );
    }
  }

  lines.push(
    '\nCommands: /skills search <keyword> | /skills install <name> | /skills info <name> | /skills activate <name>'
  );
  return lines.join('\n');
}

function handleSkillInfo(registry: SkillRegistry, skillName: string): string {
  if (!skillName) {
    return 'Error: Please specify skill name. Usage: /skills info <name>';
  }
  const pkg = registry.getSkill(skillName);
  if (!pkg) {
    return `Skill "${skillName}" not found. Run /skills to see available skills.`;
  }
  const meta = pkg.metadata;
  const caps =
    Object.entries(meta.capabilities)
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k)
      .join(', ') || 'none';

  const allowedToolsStr =
    meta.allowedTools && meta.allowedTools.length > 0 ? meta.allowedTools.join(', ') : 'all';
  const tagsStr = meta.tags && meta.tags.length > 0 ? meta.tags.join(', ') : 'none';

  return [
    `Skill Specification: ${meta.name}`,
    `Version:      ${meta.version}`,
    `Tier:         ${pkg.tier}`,
    `Description:  ${meta.description}`,
    `Capabilities: ${caps}`,
    `Allowed Tools: ${allowedToolsStr}`,
    `Tags:         ${tagsStr}`,
    `SHA-256:      ${pkg.contentSha256.slice(0, 16)}...`,
    `Location:     ${pkg.skillDir}`,
  ].join('\n');
}

function handleAuditSkills(registry: SkillRegistry, targetSkill?: string): string {
  const allSkills = registry.discoverAllSkills();
  const toAudit = targetSkill
    ? allSkills.filter((s) => s.metadata.name.toLowerCase() === targetSkill.toLowerCase())
    : allSkills;

  if (toAudit.length === 0) {
    return targetSkill
      ? `Skill "${targetSkill}" not found to audit.`
      : 'No skills found in registry to audit.';
  }

  const reports = toAudit.map((s) => SkillSecurityAuditor.auditSkill(s));
  const passedCount = reports.filter((r) => r.passed).length;
  const lines: string[] = [`Skill Security Audit (${passedCount}/${reports.length} PASSED):`];

  for (const r of reports) {
    const status = r.passed ? '[PASS]' : `[FAIL: ${r.maxSeverity}]`;
    lines.push(`  ${status} ${r.skillName} (Findings: ${r.findings.length})`);
    for (const f of r.findings) {
      lines.push(`    * [${f.severity}] ${f.ruleId}: ${f.message}`);
    }
  }
  return lines.join('\n');
}

function handleActivateSkill(
  registry: SkillRegistry,
  skillName: string,
  sessionState: Record<string, unknown>
): string {
  if (!skillName) {
    return 'Error: Please specify skill name to activate. Usage: /skills activate <name>';
  }
  const pkg = registry.getSkill(skillName);
  if (!pkg) {
    return `Skill "${skillName}" not found. Run /skills to see available skills.`;
  }
  sessionState.activeSkill = pkg.metadata.name;
  return [
    `Skill Activated: [${pkg.metadata.name}] (v${pkg.metadata.version})`,
    `Description: ${pkg.metadata.description}`,
    `Full procedural instructions and workflow checklist are now primed for upcoming queries.`,
  ].join('\n');
}

function handleSearchSkills(cwd: string, keyword?: string): string {
  if (!keyword) {
    return 'Error: Please specify search keyword. Usage: /skills search <keyword>';
  }
  const hub = new SkillHubClient(cwd);
  const result = hub.search(keyword);

  const lines: string[] = [`Skill Search Results for "${keyword}":\n`];
  if (result.local.length > 0) {
    lines.push(`Installed Locally (${result.local.length}):`);
    for (const s of result.local) {
      lines.push(`  - [${s.tier.toUpperCase()}] ${s.name} (v${s.version}): ${s.description.slice(0, 80)}...`);
    }
  }

  if (result.remote.length > 0) {
    lines.push(`\nAvailable in Curated Catalog (${result.remote.length}):`);
    for (const r of result.remote) {
      lines.push(`  - [CATALOG] ${r.vendor}/${r.name}: ${r.description} (Tags: ${r.tags.join(', ')})`);
    }
    lines.push('\nInstall any skill using: /skills install <vendor/name> or /skills install <name>');
  }

  if (result.local.length === 0 && result.remote.length === 0) {
    lines.push('  No matching skills found locally or in curated remote catalog.');
  }

  return lines.join('\n');
}

async function handleInstallSkill(cwd: string, identifier?: string, isGlobal: boolean = false): Promise<string> {
  if (!identifier) {
    return 'Error: Please specify skill identifier or URL. Usage: /skills install <vendor/name> [--global]';
  }
  const hub = new SkillHubClient(cwd);
  try {
    const res = await hub.install(identifier, isGlobal);
    return [
      `[SUCCESS] ${res.message}`,
      `File: ${res.installPath}`,
      `Security Audit: ${res.auditPassed ? 'PASSED (Clean)' : 'WARNING'}`,
      `You can now activate it via: /skills activate ${res.skillName}`,
    ].join('\n');
  } catch (err) {
    return `[INSTALLATION FAILED]: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function handleUninstallSkill(cwd: string, name?: string): string {
  if (!name) {
    return 'Error: Please specify skill name to uninstall. Usage: /skills uninstall <name>';
  }
  const hub = new SkillHubClient(cwd);
  const res = hub.uninstall(name);
  return res.message;
}

export const skillsCommand: LocalCommand = {
  name: 'skills',
  description: 'List, search, install, audit, or activate development skills',
  type: 'local',
  aliases: ['skill'],
  execute: async (ctx) => {
    const sub = ctx.args[0]?.toLowerCase();
    const arg = ctx.args[1];
    const isGlobal = ctx.args.includes('--global') || ctx.args.includes('-g');
    const registry = new SkillRegistry(ctx.cwd);

    switch (sub) {
      case 'search':
      case 'find':
        return handleSearchSkills(ctx.cwd, arg);
      case 'install':
      case 'add':
        return await handleInstallSkill(ctx.cwd, arg, isGlobal);
      case 'uninstall':
      case 'remove':
      case 'rm':
        return handleUninstallSkill(ctx.cwd, arg);
      case 'info':
        return handleSkillInfo(registry, arg);
      case 'audit':
        return handleAuditSkills(registry, arg);
      case 'activate':
      case 'use':
        return handleActivateSkill(registry, arg, ctx.sessionState);
      case 'list':
      default:
        return handleListSkills(registry, ctx.cwd);
    }
  },
};

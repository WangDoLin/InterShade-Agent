import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SkillLockfile,
  type SkillPackage,
  type SkillFrontmatter,
  type SkillCapabilities,
} from './SkillLockfile.js';
import { SkillAllowlist } from './SkillAllowlist.js';
import { SkillSecurityAuditor, type SkillAuditReport } from './SkillSecurityAuditor.js';

export interface SkillSummary {
  name: string;
  description: string;
  version: string;
  tier: 'builtin' | 'global' | 'user' | 'workspace';
  license: string;
  upstreamUrl?: string;
  tags?: string[];
  capabilities: SkillCapabilities;
}

export interface SkillActivationResult {
  success: boolean;
  skillName: string;
  tier: 'builtin' | 'global' | 'user' | 'workspace';
  instructions: string;
  auditReport?: SkillAuditReport;
  error?: string;
}

export class SkillRegistry {
  private workspaceDir: string;
  private packageRoot: string;
  private cachedSkills: Map<string, SkillPackage> = new Map();

  constructor(workspaceDir: string = process.cwd(), packageRoot?: string) {
    this.workspaceDir = workspaceDir;
    // Determine packageRoot: if not supplied, look for package.json or src root
    this.packageRoot = packageRoot || this.resolvePackageRoot(workspaceDir);
  }

  private resolvePackageRoot(startDir: string): string {
    let curr = startDir;
    while (curr && curr !== path.dirname(curr)) {
      if (fs.existsSync(path.join(curr, 'package.json')) && fs.existsSync(path.join(curr, 'skills'))) {
        return curr;
      }
      curr = path.dirname(curr);
    }
    return startDir;
  }

  /**
   * Parse YAML frontmatter from raw markdown string
   */
  static parseFrontmatter(raw: string): { frontmatter: Partial<SkillFrontmatter>; body: string } {
    const trimmed = raw.trimStart();
    if (!trimmed.startsWith('---')) {
      return { frontmatter: {}, body: raw };
    }

    const secondDelim = trimmed.indexOf('\n---', 3);
    if (secondDelim === -1) {
      return { frontmatter: {}, body: raw };
    }

    const yamlBlock = trimmed.slice(3, secondDelim).trim();
    const body = trimmed.slice(secondDelim + 4).trimStart();
    const frontmatter: Record<string, any> = {};

    const lines = yamlBlock.split(/\r?\n/);
    let currentKey = '';
    let currentObject: Record<string, any> | null = null;
    let multiLineKey = '';
    let multiLineType: '>' | '|' = '>';
    const multiLineBuffer: string[] = [];

    const flushMultiLine = () => {
      if (multiLineKey) {
        frontmatter[multiLineKey] = multiLineType === '>'
          ? multiLineBuffer.join(' ').trim()
          : multiLineBuffer.join('\n').trim();
        multiLineKey = '';
        multiLineBuffer.length = 0;
      }
    };

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith('#')) continue;

      // Check multi-line string continuation (e.g. description: >)
      if ((line.startsWith('  ') || line.startsWith('\t')) && multiLineKey) {
        multiLineBuffer.push(trimmedLine);
        continue;
      }

      // Check sub-property (2 spaces indent)
      if (line.startsWith('  ') && currentObject) {
        flushMultiLine();
        const colonIdx = trimmedLine.indexOf(':');
        if (colonIdx !== -1) {
          const subKey = trimmedLine.slice(0, colonIdx).trim();
          let subVal: any = trimmedLine.slice(colonIdx + 1).trim();
          if (subVal === 'true') subVal = true;
          else if (subVal === 'false') subVal = false;
          currentObject[subKey] = subVal;
        }
        continue;
      }

      flushMultiLine();
      currentObject = null;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();

      if (value === '>' || value === '|') {
        multiLineKey = key;
        multiLineType = value as '>' | '|';
        multiLineBuffer.length = 0;
      } else if (value === '') {
        currentKey = key;
        currentObject = {};
        frontmatter[key] = currentObject;
      } else if (value.startsWith('[') && value.endsWith(']')) {
        // Simple inline array
        frontmatter[key] = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      } else {
        if (value === 'true') frontmatter[key] = true;
        else if (value === 'false') frontmatter[key] = false;
        else frontmatter[key] = value.replace(/^['"]|['"]$/g, '');
      }
    }

    flushMultiLine();
    return { frontmatter: frontmatter as Partial<SkillFrontmatter>, body };
  }

  /**
   * Load a single skill directory
   */
  private loadSkillFromDir(
    skillDir: string,
    tier: 'builtin' | 'global' | 'user' | 'workspace'
  ): SkillPackage | null {
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      return null;
    }

    try {
      const rawFile = fs.readFileSync(skillMdPath, 'utf8');
      const { frontmatter, body } = SkillRegistry.parseFrontmatter(rawFile);

      const skillName = frontmatter.name || path.basename(skillDir);
      const hasScriptsDir = fs.existsSync(path.join(skillDir, 'scripts'));
      const capabilities: SkillCapabilities = {
        scriptExecution:
          frontmatter.capabilities?.scriptExecution !== undefined
            ? Boolean(frontmatter.capabilities.scriptExecution)
            : tier === 'global' && hasScriptsDir,
        networkAccess: Boolean(frontmatter.capabilities?.networkAccess),
        filesystemWrite: Boolean(frontmatter.capabilities?.filesystemWrite),
      };

      const metadata: SkillFrontmatter = {
        name: skillName,
        description: frontmatter.description || 'No description provided.',
        license: frontmatter.license || 'Apache-2.0',
        version: frontmatter.version || '1.0.0',
        author: frontmatter.author || 'Engineering Community',
        upstreamUrl: frontmatter.upstreamUrl || '',
        commitSha: frontmatter.commitSha || '',
        compatibility: frontmatter.compatibility,
        capabilities,
        allowedTools: frontmatter.allowedTools || [],
        tags: frontmatter.tags || [],
      };

      const contentSha256 = SkillLockfile.computeSha256(rawFile);
      const treeSha256 = SkillLockfile.computeTreeSha256(skillDir);

      const assetFiles: string[] = [];
      const scanAssets = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const full = path.join(dir, item);
          if (fs.statSync(full).isDirectory()) scanAssets(full);
          else assetFiles.push(path.relative(skillDir, full).replace(/\\/g, '/'));
        }
      };
      scanAssets(skillDir);

      return {
        metadata,
        content: body,
        rawFileContent: rawFile,
        skillDir,
        tier,
        contentSha256,
        treeSha256,
        assetFiles,
      };
    } catch {
      return null;
    }
  }

  /**
   * Scan all discovery tiers and populate the internal skill map
   * Precedence order (higher overrides lower):
   * builtin < global (IDE) < user (~/.intershader) < workspace (.intershader / .agents)
   */
  discoverAllSkills(): SkillPackage[] {
    this.cachedSkills.clear();
    const userHome = os.homedir();

    const tiers: { dir: string; tier: 'builtin' | 'global' | 'user' | 'workspace' }[] = [
      // 1. Built-in tier (lowest precedence)
      { dir: path.join(this.packageRoot, 'skills'), tier: 'builtin' },

      // 2. Global IDE Customizations tier
      { dir: path.join(userHome, '.gemini', 'config', 'skills'), tier: 'global' },
      { dir: path.join(userHome, '.claude', 'skills'), tier: 'global' },
      { dir: path.join(userHome, '.agents', 'skills'), tier: 'global' },

      // 3. User tier (~/.intershader/skills)
      { dir: path.join(userHome, '.intershader', 'skills'), tier: 'user' },

      // 4. Workspace tier (.intershader/skills, .agents/skills)
      { dir: path.join(this.workspaceDir, '.intershader', 'skills'), tier: 'workspace' },
      { dir: path.join(this.workspaceDir, '.agents', 'skills'), tier: 'workspace' },
    ];

    for (const { dir, tier } of tiers) {
      if (!fs.existsSync(dir)) continue;

      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          if (fs.statSync(fullPath).isDirectory()) {
            const skill = this.loadSkillFromDir(fullPath, tier);
            if (skill) {
              // Higher precedence overrides lower precedence
              this.cachedSkills.set(skill.metadata.name, skill);
            }
          }
        }
      } catch {
        // Ignore unreadable discovery directories
      }
    }

    return Array.from(this.cachedSkills.values());
  }

  /**
   * Get lightweight catalog for system prompt injection (Progressive Disclosure - Level 1)
   */
  getSkillCatalog(): SkillSummary[] {
    const skills = this.discoverAllSkills();
    return skills.map((s) => ({
      name: s.metadata.name,
      description: s.metadata.description,
      version: s.metadata.version,
      tier: s.tier,
      license: s.metadata.license,
      upstreamUrl: s.metadata.upstreamUrl,
      tags: s.metadata.tags,
      capabilities: s.metadata.capabilities,
    }));
  }

  /**
   * Get ultra-compact catalog for system prompt injection.
   * Enforces Hermes Agent authoring standard: description <= 60 characters.
   */
  getCompactCatalog(): SkillSummary[] {
    const catalog = this.getSkillCatalog();
    return catalog.map((s) => {
      let desc = (s.description || '').trim().replace(/\s+/g, ' ');
      if (desc.length > 60) {
        desc = desc.slice(0, 57).trim() + '...';
      }
      return {
        ...s,
        description: desc,
      };
    });
  }

  /**
   * Get full skill package by name
   */
  getSkill(name: string): SkillPackage | undefined {
    if (this.cachedSkills.size === 0) {
      this.discoverAllSkills();
    }
    return this.cachedSkills.get(name);
  }

  /**
   * Progressive disclosure - Level 3: Load bundled reference or asset on demand
   */
  loadSkillAsset(skillName: string, relativePath: string): string | null {
    const skill = this.getSkill(skillName);
    if (!skill) return null;

    // Prevent path traversal escape
    const resolvedPath = path.resolve(skill.skillDir, relativePath);
    if (!resolvedPath.startsWith(path.resolve(skill.skillDir))) {
      return null;
    }

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
      return null;
    }

    return fs.readFileSync(resolvedPath, 'utf8');
  }

  /**
   * Activate an approved skill into the agent context (Progressive Disclosure - Level 2)
   */
  activateSkill(name: string, enforceAllowlist = true): SkillActivationResult {
    const skill = this.getSkill(name);
    if (!skill) {
      return {
        success: false,
        skillName: name,
        tier: 'builtin',
        instructions: '',
        error: `Skill '${name}' was not found in any discovery tier.`,
      };
    }

    // 1. Run static security audit
    const auditReport = SkillSecurityAuditor.auditSkill(skill);
    if (!auditReport.passed) {
      return {
        success: false,
        skillName: name,
        tier: skill.tier,
        instructions: '',
        auditReport,
        error: `Security audit failed for '${name}' (Severity: ${auditReport.maxSeverity}).`,
      };
    }

    // 2. Check lockfile integrity if present
    const lockfile = SkillLockfile.readLockfile(this.workspaceDir) || SkillLockfile.readLockfile(this.packageRoot);
    if (lockfile) {
      const integrity = SkillLockfile.verifySkillIntegrity(skill, lockfile);
      if (!integrity.valid) {
        return {
          success: false,
          skillName: name,
          tier: skill.tier,
          instructions: '',
          auditReport,
          error: `Integrity check failed: ${integrity.reason}`,
        };
      }
    }

    // 3. Enforce allowlist policy
    if (enforceAllowlist) {
      const allowlist =
        SkillAllowlist.readAllowlist(this.workspaceDir) || SkillAllowlist.readAllowlist(this.packageRoot);
      const allowedCheck = SkillAllowlist.isAllowed(skill, allowlist);
      if (!allowedCheck.allowed) {
        return {
          success: false,
          skillName: name,
          tier: skill.tier,
          instructions: '',
          auditReport,
          error: `Allowlist policy violation: ${allowedCheck.reason}`,
        };
      }
    }

    return {
      success: true,
      skillName: name,
      tier: skill.tier,
      instructions: skill.content,
      auditReport,
    };
  }

  /**
   * Intelligently match and rank registered skills against a user intent, prompt, or task description.
   */
  matchSkillsByIntent(intent: string, maxResults = 3): SkillSummary[] {
    if (!intent || typeof intent !== 'string') {
      return [];
    }

    const intentLower = intent.toLowerCase();
    const catalog = this.getSkillCatalog();
    const scored: Array<{ skill: SkillSummary; score: number }> = [];

    for (const skill of catalog) {
      let score = 0;
      const skillNameLower = skill.name.toLowerCase();
      const descLower = skill.description.toLowerCase();

      // Exact name match
      if (intentLower.includes(skillNameLower) || skillNameLower.includes(intentLower)) {
        score += 10;
      }

      // Tag matching
      if (skill.tags && skill.tags.length > 0) {
        for (const tag of skill.tags) {
          const tagLower = tag.toLowerCase();
          if (intentLower.includes(tagLower)) {
            score += 4;
          }
        }
      }

      // Keyword matching in description
      const words = intentLower.split(/\s+/).filter((w) => w.length > 2);
      for (const w of words) {
        if (descLower.includes(w)) {
          score += 1;
        }
      }

      if (score > 0) {
        scored.push({ skill, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxResults).map((s) => s.skill);
  }

  /**
   * Retrieves instructions markdown body for a specific skill name.
   */
  getSkillInstructions(name: string): string | null {
    const pkg = this.getSkill(name);
    return pkg ? pkg.content : null;
  }
}

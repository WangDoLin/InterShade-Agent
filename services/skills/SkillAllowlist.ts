import fs from 'node:fs';
import path from 'node:path';
import type { SkillCapabilities, SkillPackage } from './SkillLockfile.js';

export interface SkillAllowlistEntry {
  name: string;
  enabled: boolean;
  origin?: 'builtin' | 'upstream' | 'global' | 'workspace';
  provenance?: 'VERIFIED' | 'LOCAL-ONLY' | 'UNVERIFIABLE';
  approvedCommitSha: string;
  approvedContentSha256: string;
  capabilitiesAllowed: SkillCapabilities;
  approvedBy: string;
  approvedAt: string;
  notes?: string;
  quarantineReason?: string;
}

export interface SkillAllowlistData {
  policyVersion: string;
  strictMode: boolean;
  allowUntrustedBuiltin: boolean;
  allowedSkills: Record<string, SkillAllowlistEntry>;
}

export class SkillAllowlist {
  static readonly DEFAULT_FILENAME = 'skills.allowlist.json';

  static readAllowlist(rootDir: string): SkillAllowlistData {
    const filePath = path.join(rootDir, this.DEFAULT_FILENAME);
    if (!fs.existsSync(filePath)) {
      return {
        policyVersion: '1.0.0',
        strictMode: true,
        allowUntrustedBuiltin: false,
        allowedSkills: {},
      };
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(raw) as SkillAllowlistData;
    } catch {
      return {
        policyVersion: '1.0.0',
        strictMode: true,
        allowUntrustedBuiltin: false,
        allowedSkills: {},
      };
    }
  }

  static writeAllowlist(rootDir: string, data: SkillAllowlistData): void {
    const filePath = path.join(rootDir, this.DEFAULT_FILENAME);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  static isAllowed(
    skill: SkillPackage,
    allowlist: SkillAllowlistData
  ): { allowed: boolean; reason?: string } {
    if (!allowlist.strictMode && skill.tier === 'builtin' && allowlist.allowUntrustedBuiltin) {
      return { allowed: true };
    }

    const entry = allowlist.allowedSkills[skill.metadata.name];
    if (!entry) {
      return {
        allowed: false,
        reason: `Skill '${skill.metadata.name}' is not in the approved allowlist (${this.DEFAULT_FILENAME}).`,
      };
    }

    if (!entry.enabled) {
      return {
        allowed: false,
        reason: `Skill '${skill.metadata.name}' is currently disabled in the allowlist.`,
      };
    }

    if (allowlist.strictMode && !entry.approvedContentSha256) {
      return {
        allowed: false,
        reason: `Skill '${skill.metadata.name}' has no approvedContentSha256 digest in strictMode.`,
      };
    }

    if (entry.approvedContentSha256 && entry.approvedContentSha256 !== skill.contentSha256) {
      return {
        allowed: false,
        reason: `Skill '${skill.metadata.name}' content SHA-256 does not match approved digest in allowlist.`,
      };
    }

    // Check capability boundaries
    const skillCaps = skill.metadata.capabilities || {
      scriptExecution: false,
      networkAccess: false,
      filesystemWrite: false,
    };

    if (skillCaps.scriptExecution && !entry.capabilitiesAllowed.scriptExecution) {
      return {
        allowed: false,
        reason: `Skill '${skill.metadata.name}' requests scriptExecution but allowlist forbids script execution for this skill.`,
      };
    }

    if (skillCaps.networkAccess && !entry.capabilitiesAllowed.networkAccess) {
      return {
        allowed: false,
        reason: `Skill '${skill.metadata.name}' requests networkAccess but allowlist forbids network access for this skill.`,
      };
    }

    if (skillCaps.filesystemWrite && !entry.capabilitiesAllowed.filesystemWrite) {
      return {
        allowed: false,
        reason: `Skill '${skill.metadata.name}' requests filesystemWrite but allowlist forbids filesystem modifications.`,
      };
    }

    return { allowed: true };
  }

  static generateAllowlistFromSkills(
    skills: SkillPackage[],
    approvedBy = 'InterShader Security Gate'
  ): SkillAllowlistData {
    const allowed: Record<string, SkillAllowlistEntry> = {};
    for (const skill of skills) {
      allowed[skill.metadata.name] = {
        name: skill.metadata.name,
        enabled: true,
        approvedCommitSha: skill.metadata.commitSha || '',
        approvedContentSha256: skill.contentSha256,
        capabilitiesAllowed: skill.metadata.capabilities || {
          scriptExecution: false,
          networkAccess: false,
          filesystemWrite: false,
        },
        approvedBy,
        approvedAt: new Date().toISOString(),
        notes: `Initial approved baseline for ${skill.metadata.name}`,
      };
    }

    return {
      policyVersion: '1.0.0',
      strictMode: true,
      allowUntrustedBuiltin: false,
      allowedSkills: allowed,
    };
  }
}

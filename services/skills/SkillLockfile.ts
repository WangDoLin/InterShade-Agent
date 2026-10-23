import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SkillCapabilities {
  scriptExecution: boolean;
  networkAccess: boolean;
  filesystemWrite: boolean;
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license: string;
  version: string;
  author?: string;
  upstreamUrl: string;
  commitSha: string;
  compatibility?: {
    node?: string;
    intershade?: string;
  };
  capabilities: SkillCapabilities;
  allowedTools?: string[];
  tags?: string[];
}

export interface SkillPackage {
  metadata: SkillFrontmatter;
  content: string;
  rawFileContent: string;
  skillDir: string;
  tier: 'builtin' | 'global' | 'user' | 'workspace';
  contentSha256: string;
  treeSha256: string;
  assetFiles: string[];
}

export interface SkillLockEntry {
  version: string;
  origin?: 'builtin' | 'upstream' | 'global' | 'workspace';
  provenance?: 'VERIFIED' | 'LOCAL-ONLY' | 'UNVERIFIABLE';
  upstreamUrl: string;
  commitSha: string;
  license: string;
  contentSha256: string;
  treeSha256: string;
  capabilities: SkillCapabilities;
  auditStatus: 'PASSED' | 'FAILED' | 'QUARANTINED';
  lockedAt: string;
}

export interface SkillLockfileData {
  lockfileVersion: string;
  generatedAt: string;
  skills: Record<string, SkillLockEntry>;
}

export class SkillLockfile {
  static readonly DEFAULT_FILENAME = 'skills.lock.json';

  static computeSha256(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  static computeTreeSha256(dirPath: string): string {
    if (!fs.existsSync(dirPath)) {
      return '';
    }
    const hash = crypto.createHash('sha256');
    const walk = (current: string) => {
      const items = fs.readdirSync(current).sort();
      for (const item of items) {
        const fullPath = path.join(current, item);
        const relPath = path.relative(dirPath, fullPath).replace(/\\/g, '/');
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          const fileBytes = fs.readFileSync(fullPath);
          const fileHash = this.computeSha256(fileBytes);
          hash.update(`${relPath}:${fileHash}\n`);
        }
      }
    };
    walk(dirPath);
    return hash.digest('hex');
  }

  static readLockfile(rootDir: string): SkillLockfileData | null {
    const lockPath = path.join(rootDir, this.DEFAULT_FILENAME);
    if (!fs.existsSync(lockPath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      return JSON.parse(raw) as SkillLockfileData;
    } catch {
      return null;
    }
  }

  static writeLockfile(rootDir: string, data: SkillLockfileData): void {
    const lockPath = path.join(rootDir, this.DEFAULT_FILENAME);
    fs.writeFileSync(lockPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }

  static generateLockfile(skills: SkillPackage[]): SkillLockfileData {
    const entries: Record<string, SkillLockEntry> = {};
    for (const skill of skills) {
      entries[skill.metadata.name] = {
        version: skill.metadata.version || '1.0.0',
        upstreamUrl: skill.metadata.upstreamUrl || '',
        commitSha: skill.metadata.commitSha || '',
        license: skill.metadata.license || 'UNLICENSED',
        contentSha256: skill.contentSha256,
        treeSha256: skill.treeSha256,
        capabilities: skill.metadata.capabilities || {
          scriptExecution: false,
          networkAccess: false,
          filesystemWrite: false,
        },
        auditStatus: 'PASSED',
        lockedAt: new Date().toISOString(),
      };
    }

    return {
      lockfileVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      skills: entries,
    };
  }

  static verifySkillIntegrity(
    skill: SkillPackage,
    lockData: SkillLockfileData
  ): { valid: boolean; reason?: string } {
    const entry = lockData.skills[skill.metadata.name];
    if (!entry) {
      return {
        valid: false,
        reason: `Skill '${skill.metadata.name}' is not registered in ${this.DEFAULT_FILENAME}.`,
      };
    }

    if (entry.auditStatus === 'QUARANTINED' || entry.auditStatus === 'FAILED') {
      return {
        valid: false,
        reason: `Skill '${skill.metadata.name}' has auditStatus=${entry.auditStatus} in ${this.DEFAULT_FILENAME}.`,
      };
    }

    if (entry.contentSha256 !== skill.contentSha256) {
      return {
        valid: false,
        reason: `Content SHA-256 digest mismatch for '${skill.metadata.name}'. Expected: ${entry.contentSha256}, actual: ${skill.contentSha256}.`,
      };
    }

    if (entry.treeSha256 && skill.treeSha256 && entry.treeSha256 !== skill.treeSha256) {
      return {
        valid: false,
        reason: `Tree SHA-256 directory digest mismatch for '${skill.metadata.name}'. Expected: ${entry.treeSha256}, actual: ${skill.treeSha256}.`,
      };
    }

    if (
      entry.origin !== 'builtin' &&
      entry.commitSha &&
      skill.metadata.commitSha &&
      entry.commitSha !== skill.metadata.commitSha
    ) {
      return {
        valid: false,
        reason: `Pinned commit SHA mismatch for '${skill.metadata.name}'. Expected: ${entry.commitSha}, actual: ${skill.metadata.commitSha}.`,
      };
    }

    return { valid: true };
  }
}

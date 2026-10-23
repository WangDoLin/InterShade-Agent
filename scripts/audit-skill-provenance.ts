import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillAllowlist, type SkillAllowlistData } from '../services/skills/SkillAllowlist.js';
import { SkillLockfile, type SkillLockfileData } from '../services/skills/SkillLockfile.js';

export interface SkillProvenanceFinding {
  skillName: string;
  source: 'allowlist' | 'lockfile';
  classification: 'VERIFIED' | 'LOCAL-ONLY' | 'UNVERIFIABLE';
  issue?: string;
}

export interface SkillProvenanceReport {
  passed: boolean;
  verifiedCount: number;
  localOnlyCount: number;
  unverifiableCount: number;
  activeViolations: SkillProvenanceFinding[];
  allFindings: SkillProvenanceFinding[];
}

const SEQUENTIAL_HEX_FORWARD = '0123456789abcdef0123456789abcdef';
const SEQUENTIAL_HEX_REVERSE = 'fedcba9876543210fedcba9876543210';

/**
 * Detects fabricated/placeholder 40-char commit SHAs (NEXT-B-09).
 */
export function isFabricatedCommitSha(sha: string | undefined | null): boolean {
  if (!sha) return false;
  const normalized = sha.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    return true;
  }
  // Check for any 8-char sliding window matching sequential hex forward or reverse
  for (let i = 0; i <= SEQUENTIAL_HEX_FORWARD.length - 8; i++) {
    const subFwd = SEQUENTIAL_HEX_FORWARD.slice(i, i + 8);
    const subRev = SEQUENTIAL_HEX_REVERSE.slice(i, i + 8);
    if (normalized.includes(subFwd) || normalized.includes(subRev)) {
      return true;
    }
  }
  return false;
}

/**
 * Audits `skills.allowlist.json` and `skills.lock.json` provenance (NEXT-B-09..10).
 */
export function auditSkillProvenance(
  rootDir: string = process.cwd(),
  options: { fix?: boolean } = {}
): SkillProvenanceReport {
  const allowlist: SkillAllowlistData = SkillAllowlist.readAllowlist(rootDir);
  const lockfile: SkillLockfileData = SkillLockfile.readLockfile(rootDir) || {
    lockfileVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    skills: {},
  };

  const allFindings: SkillProvenanceFinding[] = [];
  const activeViolations: SkillProvenanceFinding[] = [];
  let verifiedCount = 0;
  let localOnlyCount = 0;
  let unverifiableCount = 0;

  // 1. Audit allowlist entries
  for (const [name, entry] of Object.entries(allowlist.allowedSkills)) {
    const localSkillMd = path.join(rootDir, 'skills', name, 'SKILL.md');
    const existsLocally = fs.existsSync(localSkillMd);
    const actualSha256 = existsLocally
      ? SkillLockfile.computeSha256(fs.readFileSync(localSkillMd, 'utf8'))
      : '';

    const hasFakeSha = isFabricatedCommitSha(entry.approvedCommitSha);
    const hasValidDigest = Boolean(
      entry.approvedContentSha256 &&
        existsLocally &&
        entry.approvedContentSha256 === actualSha256
    );

    if (!existsLocally || !hasValidDigest) {
      unverifiableCount++;
      if (options.fix) {
        entry.enabled = false;
        entry.provenance = 'UNVERIFIABLE';
        entry.approvedCommitSha = '';
        entry.quarantineReason =
          'UNVERIFIABLE: missing local skill directory or unverified contentSha256';
      }
      const finding: SkillProvenanceFinding = {
        skillName: name,
        source: 'allowlist',
        classification: 'UNVERIFIABLE',
        issue: entry.enabled
          ? `Unverifiable skill '${name}' is still enabled in skills.allowlist.json`
          : undefined,
      };
      allFindings.push(finding);
      if (entry.enabled) {
        activeViolations.push(finding);
      }
      continue;
    }

    if (hasFakeSha || !entry.approvedCommitSha) {
      localOnlyCount++;
      if (options.fix) {
        entry.origin = 'builtin';
        entry.provenance = 'LOCAL-ONLY';
        entry.approvedCommitSha = '';
      }
      const stillHasFake = isFabricatedCommitSha(entry.approvedCommitSha);
      const finding: SkillProvenanceFinding = {
        skillName: name,
        source: 'allowlist',
        classification: 'LOCAL-ONLY',
        issue: stillHasFake
          ? `Skill '${name}' has fabricated approvedCommitSha in skills.allowlist.json`
          : undefined,
      };
      allFindings.push(finding);
      if (stillHasFake) {
        activeViolations.push(finding);
      }
    } else {
      verifiedCount++;
      if (options.fix) {
        entry.provenance = 'VERIFIED';
      }
      allFindings.push({
        skillName: name,
        source: 'allowlist',
        classification: 'VERIFIED',
      });
    }
  }

  // 2. Audit lockfile entries
  for (const [name, entry] of Object.entries(lockfile.skills)) {
    const localSkillDir = path.join(rootDir, 'skills', name);
    const localSkillMd = path.join(localSkillDir, 'SKILL.md');
    const existsLocally = fs.existsSync(localSkillMd);
    const hasFakeSha = isFabricatedCommitSha(entry.commitSha);

    if (!entry.contentSha256) {
      unverifiableCount++;
      if (options.fix) {
        entry.auditStatus = 'QUARANTINED';
        entry.provenance = 'UNVERIFIABLE';
        entry.commitSha = '';
      }
      const finding: SkillProvenanceFinding = {
        skillName: name,
        source: 'lockfile',
        classification: 'UNVERIFIABLE',
        issue:
          entry.auditStatus !== 'QUARANTINED'
            ? `Unverifiable skill '${name}' is not QUARANTINED in skills.lock.json`
            : undefined,
      };
      allFindings.push(finding);
      if (entry.auditStatus !== 'QUARANTINED') {
        activeViolations.push(finding);
      }
      continue;
    }

    if (hasFakeSha || !entry.commitSha) {
      localOnlyCount++;
      if (options.fix) {
        entry.origin = existsLocally ? 'builtin' : 'global';
        entry.provenance = 'LOCAL-ONLY';
        entry.commitSha = '';
        if (existsLocally) {
          entry.upstreamUrl = '';
        }
      }
      const stillHasFake = isFabricatedCommitSha(entry.commitSha);
      const finding: SkillProvenanceFinding = {
        skillName: name,
        source: 'lockfile',
        classification: 'LOCAL-ONLY',
        issue: stillHasFake
          ? `Skill '${name}' has fabricated commitSha in skills.lock.json`
          : undefined,
      };
      allFindings.push(finding);
      if (stillHasFake) {
        activeViolations.push(finding);
      }
    } else {
      verifiedCount++;
      if (options.fix) {
        entry.provenance = 'VERIFIED';
      }
      allFindings.push({
        skillName: name,
        source: 'lockfile',
        classification: 'VERIFIED',
      });
    }
  }

  if (options.fix) {
    SkillAllowlist.writeAllowlist(rootDir, allowlist);
    SkillLockfile.writeLockfile(rootDir, lockfile);
  }

  return {
    passed: activeViolations.length === 0,
    verifiedCount,
    localOnlyCount,
    unverifiableCount,
    activeViolations,
    allFindings,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const fix = process.argv.includes('--fix');
  const report = auditSkillProvenance(process.cwd(), { fix });
  console.log(
    `[Skill Provenance Audit] VERIFIED=${report.verifiedCount}, LOCAL-ONLY=${report.localOnlyCount}, UNVERIFIABLE=${report.unverifiableCount}, activeViolations=${report.activeViolations.length}`
  );
  if (!report.passed) {
    for (const v of report.activeViolations) {
      console.error(`  - [${v.source}] ${v.skillName}: ${v.issue}`);
    }
    process.exit(1);
  }
}

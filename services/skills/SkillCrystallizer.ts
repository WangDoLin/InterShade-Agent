import fs from 'node:fs';
import path from 'node:path';
import crypto, { randomUUID } from 'node:crypto';
import type { PipelineContext } from '../../engine/pipeline/PipelineStage.js';
import { CanonicalJson } from '../../engine/verification/CanonicalJson.js';
import { IsolatedKeystore } from '../../engine/verification/IsolatedKeystore.js';
import { FtsMemoryService } from '../memory/FtsMemoryService.js';
import { TrajectoryRecorder } from '../memory/TrajectoryRecorder.js';

export interface SkillAttestation {
  keyId: string;
  fingerprintSha256: string;
  payloadSha256: string;
  signatureAlgorithm: 'SHA256withECDSA';
  signatureHex: string;
  signedAt: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  intentTriggers: string[];
  targetPatterns: string[];
  requiredTools: string[];
  capabilities?: {
    scriptExecution: boolean;
    networkAccess: boolean;
    filesystemWrite: boolean;
  };
  workflowStages: string[];
  reusablePrompt: string;
  confidence: number;
  createdAt: number;
  usageCount: number;
  attestation?: SkillAttestation;
}

const ALLOWED_CRYSTALLIZED_TOOLS = new Set(['file_read', 'file_edit', 'grep_search']);

export class SkillCrystallizer {
  private static stripAttestation(skill: SkillDefinition): Omit<SkillDefinition, 'attestation'> {
    const { attestation: _att, ...rest } = skill;
    return rest;
  }

  /**
   * Automatically crystallize a successful 10-stage pipeline run into a signed, capability-bounded skill (NEXT-B-11..12).
   */
  static crystallizeFromPipeline(ctx: PipelineContext): SkillDefinition | null {
    if (ctx.pipelineStatus !== 'SUCCESS') {
      return null;
    }

    const intent = ctx.scopeSpec?.intentSummary || ctx.userPrompt.slice(0, 80);
    const skillName = this.generateSkillName(intent);
    const targetPatterns = Array.from(
      new Set(
        ctx.appliedPatches.map((p) => {
          const ext = path.extname(p.targetFile);
          return ext ? `*${ext}` : path.basename(p.targetFile);
        })
      )
    );

    const triggers = intent
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 8);

    const coreSkill: Omit<SkillDefinition, 'attestation'> = {
      id: randomUUID(),
      name: skillName,
      description: `Automated skill distilled from successful execution: ${intent}`,
      intentTriggers: triggers,
      targetPatterns,
      requiredTools: ['file_read', 'file_edit', 'grep_search'],
      capabilities: {
        scriptExecution: false,
        networkAccess: false,
        filesystemWrite: true,
      },
      workflowStages: [
        'IntentScope',
        'ReconMapping',
        'RedRepro',
        'RootCause',
        'MinimalPlan',
        'PatchGen',
        'ApplySavepoint',
        'GreenVerify',
        'AdversarialAudit',
        'CleanupSynthesis',
      ],
      reusablePrompt: `Apply proven solution pattern for: ${intent}. Target files pattern: ${targetPatterns.join(', ')}.`,
      confidence: ctx.scopeSpec?.confidence || 0.95,
      createdAt: Date.now(),
      usageCount: 1,
    };

    const canonicalPayload = CanonicalJson.stringify(coreSkill);
    const payloadSha256 = crypto.createHash('sha256').update(canonicalPayload, 'utf-8').digest('hex');
    const sig = IsolatedKeystore.signSkillPayload(canonicalPayload);

    const attestation: SkillAttestation = {
      keyId: sig.keyId,
      fingerprintSha256: sig.fingerprintSha256,
      payloadSha256,
      signatureAlgorithm: 'SHA256withECDSA',
      signatureHex: sig.signatureHex,
      signedAt: new Date().toISOString(),
    };

    const skill: SkillDefinition = {
      ...coreSkill,
      attestation,
    };

    // 1. Save skill file and detached attestation to `.intershader/skills/`
    const skillsDir = path.join(ctx.cwd, '.intershader', 'skills');
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    const skillFilePath = path.join(skillsDir, `${skillName}.json`);
    const attestationFilePath = path.join(skillsDir, `${skillName}.attestation.json`);
    fs.writeFileSync(skillFilePath, JSON.stringify(skill, null, 2), 'utf-8');
    fs.writeFileSync(attestationFilePath, JSON.stringify(attestation, null, 2), 'utf-8');
    ctx.logs.push(`Crystallized autonomous skill saved and signed at ${skillFilePath}`);

    // 2. Index into FTS5 memories table for BM25 semantic retrieval
    FtsMemoryService.recordMemory({
      projectId: path.basename(ctx.cwd),
      sessionId: ctx.appliedSavepointId,
      type: 'skill',
      title: `Skill: ${skill.name}`,
      content: `${skill.description} Triggers: ${triggers.join(', ')}. Target patterns: ${targetPatterns.join(', ')}.`,
    });

    // 3. Record full execution trajectory
    TrajectoryRecorder.recordTrajectory({
      sessionId: ctx.appliedSavepointId || 'session-default',
      taskId: skill.id,
      intent,
      prompt: ctx.userPrompt,
      stagesExecuted: skill.workflowStages,
      changedFiles: ctx.appliedPatches.map((p) => p.targetFile),
      status: 'SUCCESS',
      diffStat: ctx.finalDiff,
      reproEvidence: ctx.reproductionVerifiedGreen ? 'Reproduction test verified GREEN' : '',
    });

    return skill;
  }

  /**
   * Verifies a crystallized skill's ECDSA P-256 signature and capability ceiling (NEXT-B-11..12).
   */
  static verifyCrystallizedSkill(
    skill: SkillDefinition,
    detachedAttestation?: SkillAttestation | null
  ): { valid: boolean; reason?: string } {
    // 1. Enforce capability ceiling (never allow scriptExecution or networkAccess on crystallized skills)
    if (skill.capabilities?.scriptExecution || skill.capabilities?.networkAccess) {
      return {
        valid: false,
        reason: `Crystallized skill '${skill.name}' violates capability ceiling (scriptExecution/networkAccess forbidden).`,
      };
    }

    if (
      Array.isArray(skill.requiredTools) &&
      skill.requiredTools.some((t) => !ALLOWED_CRYSTALLIZED_TOOLS.has(t))
    ) {
      return {
        valid: false,
        reason: `Crystallized skill '${skill.name}' requests forbidden tool outside ceiling.`,
      };
    }

    const att = detachedAttestation || skill.attestation;
    if (!att || !att.signatureHex) {
      return {
        valid: false,
        reason: `Crystallized skill '${skill.name}' is missing skill-signer ECDSA attestation.`,
      };
    }

    const canonicalPayload = CanonicalJson.stringify(this.stripAttestation(skill));
    const expectedSha256 = crypto
      .createHash('sha256')
      .update(canonicalPayload, 'utf-8')
      .digest('hex');

    if (att.payloadSha256 !== expectedSha256) {
      return {
        valid: false,
        reason: `Crystallized skill '${skill.name}' payload SHA-256 mismatch (tampered on disk).`,
      };
    }

    const sigValid = IsolatedKeystore.verifySkillSignature(canonicalPayload, att.signatureHex);
    if (!sigValid) {
      return {
        valid: false,
        reason: `Crystallized skill '${skill.name}' failed skill-signer ECDSA P-256 signature verification.`,
      };
    }

    return { valid: true };
  }

  /**
   * Generate clean kebab-case name from intent summary
   */
  private static generateSkillName(intent: string): string {
    const sanitized = intent
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join('-');

    return sanitized || `skill-${Date.now().toString(36)}`;
  }

  /**
   * Load all verified crystallized skills from the workspace (`.intershader/skills/`).
   * Automatically rejects tampered or unsigned crystallized skills (NEXT-B-11..12).
   */
  static loadSkills(workspaceDir: string): SkillDefinition[] {
    const skillsDir = path.join(workspaceDir, '.intershader', 'skills');
    if (!fs.existsSync(skillsDir)) {
      return [];
    }

    const files = fs
      .readdirSync(skillsDir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.attestation.json'));
    const skills: SkillDefinition[] = [];

    for (const f of files) {
      try {
        const fullPath = path.join(skillsDir, f);
        const content = fs.readFileSync(fullPath, 'utf-8');
        const parsed = JSON.parse(content) as SkillDefinition;

        const baseName = f.slice(0, -'.json'.length);
        const attPath = path.join(skillsDir, `${baseName}.attestation.json`);
        const detachedAtt: SkillAttestation | null = fs.existsSync(attPath)
          ? (JSON.parse(fs.readFileSync(attPath, 'utf-8')) as SkillAttestation)
          : null;

        const check = this.verifyCrystallizedSkill(parsed, detachedAtt);
        if (check.valid) {
          skills.push(parsed);
        }
      } catch {
        // Ignore unreadable or malformed skill files
      }
    }

    return skills;
  }

  /**
   * Match an incoming user intent against verified crystallized skills
   */
  static matchSkill(intent: string, workspaceDir: string): SkillDefinition | null {
    const skills = this.loadSkills(workspaceDir);
    if (skills.length === 0) {
      return null;
    }

    const lowerIntent = intent.toLowerCase();
    let bestMatch: SkillDefinition | null = null;
    let maxMatches = 0;

    for (const skill of skills) {
      let matches = 0;
      for (const trigger of skill.intentTriggers) {
        if (lowerIntent.includes(trigger.toLowerCase())) {
          matches++;
        }
      }

      if (matches > maxMatches && matches >= 1) {
        maxMatches = matches;
        bestMatch = skill;
      }
    }

    return bestMatch;
  }
}

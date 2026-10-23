import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { AttestationAuthority, type ProofAttestation } from './AttestationAuthority.js';
import { CanonicalJson } from './CanonicalJson.js';
import { IsolatedKeystore } from './IsolatedKeystore.js';
import { SupplyChainExporter } from './SupplyChainExporter.js';
import { SecretScrubber } from '../../security/SecretScrubber.js';

export interface GateEvidenceArtifact {
  gateId: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED';
  command?: string;
  exitCode?: number;
  startedAt: string;
  completedAt: string;
  executionDurationMs: number;
  evaluatorDecisionDurationMs: number;
  stdoutHashSha256: string;
  stderrHashSha256?: string;
  message: string;
  logArtifactPath?: string;
}

export interface EnvironmentFingerprint {
  os: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  kernel?: string;
  packageManager?: string;
  containerImageDigest?: string;
}

export interface BundleFileEntry {
  name: string;
  size: number;
  digest: {
    sha256: string;
  };
}

export interface SignedBundleIndex {
  _type: 'https://intershader.dev/bundle-index/v1';
  runId: string;
  issuedAt: string;
  builderId: string;
  oracleKeyId: string;
  manifestHashSha256: string;
  files: Record<string, BundleFileEntry>;
  bundleDigestSha256: string;
  signatureAlgorithm: 'SHA256withECDSA';
  signatureHex: string;
}

export type ProofVerdict =
  | 'VERIFIED'
  | 'VERIFIED_WITH_LIMITATIONS'
  | 'REJECTED'
  | 'INCONCLUSIVE'
  | 'VERIFIED SOFTWARE - READY TO COMMIT'
  | 'DEFECTS FOUND - REPAIR REQUIRED';

export interface VerificationPolicySpec {
  policyId: string;
  policyVersion: string;
  requiredGates: string[];
  strictMode: boolean;
  securitySeverityThreshold: 'LOW' | 'MEDIUM' | 'HIGH';
  mutationKillThreshold: number;
  hiddenTestSensitivityThreshold: number;
  attestationRequired: boolean;
}

export const DEFAULT_VERIFICATION_POLICY: VerificationPolicySpec = {
  policyId: 'intershader-proof-policy-v1',
  policyVersion: '1.0',
  requiredGates: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10'],
  strictMode: true,
  securitySeverityThreshold: 'HIGH',
  mutationKillThreshold: 80.0,
  hiddenTestSensitivityThreshold: 90.0,
  attestationRequired: true,
};

export interface ProofManifest {
  protocolVersion?: '1.0';
  runId: string;
  oracleKeyId?: string;
  startedAt: string;
  completedAt: string;
  issuedAt?: string;
  expiresAt?: string;
  nonce?: string;
  challenge?: string;
  workspaceCommit?: string | null;
  verifiedSourceDigest?: string;
  buildArtifactDigest?: string;
  artifactDigest?: string;
  subject?: {
    gitCommit?: string | null;
    verifiedSourceDigest?: string;
    buildArtifactDigest?: string;
    artifactDigest?: string;
    targetFiles?: string[];
  };
  environmentFingerprint?: EnvironmentFingerprint;
  baseImageDigest?: string;
  toolchainFingerprint?: {
    nodeVersion: string;
    platform: string;
    arch: string;
  };
  dependencyFingerprint?: string;
  sbomDigest?: string;
  evaluatorVersion?: string;
  hiddenTestVersion?: string;
  policyVersion?: string;
  policyDigest?: string;
  changedFiles: string[];
  gates: Record<string, GateEvidenceArtifact>;
  overallPassed: boolean;
  score: number;
  riskTier: 'LOW' | 'MEDIUM' | 'HIGH';
  verdict: ProofVerdict;
  verdictConfidence?: number;
  limitations?: string[];
  manifestHashSha256: string;
  attestation?: ProofAttestation;
  mutationMetrics?: {
    mutationScore: number;
    mutantsTested: number;
    mutantsKilled: number;
    hiddenTestSensitivity: 'PASS' | 'FAIL';
  };
}

export class EvidenceStore {
  /**
   * Calculate SHA-256 digest of content string or buffer
   */
  static sha256(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Retrieve current workspace git commit or null if not a Git repository
   */
  static getWorkspaceCommit(cwd: string): string | null {
    try {
      const commit = execSync('git rev-parse HEAD', {
        cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      return /^[0-9a-f]{40}$/i.test(commit) ? commit : null;
    } catch {
      return null;
    }
  }

  /**
   * Compute robust dependency tree fingerprint from lockfiles
   */
  static computeDependencyFingerprint(cwd: string): { fingerprint: string; sbomDigest: string } {
    const lockFiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
    for (const lf of lockFiles) {
      const lockPath = path.join(cwd, lf);
      if (fs.existsSync(lockPath)) {
        try {
          const content = fs.readFileSync(lockPath, 'utf-8');
          const hash = this.sha256(content);
          return {
            fingerprint: `sha256:${hash}`,
            sbomDigest: `sha256:${this.sha256(`${lf}:${hash}:node-${process.versions.node}`)}`,
          };
        } catch {
          // ignore read error
        }
      }
    }
    return {
      fingerprint: `sha256:${this.sha256('standard-workspace-lock')}`,
      sbomDigest: `sha256:${this.sha256('unlocked-environment')}`,
    };
  }

  /**
   * Ensure standard proof protocol directory layout and write evidence log file
   */
  static persistGateLog(
    cwd: string,
    runId: string,
    filename: string,
    content: string
  ): string {
    const proofDir = path.join(cwd, '.intershader', 'proof', runId);
    const evidenceDir = path.join(proofDir, 'evidence');

    if (!fs.existsSync(evidenceDir)) {
      fs.mkdirSync(evidenceDir, { recursive: true });
    }

    const scrubbedContent = SecretScrubber.sanitize(content);
    const evidencePath = path.join(evidenceDir, filename);
    fs.writeFileSync(evidencePath, scrubbedContent, 'utf-8');

    // Also persist in root proof directory for backward compatibility
    const rootPath = path.join(proofDir, filename);
    fs.writeFileSync(rootPath, scrubbedContent, 'utf-8');

    return path.relative(cwd, evidencePath).replace(/\\/g, '/');
  }

  /**
   * Persist full Proof Manifest, Cryptographic Attestation, in-toto, SLSA, and Verdict to disk
   */
  static persistManifest(
    cwd: string,
    manifestWithoutHash: Omit<ProofManifest, 'manifestHashSha256' | 'attestation'>
  ): ProofManifest {
    const proofDir = path.join(cwd, '.intershader', 'proof', manifestWithoutHash.runId);
    if (!fs.existsSync(proofDir)) {
      fs.mkdirSync(proofDir, { recursive: true });
    }

    const exportsDir = path.join(proofDir, 'exports');
    if (!fs.existsSync(exportsDir)) {
      fs.mkdirSync(exportsDir, { recursive: true });
    }

    const keyInfo = IsolatedKeystore.getOrCreateSigningKeyPair();
    const envInfo: EnvironmentFingerprint = {
      os: process.platform,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.versions.node,
      kernel: process.release?.name || 'node',
      packageManager: 'npm',
      containerImageDigest: process.env.CONTAINER_IMAGE_DIGEST,
    };
    const envDigest = `sha256:${this.sha256(JSON.stringify(envInfo))}`;
    const depInfo = this.computeDependencyFingerprint(cwd);
    const policyDigest = `sha256:${CanonicalJson.digestSha256(DEFAULT_VERIFICATION_POLICY)}`;

    const enrichedBase: Omit<ProofManifest, 'manifestHashSha256' | 'attestation'> = {
      protocolVersion: '1.0',
      oracleKeyId: keyInfo.oracleKeyId,
      issuedAt: new Date().toISOString(),
      policyVersion: DEFAULT_VERIFICATION_POLICY.policyVersion,
      policyDigest,
      environmentFingerprint: envInfo,
      baseImageDigest: envDigest,
      toolchainFingerprint: {
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
      dependencyFingerprint: depInfo.fingerprint,
      sbomDigest: depInfo.sbomDigest,
      evaluatorVersion: '2.5.0-attested',
      hiddenTestVersion: '2026.10-v1',
      nonce: crypto.randomBytes(16).toString('hex'),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      ...manifestWithoutHash,
    };

    // Canonical digest calculation (RFC 8785)
    const manifestHash = CanonicalJson.digestSha256(enrichedBase);

    let fullManifest: ProofManifest = {
      ...enrichedBase,
      manifestHashSha256: manifestHash,
    };

    // 1. Issue Cryptographic Attestation via AttestationAuthority
    const attestation = AttestationAuthority.issueAttestation(fullManifest);
    fullManifest = {
      ...fullManifest,
      attestation,
    };

    // 2. Persist root manifest.json & exports/intershader-proof.json
    const manifestPath = path.join(proofDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(fullManifest, null, 2), 'utf-8');
    fs.writeFileSync(path.join(exportsDir, 'intershader-proof.json'), JSON.stringify(fullManifest, null, 2), 'utf-8');

    // 3. Persist root attestation.json
    const attestationPath = path.join(proofDir, 'attestation.json');
    fs.writeFileSync(attestationPath, JSON.stringify(attestation, null, 2), 'utf-8');

    // 4. Export & persist in-toto Attestations
    const intotoPayload = SupplyChainExporter.exportInToto(fullManifest);
    fs.writeFileSync(path.join(proofDir, 'intoto.json'), JSON.stringify(intotoPayload, null, 2), 'utf-8');
    fs.writeFileSync(path.join(exportsDir, 'intoto-statement.json'), JSON.stringify(intotoPayload, null, 2), 'utf-8');

    const testResultPayload = SupplyChainExporter.exportTestResult(fullManifest);
    fs.writeFileSync(path.join(exportsDir, 'in-toto-test-result.json'), JSON.stringify(testResultPayload, null, 2), 'utf-8');

    // 5. Export & persist SLSA Provenance v1.2 (Active) & v1.0 (Legacy)
    const slsa12Payload = SupplyChainExporter.exportSlsaProvenanceV12(fullManifest);
    fs.writeFileSync(path.join(exportsDir, 'slsa-provenance-v1.2.json'), JSON.stringify(slsa12Payload, null, 2), 'utf-8');

    const slsa10Payload = SupplyChainExporter.exportSlsaProvenance(fullManifest);
    fs.writeFileSync(path.join(proofDir, 'slsa-provenance.json'), JSON.stringify(slsa10Payload, null, 2), 'utf-8');
    fs.writeFileSync(path.join(exportsDir, 'slsa-provenance-v1.0.json'), JSON.stringify(slsa10Payload, null, 2), 'utf-8');

    // 6. Generate and persist cryptographically signed Bundle Index (exports/bundle-index.json)
    const exportFileNames = [
      'intershader-proof.json',
      'intoto-statement.json',
      'in-toto-test-result.json',
      'slsa-provenance-v1.2.json',
      'slsa-provenance-v1.0.json',
    ];

    const fileEntries: Record<string, BundleFileEntry> = {};
    for (const fileName of exportFileNames) {
      const filePath = path.join(exportsDir, fileName);
      if (fs.existsSync(filePath)) {
        const fileBuf = fs.readFileSync(filePath);
        fileEntries[fileName] = {
          name: fileName,
          size: fileBuf.length,
          digest: {
            sha256: this.sha256(fileBuf),
          },
        };
      }
    }

    const indexWithoutSig: Omit<SignedBundleIndex, 'bundleDigestSha256' | 'signatureHex'> = {
      _type: 'https://intershader.dev/bundle-index/v1',
      runId: fullManifest.runId,
      issuedAt: new Date().toISOString(),
      builderId: 'https://intershader.dev/attestation-authority/v4.2/local-node-engine',
      oracleKeyId: keyInfo.oracleKeyId,
      manifestHashSha256: fullManifest.manifestHashSha256,
      files: fileEntries,
      signatureAlgorithm: 'SHA256withECDSA',
    };

    const bundleDigestSha256 = CanonicalJson.digestSha256(indexWithoutSig);
    const bundleSigHex = AttestationAuthority.signDigest(bundleDigestSha256, keyInfo.privateKeyPem);

    const signedBundleIndex: SignedBundleIndex = {
      ...indexWithoutSig,
      bundleDigestSha256,
      signatureHex: bundleSigHex,
    };

    fs.writeFileSync(
      path.join(exportsDir, 'bundle-index.json'),
      JSON.stringify(signedBundleIndex, null, 2),
      'utf-8'
    );

    // 7. Persist verdict.json
    const verdictPayload = {
      runId: fullManifest.runId,
      oracleKeyId: keyInfo.oracleKeyId,
      verdict: fullManifest.verdict,
      overallPassed: fullManifest.overallPassed,
      score: fullManifest.score,
      riskTier: fullManifest.riskTier,
      tamperEvident: true,
      challenge: fullManifest.challenge || null,
      signatureHex: attestation.signatureHex,
      bundleDigestSha256,
      timestamp: new Date().toISOString(),
      expiresAt: fullManifest.expiresAt,
    };
    fs.writeFileSync(path.join(proofDir, 'verdict.json'), JSON.stringify(verdictPayload, null, 2), 'utf-8');

    return fullManifest;
  }

  /**
   * Render ASCII Proof Card dynamically from immutable Evidence Manifest
   */
  static renderProofCard(manifest: ProofManifest): string {
    const lines: string[] = [
      '╔═══════════════════════════════════════════════════════════════════════════════╗',
      `║   INTERSHADER PROOF OF VERIFICATION: [${manifest.overallPassed ? 'PASS - VERIFIED' : 'FAIL - REJECTED'}]`.padEnd(79) + '║',
      `║   Run ID: ${manifest.runId.padEnd(20)} Commit: ${(manifest.workspaceCommit || 'none').slice(0, 16).padEnd(16)}`.padEnd(79) + '║',
      '╠═══════════════════════════════════════════════════════════════════════════════╣',
    ];

    for (const gate of Object.values(manifest.gates)) {
      const statusTag = `[${gate.status}]`;
      const timeInfo = gate.command
        ? `exec: ${gate.executionDurationMs}ms | eval: ${gate.evaluatorDecisionDurationMs}ms`
        : `eval: ${gate.evaluatorDecisionDurationMs}ms`;
      const gateLine = `║ ${statusTag.padEnd(8)} ${gate.name.slice(0, 30).padEnd(30)} ${timeInfo.padEnd(36)}`.padEnd(79) + '║';
      lines.push(gateLine);

      if (gate.logArtifactPath) {
        const artifactLine = `║          evidence: ${gate.logArtifactPath.slice(0, 64)}`.padEnd(79) + '║';
        lines.push(artifactLine);
      }
    }

    lines.push('╠═══════════════════════════════════════════════════════════════════════════════╣');
    lines.push(`║ Score: ${manifest.score}/100 | Risk: ${manifest.riskTier} | Changed Files: ${manifest.changedFiles.length}`.padEnd(79) + '║');

    if (manifest.mutationMetrics) {
      lines.push(
        `║ Mutation Score: ${manifest.mutationMetrics.mutationScore}% | Sensitivity: ${manifest.mutationMetrics.hiddenTestSensitivity} | Mutants: ${manifest.mutationMetrics.mutantsKilled}/${manifest.mutationMetrics.mutantsTested}`.padEnd(79) + '║'
      );
    }

    lines.push(`║ SHA-256 Digest: ${manifest.manifestHashSha256.slice(0, 48)}...`.padEnd(79) + '║');

    const keyIdStr = manifest.oracleKeyId ? `Key ID: ${manifest.oracleKeyId}` : 'Oracle Root';
    const sigStr = manifest.attestation
      ? `ECDSA P-256 (${manifest.attestation.signatureHex.slice(0, 14)}...)`
      : 'Unsigned';
    lines.push(`║ Attestation: ${sigStr} | ${keyIdStr}`.padEnd(79) + '║');
    lines.push(`║ Verdict: ${manifest.verdict}`.padEnd(79) + '║');
    lines.push('╚═══════════════════════════════════════════════════════════════════════════════╝');

    return lines.join('\n');
  }
}

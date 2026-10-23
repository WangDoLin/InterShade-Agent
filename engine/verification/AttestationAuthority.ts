import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProofManifest, SignedBundleIndex } from './EvidenceStore.js';
import { IsolatedKeystore } from './IsolatedKeystore.js';
import { CanonicalJson } from './CanonicalJson.js';
import { StandaloneVerifier, type StandaloneVerifierVerdict } from './StandaloneVerifier.js';

export interface ProofAttestation {
  oracleId: string;
  oracleKeyId: string;
  publicKeyPem: string;
  publicKeyFingerprint: string;
  signatureAlgorithm: 'SHA256withECDSA';
  signatureHex: string;
  signedAt: string;
  manifestHashSha256: string;
  evaluatorMetadata: {
    engineVersion: string;
    nodeVersion: string;
    os: string;
    arch: string;
  };
}

export interface AttestationVerificationReport {
  isValid: boolean;
  verdict:
    | 'ATTESTED_VALID'
    | 'FORGERY_OR_TAMPER_DETECTED'
    | 'EXPORT_BUNDLE_TAMPERED'
    | 'UNTRUSTED_ORACLE_KEY'
    | 'PROOF_EXPIRED'
    | 'CHALLENGE_MISMATCH'
    | 'REPLAY_ATTACK_DETECTED'
    | 'INVALID_STRUCTURE';
  errors: string[];
  manifest?: ProofManifest;
  attestation?: ProofAttestation;
  verifiedGatesCount: number;
}

export interface VerifyProofOptions {
  expectedChallenge?: string;
  consumeChallenge?: boolean;
}

export const GENESIS_RECORD_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

export interface ConsumedChallengeRecord {
  recordIndex: number;
  challenge: string;
  consumedAt: string;
  verifierIdentity?: string;
  proofId?: string;
  previousRecordHash: string;
  recordHash: string;
  status: 'CONSUMED';
}

export interface CheckpointAnchor {
  headIndex: number;
  headHash: string;
  updatedAt: string;
  anchorIdentity: string;
}

/**
 * ChallengeRegistry: Monotonic hash-chained anti-replay registry.
 *
 * Threat Model & Trust Boundary:
 * 1. Tamper-Evidence: Each consumed challenge is cryptographically chained (SHA-256) to the previous record hash.
 * 2. Monotonic Checkpointing: Defends against local registry-only snapshot rollback (e.g. restoring an older
 *    consumed-challenges.json while trusted-checkpoint.json preserves monotonic sequence height).
 * 3. Trust Boundary Clarification: If an attacker possesses unrestricted write access to both
 *    consumed-challenges.json and trusted-checkpoint.json under the same local OS user credentials,
 *    simultaneous snapshot restoration of both files is possible. Full cryptographic non-repudiation
 *    against arbitrary local filesystem manipulation requires external anchoring (OS DPAPI / TPM / KMS)
 *    or verifier-authoritative challenge generation (as implemented in CI pipelines).
 */
export class ChallengeRegistry {
  private static consumedRecords: Map<string, ConsumedChallengeRecord> | null = null;

  private static getStoragePath(): string {
    const dir = IsolatedKeystore.getTrustStoreDir();
    return path.join(dir, 'consumed-challenges.json');
  }

  static getCheckpointPath(): string {
    const dir = IsolatedKeystore.getTrustStoreDir();
    return path.join(dir, 'trusted-checkpoint.json');
  }

  private static getLockPath(): string {
    const dir = IsolatedKeystore.getTrustStoreDir();
    return path.join(dir, 'challenge-registry.lock');
  }

  /**
   * Atomic write via temporary sibling file + rename to prevent torn writes (NEXT-B-20).
   */
  private static atomicWriteJson(filePath: string, data: unknown): void {
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
      try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
      } catch {
        // ignore fallback write error
      }
    }
  }

  /**
   * Inter-process advisory lock with stale-lock eviction (NEXT-B-20).
   */
  static withFileLock<T>(fn: () => T): T {
    const lockPath = this.getLockPath();
    let acquiredFd: number | null = null;
    const deadline = Date.now() + 2000;

    while (Date.now() < deadline) {
      try {
        acquiredFd = fs.openSync(lockPath, 'wx');
        fs.writeFileSync(acquiredFd, `${process.pid}:${Date.now()}`);
        break;
      } catch {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 10000) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // Lock was already released
        }
      }
    }

    try {
      return fn();
    } finally {
      if (acquiredFd !== null) {
        try {
          fs.closeSync(acquiredFd);
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      }
    }
  }

  static computeRecordHash(params: {
    recordIndex: number;
    challenge: string;
    consumedAt: string;
    verifierIdentity?: string;
    proofId?: string;
    previousRecordHash: string;
  }): string {
    const content = `${params.recordIndex}:${params.challenge.toLowerCase()}:${params.consumedAt}:${params.verifierIdentity || ''}:${params.proofId || ''}:${params.previousRecordHash}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  static loadCheckpoint(): CheckpointAnchor | null {
    const cpPath = this.getCheckpointPath();
    if (fs.existsSync(cpPath)) {
      try {
        const raw = fs.readFileSync(cpPath, 'utf-8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return null;
  }

  static saveCheckpoint(anchorIdentity: string = 'trusted-local-anchor'): CheckpointAnchor {
    const records = Array.from(this.load().values());
    const headIndex = records.length > 0 ? records[records.length - 1].recordIndex : -1;
    const headHash = records.length > 0 ? records[records.length - 1].recordHash : GENESIS_RECORD_HASH;
    const checkpoint: CheckpointAnchor = {
      headIndex,
      headHash,
      updatedAt: new Date().toISOString(),
      anchorIdentity,
    };
    const cpPath = this.getCheckpointPath();
    this.atomicWriteJson(cpPath, checkpoint);
    return checkpoint;
  }

  private static load(): Map<string, ConsumedChallengeRecord> {
    if (this.consumedRecords) return this.consumedRecords;
    this.consumedRecords = new Map();
    const filePath = this.getStoragePath();
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          let prevHash = GENESIS_RECORD_HASH;
          for (let i = 0; i < list.length; i++) {
            const item = list[i];
            const ch = typeof item === 'string' ? item.toLowerCase() : item?.challenge?.toLowerCase();
            if (!ch) continue;

            const consumedAt = item?.consumedAt || new Date().toISOString();
            const verifierIdentity = item?.verifierIdentity || 'intershader-verifier';
            const proofId = item?.proofId;
            const recordIndex = typeof item?.recordIndex === 'number' ? item.recordIndex : i;
            const previousRecordHash = item?.previousRecordHash || prevHash;
            const recordHash = item?.recordHash || this.computeRecordHash({
              recordIndex,
              challenge: ch,
              consumedAt,
              verifierIdentity,
              proofId,
              previousRecordHash,
            });

            const record: ConsumedChallengeRecord = {
              recordIndex,
              challenge: ch,
              consumedAt,
              verifierIdentity,
              proofId,
              previousRecordHash,
              recordHash,
              status: 'CONSUMED',
            };
            this.consumedRecords.set(ch, record);
            prevHash = recordHash;
          }
        }
      } catch {
        // ignore read error
      }
    }
    return this.consumedRecords;
  }

  private static save(): void {
    const filePath = this.getStoragePath();
    const records = Array.from(this.load().values());
    this.atomicWriteJson(filePath, records);
  }

  static isConsumed(challenge: string): boolean {
    return this.load().has(challenge.toLowerCase());
  }

  static getRecord(challenge: string): ConsumedChallengeRecord | undefined {
    return this.load().get(challenge.toLowerCase());
  }

  static consume(
    challenge: string,
    metadata?: { verifierIdentity?: string; proofId?: string }
  ): ConsumedChallengeRecord {
    return this.withFileLock(() => {
      this.consumedRecords = null;
      const records = Array.from(this.load().values());
      const recordIndex = records.length;
      const previousRecordHash = recordIndex === 0
        ? GENESIS_RECORD_HASH
        : records[recordIndex - 1].recordHash || GENESIS_RECORD_HASH;
      const consumedAt = new Date().toISOString();
      const verifierIdentity = metadata?.verifierIdentity || 'intershader-verifier';
      const proofId = metadata?.proofId;

      const recordHash = this.computeRecordHash({
        recordIndex,
        challenge: challenge.toLowerCase(),
        consumedAt,
        verifierIdentity,
        proofId,
        previousRecordHash,
      });

      const record: ConsumedChallengeRecord = {
        recordIndex,
        challenge: challenge.toLowerCase(),
        consumedAt,
        verifierIdentity,
        proofId,
        previousRecordHash,
        recordHash,
        status: 'CONSUMED',
      };
      this.load().set(challenge.toLowerCase(), record);
      this.save();
      this.saveCheckpoint(verifierIdentity);
      return record;
    });
  }

  static verifyRegistryIntegrity(): { isValid: boolean; error?: string } {
    const records = Array.from(this.load().values());
    let prevHash = GENESIS_RECORD_HASH;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.recordIndex !== i) {
        return { isValid: false, error: `Invalid record index at position ${i}: expected ${i}, found ${rec.recordIndex}` };
      }
      if (rec.previousRecordHash !== prevHash) {
        return { isValid: false, error: `Hash chain broken at index ${i}: expected previous ${prevHash}, found ${rec.previousRecordHash}` };
      }
      const expectedHash = this.computeRecordHash(rec);
      if (rec.recordHash !== expectedHash) {
        return { isValid: false, error: `Record hash tampering detected at index ${i}` };
      }
      prevHash = rec.recordHash;
    }

    // Monotonic Checkpoint Rollback Verification
    const checkpoint = this.loadCheckpoint();
    if (checkpoint && checkpoint.headIndex >= 0) {
      const currentHeadIndex = records.length > 0 ? records[records.length - 1].recordIndex : -1;
      if (currentHeadIndex < checkpoint.headIndex) {
        return {
          isValid: false,
          error: `REGISTRY_ROLLBACK_DETECTED: Local registry head index (${currentHeadIndex}) is behind monotonic checkpoint (${checkpoint.headIndex})`,
        };
      }
      const checkpointRecord = records.find((r) => r.recordIndex === checkpoint.headIndex);
      if (!checkpointRecord || checkpointRecord.recordHash !== checkpoint.headHash) {
        return {
          isValid: false,
          error: `REGISTRY_ROLLBACK_DETECTED: Local registry hash at index ${checkpoint.headIndex} diverged from monotonic checkpoint hash`,
        };
      }
    }

    return { isValid: true };
  }

  static clear(): void {
    this.consumedRecords = new Map();
    const filePath = this.getStoragePath();
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore unlink error
      }
    }
    const cpPath = this.getCheckpointPath();
    if (fs.existsSync(cpPath)) {
      try {
        fs.unlinkSync(cpPath);
      } catch {
        // ignore unlink error
      }
    }
  }

  static resetMemoryCache(): void {
    this.consumedRecords = null;
  }
}

export class AttestationAuthority {
  /**
   * Cryptographically sign a SHA-256 digest using ECDSA
   */
  static signDigest(digestSha256: string, privateKeyPem: string): string {
    const sign = crypto.createSign('SHA256');
    sign.update(Buffer.from(digestSha256, 'hex'));
    sign.end();
    return sign.sign(privateKeyPem, 'hex');
  }

  /**
   * Verify an ECDSA signature against the provided public key and digest
   */
  static verifySignature(digestSha256: string, signatureHex: string, publicKeyPem: string): boolean {
    try {
      const verify = crypto.createVerify('SHA256');
      verify.update(Buffer.from(digestSha256, 'hex'));
      verify.end();
      return verify.verify(publicKeyPem, signatureHex, 'hex');
    } catch {
      return false;
    }
  }

  /**
   * Issue a tamper-evident Cryptographic Attestation from isolated keystore
   */
  static issueAttestation(
    manifest: ProofManifest,
    privateKeyPem?: string,
    publicKeyPem?: string
  ): ProofAttestation {
    const keyInfo = IsolatedKeystore.getOrCreateSigningKeyPair();
    const privKey = privateKeyPem || keyInfo.privateKeyPem;
    const pubKey = publicKeyPem || keyInfo.publicKeyPem;
    const fingerprint = IsolatedKeystore.computeFingerprint(pubKey);
    const oracleKeyId = keyInfo.oracleKeyId;

    const signatureHex = this.signDigest(manifest.manifestHashSha256, privKey);

    return {
      oracleId: 'intershader-verification-oracle-v4',
      oracleKeyId,
      publicKeyPem: pubKey,
      publicKeyFingerprint: fingerprint,
      signatureAlgorithm: 'SHA256withECDSA',
      signatureHex,
      signedAt: new Date().toISOString(),
      manifestHashSha256: manifest.manifestHashSha256,
      evaluatorMetadata: {
        engineVersion: '2.5.0-attested',
        nodeVersion: process.versions.node,
        os: process.platform,
        arch: process.arch,
      },
    };
  }

  /**
   * Cryptographically verify export bundle against its SignedBundleIndex.
   * Delegates to StandaloneVerifier for strict canonical index check, trust root validation,
   * path traversal defense, and bi-directional missing/unlisted artifact audit.
   */
  static verifyExportBundle(
    exportsDirPath: string,
    expectedManifestHash?: string,
    oraclePublicKeyPem?: string
  ): {
    isValid: boolean;
    verdict: 'BUNDLE_VALID' | 'EXPORT_BUNDLE_TAMPERED';
    detailedVerdict: StandaloneVerifierVerdict;
    reason: string;
    errors: string[];
    details?: any;
  } {
    const report = StandaloneVerifier.verifyExportBundle(exportsDirPath, {
      expectedManifestHash,
      trustedRootKeyPem: oraclePublicKeyPem,
      enforceTrustStore: true,
    });

    return {
      isValid: report.isAccepted,
      verdict: report.isAccepted ? 'BUNDLE_VALID' : 'EXPORT_BUNDLE_TAMPERED',
      detailedVerdict: report.verdict,
      reason: report.reason,
      errors: report.errors.length > 0 ? report.errors : (report.isAccepted ? [] : [report.reason]),
      details: report.details,
    };
  }


  /**
   * Independently verify proof directory against external Trust Store (Oracle Trust Root)
   * Supports challenge-based anti-replay verification
   */
  static verifyProofDirectory(
    proofDirPath: string,
    options?: VerifyProofOptions
  ): AttestationVerificationReport {
    const errors: string[] = [];

    if (!fs.existsSync(proofDirPath)) {
      return {
        isValid: false,
        verdict: 'INVALID_STRUCTURE',
        errors: [`Proof directory does not exist: ${proofDirPath}`],
        verifiedGatesCount: 0,
      };
    }

    const manifestPath = path.join(proofDirPath, 'manifest.json');
    const attestationPath = path.join(proofDirPath, 'attestation.json');

    if (!fs.existsSync(manifestPath)) {
      return {
        isValid: false,
        verdict: 'INVALID_STRUCTURE',
        errors: ['manifest.json is missing from proof directory.'],
        verifiedGatesCount: 0,
      };
    }

    if (!fs.existsSync(attestationPath)) {
      return {
        isValid: false,
        verdict: 'INVALID_STRUCTURE',
        errors: ['attestation.json is missing. Proof lacks cryptographic digital signature.'],
        verifiedGatesCount: 0,
      };
    }

    let manifest: ProofManifest;
    let attestation: ProofAttestation;

    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      attestation = JSON.parse(fs.readFileSync(attestationPath, 'utf-8'));
    } catch (err: any) {
      return {
        isValid: false,
        verdict: 'INVALID_STRUCTURE',
        errors: [`JSON deserialization failed: ${err.message}`],
        verifiedGatesCount: 0,
      };
    }

    // 1. TRUST ROOT DEFENSE: Verify that the signing key is registered in Trust Store
    const isKeyTrusted = IsolatedKeystore.isTrustedPublicKey(attestation.publicKeyPem);
    if (!isKeyTrusted) {
      return {
        isValid: false,
        verdict: 'UNTRUSTED_ORACLE_KEY',
        errors: [
          `Public key (fingerprint: ${attestation.publicKeyFingerprint || 'unknown'}) is NOT registered in Trust Store (~/.intershader/trust/). Key-substitution forgery detected!`,
        ],
        manifest,
        attestation,
        verifiedGatesCount: 0,
      };
    }

    // 2. PROOF EXPIRATION / TTL CHECK
    if ((manifest as any).expiresAt) {
      const expirationTimestamp = Date.parse((manifest as any).expiresAt);
      if (Date.now() > expirationTimestamp) {
        return {
          isValid: false,
          verdict: 'PROOF_EXPIRED',
          errors: [`Proof expired at ${(manifest as any).expiresAt}. Time-to-live exceeded.`],
          manifest,
          attestation,
          verifiedGatesCount: 0,
        };
      }
    }

    // 3. CHALLENGE-BASED ANTI-REPLAY CHECK
    if (options?.expectedChallenge) {
      const recordedChallenge = manifest.challenge || '';
      if (recordedChallenge.toLowerCase() !== options.expectedChallenge.toLowerCase()) {
        return {
          isValid: false,
          verdict: 'CHALLENGE_MISMATCH',
          errors: [
            `Challenge mismatch: expected '${options.expectedChallenge}', but proof contains '${recordedChallenge || 'none'}'. Replayed or stale proof rejected!`,
          ],
          manifest,
          attestation,
          verifiedGatesCount: 0,
        };
      }
    }

    // Check challenge consumption in replay registry
    if (options?.consumeChallenge && manifest.challenge) {
      const integrity = ChallengeRegistry.verifyRegistryIntegrity();
      if (!integrity.isValid) {
        return {
          isValid: false,
          verdict: 'REPLAY_ATTACK_DETECTED',
          errors: [`Replay defense integrity compromised: ${integrity.error}`],
          manifest,
          attestation,
          verifiedGatesCount: 0,
        };
      }

      if (ChallengeRegistry.isConsumed(manifest.challenge)) {
        return {
          isValid: false,
          verdict: 'REPLAY_ATTACK_DETECTED',
          errors: [
            `Replay attack detected: challenge '${manifest.challenge}' has already been consumed in a prior verification session!`,
          ],
          manifest,
          attestation,
          verifiedGatesCount: 0,
        };
      }
      ChallengeRegistry.consume(manifest.challenge, { proofId: manifest.runId });
    }

    // 4. CANONICAL MANIFEST HASH VERIFICATION
    const manifestWithoutHash: Record<string, any> = { ...manifest };
    delete manifestWithoutHash.manifestHashSha256;
    delete manifestWithoutHash.attestation;

    // Support both canonical and legacy stringification for hash verification
    const canonicalHash = CanonicalJson.digestSha256(manifestWithoutHash);
    const legacyHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(manifestWithoutHash, null, 2))
      .digest('hex');

    if (
      manifest.manifestHashSha256 !== canonicalHash &&
      manifest.manifestHashSha256 !== legacyHash
    ) {
      errors.push(
        `Manifest hash mismatch: manifest was modified post-generation. (Recorded: ${manifest.manifestHashSha256.slice(0, 16)}..., Recomputed: ${canonicalHash.slice(0, 16)}...)`
      );
    }

    // 5. VERIFY DIGITAL SIGNATURE
    const isSignatureValid = this.verifySignature(
      manifest.manifestHashSha256,
      attestation.signatureHex,
      attestation.publicKeyPem
    );

    if (!isSignatureValid) {
      errors.push('Digital signature invalid: proof was tampered with or signed by unauthorized private key.');
    }

    if (attestation.manifestHashSha256 !== manifest.manifestHashSha256) {
      errors.push('Attestation manifestHashSha256 does not match recorded manifest hash.');
    }

    // 6. VERIFY RAW EVIDENCE FILES ON DISK
    let verifiedGatesCount = 0;
    const baseDir = path.dirname(proofDirPath);

    for (const [gateId, gateArtifact] of Object.entries(manifest.gates)) {
      if (gateArtifact.logArtifactPath) {
        let artifactFullPath = path.resolve(baseDir, '..', '..', gateArtifact.logArtifactPath);
        if (!fs.existsSync(artifactFullPath)) {
          artifactFullPath = path.resolve(proofDirPath, path.basename(gateArtifact.logArtifactPath));
        }
        if (!fs.existsSync(artifactFullPath)) {
          artifactFullPath = path.resolve(proofDirPath, 'evidence', path.basename(gateArtifact.logArtifactPath));
        }

        if (!fs.existsSync(artifactFullPath)) {
          errors.push(`Missing evidence file for gate ${gateId}: ${gateArtifact.logArtifactPath}`);
        } else {
          verifiedGatesCount++;
        }
      }
    }

    // 7. CRYPTOGRAPHIC EXPORT BUNDLE INTEGRITY CHECK
    let isBundleTampered = false;
    const exportsDir = path.join(proofDirPath, 'exports');
    if (fs.existsSync(exportsDir)) {
      const bundleReport = this.verifyExportBundle(
        exportsDir,
        manifest.manifestHashSha256,
        attestation.publicKeyPem
      );
      if (!bundleReport.isValid) {
        isBundleTampered = true;
        errors.push(...bundleReport.errors);
      }
    }

    const isValid = errors.length === 0;
    const verdict = isValid
      ? 'ATTESTED_VALID'
      : isBundleTampered
        ? 'EXPORT_BUNDLE_TAMPERED'
        : 'FORGERY_OR_TAMPER_DETECTED';

    return {
      isValid,
      verdict,
      errors,
      manifest,
      attestation,
      verifiedGatesCount,
    };
  }
}

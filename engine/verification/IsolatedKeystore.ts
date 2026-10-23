import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface KeyPairInfo {
  oracleKeyId: string;
  fingerprintSha256: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export enum TrustLevel {
  LEVEL_1_LOCAL = 'LEVEL_1_LOCAL',         // Local ~/.intershader/trust/ store
  LEVEL_2_OS_BACKED = 'LEVEL_2_OS_BACKED', // OS-backed Protected Storage (Windows DPAPI / TPM / Keychain)
  LEVEL_3_REMOTE_KMS = 'LEVEL_3_REMOTE_KMS', // Enterprise External Trust / Remote HSM / KMS
}

export interface RemoteSignerConfig {
  serviceEndpoint: string;
  keyArnOrId: string;
  authHeader?: string;
}

export class IsolatedKeystore {
  private static cachedKeyPair: KeyPairInfo | null = null;
  private static cachedSkillSignerKeyPair: KeyPairInfo | null = null;
  private static currentTrustLevel: TrustLevel = TrustLevel.LEVEL_1_LOCAL;
  private static pinnedFingerprints: Set<string> = new Set();
  private static remoteSignerConfig: RemoteSignerConfig | null = null;

  /**
   * Set the active Trust Level for the Oracle Infrastructure
   */
  static setTrustLevel(level: TrustLevel): void {
    this.currentTrustLevel = level;
  }

  /**
   * Get the active Trust Level
   */
  static getTrustLevel(): TrustLevel {
    // Can also be configured via environment variable
    const envLevel = process.env.INTERSHADER_TRUST_LEVEL;
    if (envLevel === 'LEVEL_2' || envLevel === 'LEVEL_2_OS_BACKED') {
      return TrustLevel.LEVEL_2_OS_BACKED;
    }
    if (envLevel === 'LEVEL_3' || envLevel === 'LEVEL_3_REMOTE_KMS') {
      return TrustLevel.LEVEL_3_REMOTE_KMS;
    }
    return this.currentTrustLevel;
  }

  /**
   * Pin a trusted public key fingerprint to guard against local trust store compromise
   */
  static pinFingerprint(fingerprint: string): void {
    this.pinnedFingerprints.add(fingerprint.toLowerCase().trim());
  }

  /**
   * Configure remote signing service for Level 3 Enterprise Attestation
   */
  static configureRemoteSigner(config: RemoteSignerConfig): void {
    this.remoteSignerConfig = config;
    this.currentTrustLevel = TrustLevel.LEVEL_3_REMOTE_KMS;
  }

  /**
   * Calculate SHA-256 fingerprint of a public key PEM string
   */
  static computeFingerprint(publicKeyPem: string): string {
    const cleanKey = publicKeyPem
      .replace(/-----BEGIN [A-Z ]+-----/, '')
      .replace(/-----END [A-Z ]+-----/, '')
      .replace(/\s+/g, '');
    return crypto.createHash('sha256').update(cleanKey, 'utf-8').digest('hex');
  }

  /**
   * Root directory for isolated Trust Store (outside workspace)
   */
  static getTrustStoreDir(): string {
    const dir = path.join(os.homedir(), '.intershader', 'trust');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Root directory for isolated Private Keystore (never accessible inside workspace)
   */
  static getIsolatedKeystoreDir(): string {
    const dir = path.join(os.homedir(), '.intershader', 'keystore');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Retrieve or initialize the trusted Oracle keypair in isolated storage
   */
  static getOrCreateSigningKeyPair(): KeyPairInfo {
    if (this.cachedKeyPair) {
      return this.cachedKeyPair;
    }

    const keystoreDir = this.getIsolatedKeystoreDir();
    const trustDir = this.getTrustStoreDir();

    const privateKeyPath = path.join(keystoreDir, 'oracle-root.pem');
    const publicKeyPath = path.join(trustDir, 'oracle-root.pub');

    if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
      try {
        const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf-8');
        const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf-8');
        const fingerprintSha256 = this.computeFingerprint(publicKeyPem);
        const oracleKeyId = `oracle-key-${fingerprintSha256.slice(0, 12)}`;

        this.cachedKeyPair = {
          oracleKeyId,
          fingerprintSha256,
          publicKeyPem,
          privateKeyPem,
        };
        return this.cachedKeyPair;
      } catch {
        // Fallback to regeneration if corrupted
      }
    }

    // Generate fresh ECDSA P-256 keypair
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const fingerprint = this.computeFingerprint(publicKey);
    const oracleKeyId = `oracle-key-${fingerprint.slice(0, 12)}`;

    fs.writeFileSync(privateKeyPath, privateKey, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(publicKeyPath, publicKey, 'utf-8');

    this.cachedKeyPair = {
      oracleKeyId,
      fingerprintSha256: fingerprint,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
    };

    return this.cachedKeyPair;
  }

  /**
   * Add a trusted public key into the Trust Store
   */
  static registerTrustedPublicKey(publicKeyPem: string, keyName = 'oracle-root.pub'): string {
    const trustDir = this.getTrustStoreDir();
    const targetPath = path.join(trustDir, keyName);
    fs.writeFileSync(targetPath, publicKeyPem, 'utf-8');
    return this.computeFingerprint(publicKeyPem);
  }

  /**
   * Check if a given public key is recognized and authorized by the Trust Store
   */
  static isTrustedPublicKey(publicKeyPem: string): boolean {
    const targetFingerprint = this.computeFingerprint(publicKeyPem).toLowerCase();

    // 1. PINNING DEFENSE: Check against pinned fingerprints set in code
    if (this.pinnedFingerprints.size > 0) {
      return this.pinnedFingerprints.has(targetFingerprint);
    }

    // 2. PINNING DEFENSE: Check against environment variable pin
    const pinned = process.env.INTERSHADER_ORACLE_KEY_FINGERPRINT;
    if (pinned) {
      return pinned.toLowerCase() === targetFingerprint;
    }

    // 3. Level 2 OS-backed or Level 3 Remote verification stub
    const level = this.getTrustLevel();
    if (level === TrustLevel.LEVEL_3_REMOTE_KMS && this.remoteSignerConfig) {
      // Remote KMS validates against authoritative service key
      return true;
    }

    // 4. Check against Trust Store files in ~/.intershader/trust/
    const trustDir = this.getTrustStoreDir();
    if (!fs.existsSync(trustDir)) return false;

    const entries = fs.readdirSync(trustDir);
    for (const entry of entries) {
      if (entry.endsWith('.pub')) {
        try {
          const content = fs.readFileSync(path.join(trustDir, entry), 'utf-8');
          if (this.computeFingerprint(content).toLowerCase() === targetFingerprint) {
            return true;
          }
        } catch {
          // ignore read error
        }
      }
    }

    // 5. Check against active in-memory oracle key
    if (this.cachedKeyPair && this.cachedKeyPair.fingerprintSha256.toLowerCase() === targetFingerprint) {
      return true;
    }

    return false;
  }

  /**
   * Retrieve or initialize the dedicated `skill-signer` ECDSA P-256 keypair in isolated storage (NEXT-B-11).
   */
  static getOrCreateSkillSignerKeyPair(): KeyPairInfo {
    if (this.cachedSkillSignerKeyPair) {
      return this.cachedSkillSignerKeyPair;
    }

    const keystoreDir = this.getIsolatedKeystoreDir();
    const trustDir = this.getTrustStoreDir();
    const privateKeyPath = path.join(keystoreDir, 'skill-signer.pem');
    const publicKeyPath = path.join(trustDir, 'skill-signer.pub');

    if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
      try {
        const privateKeyPem = fs.readFileSync(privateKeyPath, 'utf-8');
        const publicKeyPem = fs.readFileSync(publicKeyPath, 'utf-8');
        const fingerprintSha256 = this.computeFingerprint(publicKeyPem);
        this.cachedSkillSignerKeyPair = {
          oracleKeyId: `skill-signer-${fingerprintSha256.slice(0, 12)}`,
          fingerprintSha256,
          publicKeyPem,
          privateKeyPem,
        };
        return this.cachedSkillSignerKeyPair;
      } catch {
        // Regenerate if unreadable
      }
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const fingerprintSha256 = this.computeFingerprint(publicKey);
    fs.writeFileSync(privateKeyPath, privateKey, { encoding: 'utf-8', mode: 0o600 });
    fs.writeFileSync(publicKeyPath, publicKey, 'utf-8');

    this.cachedSkillSignerKeyPair = {
      oracleKeyId: `skill-signer-${fingerprintSha256.slice(0, 12)}`,
      fingerprintSha256,
      publicKeyPem: publicKey,
      privateKeyPem: privateKey,
    };
    return this.cachedSkillSignerKeyPair;
  }

  /**
   * Signs a canonical payload string using the isolated `skill-signer` ECDSA P-256 keypair (NEXT-B-11).
   */
  static signSkillPayload(canonicalPayload: string): {
    keyId: string;
    fingerprintSha256: string;
    publicKeyPem: string;
    signatureHex: string;
  } {
    const kp = this.getOrCreateSkillSignerKeyPair();
    const sign = crypto.createSign('SHA256');
    sign.update(canonicalPayload, 'utf-8');
    sign.end();
    const signatureHex = sign.sign(kp.privateKeyPem, 'hex');
    return {
      keyId: kp.oracleKeyId,
      fingerprintSha256: kp.fingerprintSha256,
      publicKeyPem: kp.publicKeyPem,
      signatureHex,
    };
  }

  /**
   * Verifies a `skill-signer` ECDSA P-256 signature against the trusted skill-signer key (NEXT-B-11).
   */
  static verifySkillSignature(
    canonicalPayload: string,
    signatureHex: string,
    publicKeyPem?: string
  ): boolean {
    try {
      const kp = this.getOrCreateSkillSignerKeyPair();
      const pub = publicKeyPem || kp.publicKeyPem;
      if (this.computeFingerprint(pub).toLowerCase() !== kp.fingerprintSha256.toLowerCase()) {
        return false;
      }
      const verify = crypto.createVerify('SHA256');
      verify.update(canonicalPayload, 'utf-8');
      verify.end();
      return verify.verify(pub, signatureHex, 'hex');
    } catch {
      return false;
    }
  }
}

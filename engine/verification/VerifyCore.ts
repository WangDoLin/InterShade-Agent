import fs from 'node:fs';
import path from 'node:path';
import {
  AttestationAuthority,
  type AttestationVerificationReport,
  type VerifyProofOptions,
} from './AttestationAuthority.js';
import {
  StandaloneVerifier,
  type StandaloneVerificationResult,
} from './StandaloneVerifier.js';
import { ProofGateRegistry } from './gates/ProofGateRegistry.js';

export interface UnifiedVerificationResult {
  isValid: boolean;
  crossVerified: boolean;
  attestationReport: AttestationVerificationReport;
  standaloneBundleReport?: StandaloneVerificationResult;
  missingCriticalGates: string[];
  errors: string[];
}

/**
 * Unified Verification Core (`VerifyCore`, NEXT-B-18..19).
 * Combines `AttestationAuthority.verifyProofDirectory`, `StandaloneVerifier.verifyExportBundle`,
 * and `ProofGateRegistry` critical gate enforcement with bi-directional cross-verification.
 */
export class VerifyCore {
  static verifyProofBundle(
    proofDirPath: string,
    options?: VerifyProofOptions & { enforceCriticalGates?: boolean }
  ): UnifiedVerificationResult {
    const attestationReport = AttestationAuthority.verifyProofDirectory(proofDirPath, options);
    const errors: string[] = [...attestationReport.errors];
    const missingCriticalGates: string[] = [];

    if (options?.enforceCriticalGates && attestationReport.manifest?.gates) {
      for (const reqGateId of ProofGateRegistry.getRequiredGateIds()) {
        const g = attestationReport.manifest.gates[reqGateId];
        if (!g || g.status !== 'PASS') {
          missingCriticalGates.push(reqGateId);
          errors.push(`Critical gate ${reqGateId} missing or did not PASS.`);
        }
      }
    }

    let standaloneBundleReport: StandaloneVerificationResult | undefined;
    let crossVerified = attestationReport.isValid;

    const exportsDir = path.join(proofDirPath, 'exports');
    if (fs.existsSync(exportsDir)) {
      standaloneBundleReport = StandaloneVerifier.verifyExportBundle(exportsDir, {
        expectedManifestHash: attestationReport.manifest?.manifestHashSha256,
        trustedRootKeyPem: attestationReport.attestation?.publicKeyPem,
        enforceTrustStore: true,
      });

      // Bi-directional cross-verification: both verifiers must agree on bundle validity
      if (attestationReport.isValid !== standaloneBundleReport.isAccepted) {
        crossVerified = false;
        errors.push(
          `[CROSS-VERIFY DIVERGENCE]: AttestationAuthority=${attestationReport.isValid} (${attestationReport.verdict}) vs StandaloneVerifier=${standaloneBundleReport.isAccepted} (${standaloneBundleReport.verdict})`
        );
      } else {
        crossVerified = true;
      }

      if (!standaloneBundleReport.isAccepted) {
        for (const err of standaloneBundleReport.errors) {
          if (!errors.includes(err)) {
            errors.push(err);
          }
        }
      }
    }

    const isValid =
      attestationReport.isValid &&
      (standaloneBundleReport ? standaloneBundleReport.isAccepted : true) &&
      crossVerified &&
      missingCriticalGates.length === 0;

    return {
      isValid,
      crossVerified,
      attestationReport,
      standaloneBundleReport,
      missingCriticalGates,
      errors,
    };
  }
}

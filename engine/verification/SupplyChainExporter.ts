import type { ProofManifest } from './EvidenceStore.js';

export interface InTotoStatement {
  _type: 'https://in-toto.io/Statement/v1';
  subject: Array<{
    name: string;
    uri?: string;
    digest: Record<string, string>;
  }>;
  predicateType: string;
  predicate: Record<string, any>;
}

export interface AttestationExportBundle {
  intershaderProof: ProofManifest;
  intotoStatement: InTotoStatement;
  testResultStatement: InTotoStatement;
  slsa12Provenance: InTotoStatement;
  slsa10Provenance: InTotoStatement;
}

export class SupplyChainExporter {
  /**
   * Strip any leading 'sha256:' algorithm scheme prefix and return 64-character lowercase hex string.
   */
  static cleanSha256(digest?: string | null): string {
    if (!digest) return '';
    return digest.replace(/^sha256:/i, '').trim().toLowerCase();
  }

  /**
   * Validates and returns the manifest's evaluatorVersion, refusing to fabricate a fallback version (ENG-005).
   */
  static requireEvaluatorVersion(manifest: ProofManifest): string {
    const version = manifest.evaluatorVersion?.trim();
    if (!version) {
      throw new Error(
        '[REJECT_MISSING_EVALUATOR_VERSION]: ProofManifest is missing required evaluatorVersion provenance.',
      );
    }
    return version;
  }

  /**
   * Export InterShader Proof Manifest to standard in-toto Attestation format (link/v0.3)
   * In in-toto Statement v1 with link/v0.3 predicate:
   * - Statement subject represents output products (build artifact).
   * - predicate.materials represents input materials (verified source snapshot).
   * - predicate.products is deprecated and omitted in favor of Statement subject.
   */
  static exportInToto(manifest: ProofManifest): InTotoStatement {
    const buildDigest = manifest.buildArtifactDigest || manifest.artifactDigest || manifest.manifestHashSha256;
    const sourceDigest = manifest.verifiedSourceDigest || manifest.manifestHashSha256;

    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'build-artifact',
          digest: {
            sha256: SupplyChainExporter.cleanSha256(buildDigest),
          },
        },
      ],
      predicateType: 'https://in-toto.io/attestation/link/v0.3',
      predicate: {
        name: 'intershader-verification-pass',
        command: ['intershader', 'verify'],
        materials: [
          {
            name: 'verified-source-snapshot',
            uri: 'intershader://workspace/source-snapshot',
            digest: {
              sha256: SupplyChainExporter.cleanSha256(sourceDigest),
            },
          },
          ...(manifest.workspaceCommit
            ? [
                {
                  name: 'git-repository-commit',
                  uri: `git+commit:${manifest.workspaceCommit}`,
                  digest: {
                    gitCommit: manifest.workspaceCommit,
                  },
                },
              ]
            : []),
        ],
        byproducts: {
          gatesSummary: Object.entries(manifest.gates).map(([id, g]) => ({
            gateId: id,
            name: g.name,
            status: g.status,
            executionMs: g.executionDurationMs,
            stdoutHash: SupplyChainExporter.cleanSha256(g.stdoutHashSha256),
          })),
          overallPassed: manifest.overallPassed,
          score: manifest.score,
          riskTier: manifest.riskTier,
          challenge: manifest.challenge || null,
        },
      },
    };
  }

  /**
   * Export in-toto Test Result Predicate (https://in-toto.io/attestation/test-result/v0.1)
   * Statement subject represents verified source snapshot under test.
   * predicate.configuration contains ResourceDescriptors describing configuration used.
   * predicate.passedTests, warnedTests, failedTests contain arrays of test names.
   */
  static exportTestResult(manifest: ProofManifest): InTotoStatement {
    const sourceDigest = manifest.verifiedSourceDigest || manifest.manifestHashSha256;
    const configDigest = manifest.policyDigest || manifest.manifestHashSha256;

    const formatGateName = (gateId: string, name: string) => {
      if (name.startsWith(gateId)) {
        return name;
      }
      return `${gateId} ${name}`;
    };

    const passedGates = Object.values(manifest.gates)
      .filter((g) => g.status === 'PASS')
      .map((g) => formatGateName(g.gateId, g.name));
    const warnedGates = Object.values(manifest.gates)
      .filter((g) => g.status === 'SKIPPED')
      .map((g) => formatGateName(g.gateId, g.name));
    const failedGates = Object.values(manifest.gates)
      .filter((g) => g.status === 'FAIL')
      .map((g) => formatGateName(g.gateId, g.name));

    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'verified-source-snapshot',
          uri: 'intershader://workspace/source-snapshot',
          digest: {
            sha256: SupplyChainExporter.cleanSha256(sourceDigest),
          },
        },
      ],
      predicateType: 'https://in-toto.io/attestation/test-result/v0.1',
      predicate: {
        result: manifest.overallPassed ? 'PASSED' : 'FAILED',
        configuration: [
          {
            name: 'intershader-test-configuration',
            digest: {
              sha256: SupplyChainExporter.cleanSha256(configDigest),
            },
          },
        ],
        passedTests: passedGates,
        warnedTests: warnedGates,
        failedTests: failedGates,
      },
    };
  }

  /**
   * Export InterShader Proof Manifest to standard SLSA Provenance v1.2 format (Current Active Spec)
   * Reference: https://slsa.dev/spec/v1.2/provenance
   * predicateType: strictly 'https://slsa.dev/provenance/v1'
   * subject: output build artifact
   * resolvedDependencies: verified source snapshot and build dependencies
   */
  static exportSlsaProvenanceV12(manifest: ProofManifest): InTotoStatement {
    const evaluatorVersion = SupplyChainExporter.requireEvaluatorVersion(manifest);
    const buildDigest = manifest.buildArtifactDigest || manifest.artifactDigest || manifest.manifestHashSha256;

    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'build-artifact',
          digest: {
            sha256: SupplyChainExporter.cleanSha256(buildDigest),
          },
        },
      ],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://intershader.dev/verification-oracle/v4.2',
          externalParameters: {
            sourceRepository: manifest.workspaceCommit
              ? `git+commit:${manifest.workspaceCommit}`
              : 'local-workspace',
            ...(manifest.workspaceCommit ? { workspaceCommit: manifest.workspaceCommit } : {}),
            targetFiles: manifest.changedFiles,
          },
          internalParameters: {
            evaluatorVersion,
            platform: manifest.environmentFingerprint?.platform || process.platform,
            nodeVersion: process.versions.node,
          },
          resolvedDependencies: [
            {
              uri: 'intershader://workspace/source-snapshot',
              digest: {
                sha256: SupplyChainExporter.cleanSha256(manifest.verifiedSourceDigest || manifest.manifestHashSha256),
              },
            },
            ...(manifest.workspaceCommit
              ? [
                  {
                    uri: `git+commit:${manifest.workspaceCommit}`,
                    digest: {
                      gitCommit: manifest.workspaceCommit,
                    },
                  },
                ]
              : []),
            {
              uri: 'pkg:npm/dependencies',
              digest: {
                sha256: SupplyChainExporter.cleanSha256(manifest.dependencyFingerprint),
              },
            },
          ],
        },
        runDetails: {
          builder: {
            // Builder identifier for InterShader Local Node Engine.
            // Trust boundary: Local node execution environment within operator's workspace.
            // When auditing/verifying pre-existing artifacts, it attests to the local verification process.
            // When executing local compilation/packaging, it attests to the creation of the build artifact.
            id: 'https://intershader.dev/attestation-authority/v4.2/local-node-engine',
            version: {
              engine: evaluatorVersion,
            },
          },
          metadata: {
            invocationId: manifest.runId,
            startedOn: manifest.startedAt,
            finishedOn: manifest.completedAt,
          },
          byproducts: [
            {
              name: 'proof-manifest-hash',
              digest: { sha256: SupplyChainExporter.cleanSha256(manifest.manifestHashSha256) },
            },
            {
              name: 'environment-fingerprint-digest',
              digest: {
                sha256: SupplyChainExporter.cleanSha256(manifest.baseImageDigest || 'env-digest'),
              },
            },
          ],
        },
      },
    };
  }

  /**
   * Export InterShader Proof Manifest to standard SLSA Provenance v1.0 format (Legacy / Compatibility)
   */
  static exportSlsaProvenance(manifest: ProofManifest): InTotoStatement {
    const evaluatorVersion = SupplyChainExporter.requireEvaluatorVersion(manifest);
    const buildDigest = manifest.buildArtifactDigest || manifest.artifactDigest || manifest.manifestHashSha256;

    return {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        {
          name: 'build-artifact',
          digest: {
            sha256: SupplyChainExporter.cleanSha256(buildDigest),
          },
        },
      ],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://intershader.dev/verification-oracle/v4',
          externalParameters: {
            ...(manifest.workspaceCommit ? { workspaceCommit: manifest.workspaceCommit } : {}),
            targetFiles: manifest.changedFiles,
          },
          internalParameters: {
            evaluatorVersion,
            platform: process.platform,
          },
          resolvedDependencies: [
            {
              uri: 'intershader://workspace/source-snapshot',
              digest: {
                sha256: SupplyChainExporter.cleanSha256(manifest.verifiedSourceDigest || manifest.manifestHashSha256),
              },
            },
          ],
        },
        runDetails: {
          builder: {
            id: 'https://intershader.dev/attestation-authority/v4.2/local-node-engine',
            version: {
              engine: evaluatorVersion,
            },
          },
          metadata: {
            invocationId: manifest.runId,
            startedOn: manifest.startedAt,
            finishedOn: manifest.completedAt,
          },
          byproducts: [
            {
              name: 'proof-manifest-hash',
              digest: { sha256: SupplyChainExporter.cleanSha256(manifest.manifestHashSha256) },
            },
          ],
        },
      },
    };
  }

  /**
   * Generate full export bundle containing proof, in-toto, test-result, and SLSA 1.2
   */
  static exportAttestationBundle(manifest: ProofManifest): AttestationExportBundle {
    return {
      intershaderProof: manifest,
      intotoStatement: this.exportInToto(manifest),
      testResultStatement: this.exportTestResult(manifest),
      slsa12Provenance: this.exportSlsaProvenanceV12(manifest),
      slsa10Provenance: this.exportSlsaProvenance(manifest),
    };
  }
}

export interface ProofGateDescriptor {
  readonly gateId: string;
  readonly name: string;
  readonly category: 'boundary' | 'static' | 'build' | 'test' | 'runtime' | 'security' | 'audit';
  readonly weight: number;
  readonly critical: boolean;
  readonly defaultLogFilename: string;
  readonly description: string;
}

const DEFAULT_PROOF_GATES: readonly ProofGateDescriptor[] = [
  {
    gateId: 'G1',
    name: 'G1 Scope & Workspace Boundary Guard',
    category: 'boundary',
    weight: 10,
    critical: true,
    defaultLogFilename: 'g1-scope.log',
    description: 'Verifies all modified files reside strictly inside the workspace boundary.',
  },
  {
    gateId: 'G2',
    name: 'G2 Scope & Diff Budget Guard',
    category: 'boundary',
    weight: 10,
    critical: false,
    defaultLogFilename: 'g2-budget.log',
    description: 'Enforces maximum modified file count budget per task.',
  },
  {
    gateId: 'G3',
    name: 'G3 Static Analysis & Lint',
    category: 'static',
    weight: 10,
    critical: false,
    defaultLogFilename: 'g3-lint.log',
    description: 'Runs static analysis and linter checks.',
  },
  {
    gateId: 'G4',
    name: 'G4 Typecheck Integrity',
    category: 'static',
    weight: 15,
    critical: true,
    defaultLogFilename: 'g4-typecheck.log',
    description: 'Verifies zero TypeScript compilation errors via tsc --noEmit.',
  },
  {
    gateId: 'G5',
    name: 'G5 Build Pipeline Integrity',
    category: 'build',
    weight: 10,
    critical: true,
    defaultLogFilename: 'g5-build.log',
    description: 'Verifies production build pipeline execution.',
  },
  {
    gateId: 'G6',
    name: 'G6 Unit Test Suite',
    category: 'test',
    weight: 20,
    critical: true,
    defaultLogFilename: 'g6-unittest.log',
    description: 'Executes unit test suite and TestTamperDetector verification.',
  },
  {
    gateId: 'G7',
    name: 'G7 Integration Test Suite',
    category: 'test',
    weight: 10,
    critical: false,
    defaultLogFilename: 'g7-integration.log',
    description: 'Verifies cross-module integration contracts.',
  },
  {
    gateId: 'G8',
    name: 'G8 Runtime & E2E Verification',
    category: 'runtime',
    weight: 5,
    critical: false,
    defaultLogFilename: 'g8-runtime.log',
    description: 'Checks modified files for unimplemented stubs or runtime hazards.',
  },
  {
    gateId: 'G9',
    name: 'G9 Security & Secret Scan',
    category: 'security',
    weight: 5,
    critical: true,
    defaultLogFilename: 'g9-sast.log',
    description: 'Scans modified files against secret leakage and SAST rules.',
  },
  {
    gateId: 'G10',
    name: 'G10 Causal & Adversarial Audit',
    category: 'audit',
    weight: 5,
    critical: true,
    defaultLogFilename: 'g10-audit.log',
    description: 'Synthesizes cryptographic manifest hash and adversarial audit verdict.',
  },
];

/**
 * Authoritative registry of Proof V4 verification gates (NEXT-B-17).
 */
export class ProofGateRegistry {
  private static readonly gates = new Map<string, ProofGateDescriptor>(
    DEFAULT_PROOF_GATES.map((g) => [g.gateId, g])
  );

  static registerGate(descriptor: ProofGateDescriptor): void {
    this.gates.set(descriptor.gateId, descriptor);
  }

  static getGate(gateId: string): ProofGateDescriptor | undefined {
    return this.gates.get(gateId);
  }

  static listGates(): ProofGateDescriptor[] {
    return Array.from(this.gates.values());
  }

  static getRequiredGateIds(): string[] {
    return Array.from(this.gates.values())
      .filter((g) => g.critical)
      .map((g) => g.gateId);
  }
}

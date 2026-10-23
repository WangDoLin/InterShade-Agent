import assert from 'node:assert';
import path from 'node:path';
import { FileLockRegistry } from '../engine/swarm/FileLockRegistry.js';

async function testFileLockRegistry() {
  console.log('--- Testing FileLockRegistry & Concurrency Lease System ---');
  FileLockRegistry.clearAll();

  const testFileA = path.resolve('src/services/auth.ts');
  const testFileB = path.resolve('src/ui/Login.tsx');

  // Test 1: Grant exclusive lease to Session 1
  const lease1 = FileLockRegistry.acquireLease(testFileA, 'session-1', 'backend', 5000);
  assert.strictEqual(lease1.acquired, true, 'Session 1 should acquire lease on testFileA');

  // Test 2: Session 2 tries to acquire lease on same file -> MUST BE REJECTED
  const lease2 = FileLockRegistry.acquireLease(testFileA, 'session-2', 'frontend', 5000);
  assert.strictEqual(lease2.acquired, false, 'Session 2 should be rejected from leasing testFileA');
  assert.ok(lease2.reason?.includes('FILE LEASE CONFLICT'), 'Should contain conflict reason');
  console.log('Test 2 Conflict Reason:', lease2.reason);

  // Test 3: Session 2 can acquire lease on a different file
  const lease3 = FileLockRegistry.acquireLease(testFileB, 'session-2', 'frontend', 5000);
  assert.strictEqual(lease3.acquired, true, 'Session 2 should acquire lease on testFileB');

  // Test 4: Scope boundary check
  FileLockRegistry.setSessionScope('session-backend', ['src/services/**', 'src/api/**']);

  // Allowed file in scope
  const inScopeLease = FileLockRegistry.acquireLease(
    path.resolve('src/services/user.ts'),
    'session-backend',
    'backend'
  );
  assert.strictEqual(inScopeLease.acquired, true, 'File within scope should be granted');

  // Forbidden file out of scope -> MUST BE REJECTED
  const outOfScopeLease = FileLockRegistry.acquireLease(
    path.resolve('src/ui/Dashboard.tsx'),
    'session-backend',
    'backend'
  );
  assert.strictEqual(outOfScopeLease.acquired, false, 'File outside scope must be blocked');
  assert.ok(outOfScopeLease.reason?.includes('SCOPE VIOLATION'), 'Reason should contain SCOPE VIOLATION');
  console.log('Test 4 Scope Rejection:', outOfScopeLease.reason);

  // Test 5: Releasing lease allows another session to acquire it
  FileLockRegistry.releaseLease(testFileA, 'session-1');
  const leaseAfterRelease = FileLockRegistry.acquireLease(testFileA, 'session-2', 'frontend', 5000);
  assert.strictEqual(leaseAfterRelease.acquired, true, 'Session 2 should acquire testFileA after release');

  // Test 6: Release all leases for session
  const releasedCount = FileLockRegistry.releaseAllLeasesForSession('session-2');
  assert.ok(releasedCount >= 1, 'Should release all leases for session-2');
  assert.strictEqual(FileLockRegistry.getLease(testFileA), undefined, 'testFileA should have no active lease');

  // Test 7 (ENG-042): Boundary enforcement — prevent substring bypass (e.g. src/services-evil or ../ traversal)
  assert.strictEqual(
    FileLockRegistry.isFileInScope('src/services-evil/hack.ts', ['src/services/**']),
    false,
    'ENG-042: Prefix lookalike directory must be rejected'
  );
  assert.strictEqual(
    FileLockRegistry.isFileInScope('src/services/../ui/Secret.tsx', ['src/services/**']),
    false,
    'ENG-042: Path traversal segment (..) must be rejected'
  );
  assert.strictEqual(
    FileLockRegistry.isFileInScope('src/other/my-auth.ts', ['auth.ts']),
    false,
    'ENG-042: Substring filename lookalike must be rejected'
  );

  console.log('All FileLockRegistry tests passed successfully!');
}

testFileLockRegistry().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

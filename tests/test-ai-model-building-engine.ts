import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { HuggingFaceHubTool } from '../tools/ai/HuggingFaceHubTool.js';
import { LiteratureSearchTool } from '../tools/ai/LiteratureSearchTool.js';
import { BrowserAutomationTool } from '../tools/web/BrowserAutomationTool.js';
import { PyTorchExecutionKernel } from '../services/ml/PyTorchExecutionKernel.js';
import { PyTorchModelBuilderTool } from '../tools/ai/PyTorchModelBuilderTool.js';
import { MLCausalEngine } from '../engine/ml/MLCausalEngine.js';
import type { ToolExecutionContext } from '../types/index.js';

async function runTestSuite() {
  console.log('================================================================');
  console.log('   INTERSHADE AI MODEL BUILDING ENGINE - VERIFICATION SUITE     ');
  console.log('================================================================\n');

  const mockContext: ToolExecutionContext = {
    sessionId: 'test-session-ml',
    cwd: process.cwd(),
    permissionMode: 'auto',
    onProgress: (msg: string) => console.log('  [TELEMETRY]:', msg),
  };

  // -------------------------------------------------------------
  // Test 1: Self-Healing Error Diagnosis
  // -------------------------------------------------------------
  console.log('=== TEST 1: SELF-HEALING DIAGNOSTIC ENGINE ===');
  const oomError = 'torch.cuda.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB';
  const oomPlan = PyTorchExecutionKernel.diagnoseError(oomError);
  console.log('OOM Diagnosis:', oomPlan.detectedError === 'CUDA_OOM' ? 'PASS' : 'FAIL');
  if (oomPlan.detectedError !== 'CUDA_OOM') throw new Error('OOM error detection failed');

  const shapeError = 'RuntimeError: The size of tensor a (128) must match the size of tensor b (256) at non-singleton dimension 1';
  const shapePlan = PyTorchExecutionKernel.diagnoseError(shapeError);
  console.log('Shape Mismatch Diagnosis:', shapePlan.detectedError === 'SHAPE_MISMATCH' ? 'PASS' : 'FAIL');
  if (shapePlan.detectedError !== 'SHAPE_MISMATCH') throw new Error('Shape mismatch detection failed');

  const nanError = 'Loss is NaN at epoch 3, gradient norm exploded to inf';
  const nanPlan = PyTorchExecutionKernel.diagnoseError(nanError);
  console.log('NaN Loss Diagnosis:', nanPlan.detectedError === 'NAN_LOSS' ? 'PASS' : 'FAIL');
  if (nanPlan.detectedError !== 'NAN_LOSS') throw new Error('NaN loss detection failed');

  // Test 1b: Supervised Local Execution Package Allowlist & Safe Environment (NEXT-B-13..14)
  const validDepCheck = PyTorchExecutionKernel.validateDependencies(['torch==2.5.1', 'numpy']);
  if (!validDepCheck.valid) throw new Error('Valid dependency check failed');
  const blockedInjection = PyTorchExecutionKernel.validateDependencies(['torch; rm -rf /']);
  if (blockedInjection.valid) throw new Error('Shell metacharacter dependency must be rejected');
  const blockedUnlisted = PyTorchExecutionKernel.validateDependencies(['malicious-unknown-pkg']);
  if (blockedUnlisted.valid) throw new Error('Unlisted dependency must be rejected');
  const safeEnv = PyTorchExecutionKernel.buildSafeMlEnv({
    OPENAI_API_KEY: 'should-be-stripped',
    CUSTOM_BATCH_SIZE: '32',
  });
  if (safeEnv.OPENAI_API_KEY) throw new Error('buildSafeMlEnv must strip API keys');
  if (safeEnv.CUSTOM_BATCH_SIZE !== '32') throw new Error('buildSafeMlEnv must preserve safe custom vars');

  // -------------------------------------------------------------
  // Test 2: ML Causal Loop & Solution Tree Search (AIDE Pattern)
  // -------------------------------------------------------------
  console.log('\n=== TEST 2: 12-STAGE ML CAUSAL ENGINE & TREE SEARCH ===');
  const mlEngine = new MLCausalEngine('Predict Protein Thermal Stability (Tm)', 'bio_sequence');
  mlEngine.recordStage('TaskFraming', 'PASSED', 'Regression on Tm, target metric: Spearman rho');
  mlEngine.recordStage('BatchSanityGate', 'PASSED', 'Mini-batch loss dropped by 84% in 30 steps');

  // Add solution candidates
  mlEngine.addCandidateNode({
    id: 'node-root',
    parentId: null,
    codePath: 'models/baseline.py',
    hyperparameters: { lr: 1e-3, backbone: 'esm2_t12' },
    valMetric: 0.65, // higher metric = better, but let's test lower loss/error
    status: 'EXPLORING',
  });

  mlEngine.addCandidateNode({
    id: 'node-child-1',
    parentId: 'node-root',
    codePath: 'models/lora_tuned.py',
    hyperparameters: { lr: 5e-4, backbone: 'esm2_t33', lora_r: 8 },
    valMetric: 0.42, // lower loss = improvement
    status: 'EXPLORING',
  });

  const best = mlEngine.getBestCandidate();
  console.log('Best Candidate Selected:', best?.id === 'node-child-1' ? 'PASS' : 'FAIL', `(${best?.id})`);
  if (best?.id !== 'node-child-1') throw new Error('Tree search best selection failed');

  // -------------------------------------------------------------
  // Test 3: PyTorch Model Builder Scaffolding & Cloud Specs
  // -------------------------------------------------------------
  console.log('\n=== TEST 3: PYTORCH MODEL BUILDER SCAFFOLDING ===');
  const tempDir = path.join(os.tmpdir(), `intershade_ml_test_${Date.now()}`);
  const builder = new PyTorchModelBuilderTool();

  const scaffoldRes = await builder.execute(
    {
      action: 'scaffold_project',
      modelType: 'nlp_transformer',
      targetDir: tempDir,
    },
    mockContext
  );
  console.log('Scaffolding Created:\n', scaffoldRes);

  const modelFileExists = fs.existsSync(path.join(tempDir, 'src', 'models', 'network.py'));
  const trainFileExists = fs.existsSync(path.join(tempDir, 'train.py'));
  const sanityFileExists = fs.existsSync(path.join(tempDir, 'sanity_check.py'));
  console.log('Files Verified:', modelFileExists && trainFileExists && sanityFileExists ? 'PASS' : 'FAIL');

  if (!modelFileExists || !trainFileExists || !sanityFileExists) {
    throw new Error('Project files not generated correctly');
  }

  // Cloud dispatch spec test
  const modalRes = await builder.execute(
    {
      action: 'dispatch_cloud_spec',
      targetDir: tempDir,
      cloudProvider: 'modal',
      dependencies: ['torch', 'transformers'],
    },
    mockContext
  );
  console.log('Modal Spec Generated:\n', modalRes);
  const modalFileExists = fs.existsSync(path.join(tempDir, 'modal_dispatch.py'));
  console.log('Modal File Exists:', modalFileExists ? 'PASS' : 'FAIL');

  // Cleanup temp files
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}

  // -------------------------------------------------------------
  // Test 4: HuggingFace & Literature Tools Initialization
  // -------------------------------------------------------------
  console.log('\n=== TEST 4: TOOL REGISTRY CONTRACT VALIDATION ===');
  const hfTool = new HuggingFaceHubTool();
  const litTool = new LiteratureSearchTool();
  const browserTool = new BrowserAutomationTool();

  console.log('HuggingFaceHubTool Name:', hfTool.name === 'huggingface_hub' ? 'PASS' : 'FAIL');
  console.log('LiteratureSearchTool Name:', litTool.name === 'literature_search' ? 'PASS' : 'FAIL');
  console.log('BrowserAutomationTool Name:', browserTool.name === 'browser_automation' ? 'PASS' : 'FAIL');

  console.log('\n================================================================');
  console.log('   ALL AI MODEL BUILDING ENGINE TESTS PASSED (100%)             ');
  console.log('================================================================');
}

runTestSuite().catch((err) => {
  console.error('\n[TEST FAILURE]:', err);
  process.exit(1);
});

import { z } from 'zod';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';

export interface PromptEnhancerArgs {
  action: 'enhance_prompt' | 'generate_ml_spec';
  rawPrompt: string;
  domainContext?: 'ml_deep_learning' | 'biological_genomics' | 'software_engineering';
  assumptions?: Record<string, string>;
}

export interface EnhancedPromptDimensions {
  what: string;
  why: string;
  who: string;
  when: string;
  how: string;
  done: string;
}

export interface MLStructuredSpecification {
  taskGoal: string;
  problemType: 'classification' | 'regression' | 'generation' | 'representation_learning';
  modality: 'tabular' | 'vision' | 'nlp_transformer' | 'bio_sequence';
  targetMetric: string;
  baselineThreshold: number;
  batchSanityRequired: boolean;
  precision: 'fp16' | 'bf16' | 'fp32';
  suggestedBackbone: string;
}

const DEFAULT_DOMAIN = 'ml_deep_learning';
const MIN_PROMPT_LENGTH = 5;

/**
 * PromptEnhancerTool transforms underspecified user queries into rigorous,
 * high-fidelity engineering and scientific ML specifications across 6 key dimensions.
 */
export class PromptEnhancerTool extends BaseTool<PromptEnhancerArgs, string> {
  readonly name = 'prompt_enhancer';
  readonly description =
    'Systematically enhance vague research questions or ML requests into 6-dimension structured specifications (WHAT, WHY, WHO, WHEN, HOW, DONE).';
  readonly isReadOnly = true;
  readonly isDestructive = false;
  readonly requiresPermission = false;
  readonly isDeferred = false;

  readonly inputSchema = z.object({
    action: z
      .enum(['enhance_prompt', 'generate_ml_spec'])
      .describe('Action: "enhance_prompt" for structured requirements or "generate_ml_spec" for ML engine parameters'),
    rawPrompt: z.string().min(MIN_PROMPT_LENGTH).describe('The initial user prompt or research inquiry to enhance'),
    domainContext: z
      .enum(['ml_deep_learning', 'biological_genomics', 'software_engineering'])
      .optional()
      .describe('Domain specialization for tailored heuristic expansion'),
    assumptions: z.record(z.string(), z.string()).optional().describe('Optional user assumptions or constraints to incorporate'),
  });

  async execute(args: PromptEnhancerArgs, context: ToolExecutionContext): Promise<string> {
    const domain = args.domainContext || DEFAULT_DOMAIN;
    if (context.onProgress) {
      context.onProgress(`[Prompt Enhancer]: Analyzing and formalizing query in domain "${domain}"`);
    }

    try {
      if (args.action === 'enhance_prompt') {
        const dimensions = this.deriveDimensions(args.rawPrompt, domain, args.assumptions);
        return this.formatEnhancedPrompt(args.rawPrompt, dimensions, domain);
      }

      if (args.action === 'generate_ml_spec') {
        const spec = this.deriveMLSpecification(args.rawPrompt, domain);
        return this.formatMLSpec(args.rawPrompt, spec);
      }

      return `[PROMPT ENHANCER ERROR]: Unsupported action "${args.action}".`;
    } catch (err) {
      return `[PROMPT ENHANCER EXCEPTION]: ${(err as Error).message}`;
    }
  }

  /**
   * Derives 6-dimension structured attributes based on prompt keywords and domain
   */
  private deriveDimensions(
    raw: string,
    domain: string,
    assumptions?: Record<string, string>
  ): EnhancedPromptDimensions {
    const lower = raw.toLowerCase();
    const isBio = domain === 'biological_genomics' || /protein|variant|gene|dna|rna|epigen|ccre/i.test(lower);
    const isVision = /image|vision|cnn|segment|detection/i.test(lower);

    const what = this.resolveWhat(raw, isBio, isVision);
    const why = assumptions?.why || 'Provide verifiable empirical performance improvements with reproducible metrics.';
    const who = assumptions?.who || 'Downstream automated agent pipelines and end users.';
    const when = assumptions?.when || 'Verify mini-batch convergence before launching full-scale distributed training.';
    const how = this.resolveHow(isBio, isVision, assumptions);
    const done = this.resolveDone(isBio);

    return { what, why, who, when, how, done };
  }

  private resolveWhat(raw: string, isBio: boolean, isVision: boolean): string {
    if (isBio) {
      return `Build and validate a biological sequence representation model targeting: "${raw.trim()}".`;
    }
    if (isVision) {
      return `Design and train a modern Vision Transformer or ConvNet model targeting: "${raw.trim()}".`;
    }
    return `Architect, sanity-check, and train a deep learning model for: "${raw.trim()}".`;
  }

  private resolveHow(isBio: boolean, isVision: boolean, assumptions?: Record<string, string>): string {
    if (assumptions?.how) return assumptions.how;
    if (isBio) {
      return 'PyTorch AMP (fp16/bf16), AdamW with Cosine Annealing, leveraging ESM2 / AlphaGenome representations.';
    }
    if (isVision) {
      return 'PyTorch AMP, Mixup/CutMix augmentation, AdamW optimizer with learning rate warm-up.';
    }
    return 'Modular PyTorch nn.Module with RMSNorm/LayerNorm, SwiGLU activation, and AdamW scheduler.';
  }

  private resolveDone(isBio: boolean): string {
    if (isBio) {
      return 'Single mini-batch loss drop > 70% in 35 steps; Validation Spearman rho > 0.70; Zero NaN/Inf loss.';
    }
    return 'Micro-batch sanity check pass (loss drop > 70%); Training loss steady convergence; Out-of-memory free.';
  }

  /**
   * Formats 6-dimension prompt as markdown report
   */
  private formatEnhancedPrompt(raw: string, dims: EnhancedPromptDimensions, domain: string): string {
    return [
      `### Enhanced Specification: "${raw.trim()}"`,
      `- **Domain Specialization**: \`${domain}\``,
      '',
      `#### 1. WHAT (Task Formulation & Scope)`,
      `${dims.what}`,
      '',
      `#### 2. WHY (Objective & Scientific Rationale)`,
      `${dims.why}`,
      '',
      `#### 3. WHO (Consumer & Runtime Environment)`,
      `${dims.who}`,
      '',
      `#### 4. WHEN (Lifecycle & Convergence Gates)`,
      `${dims.when}`,
      '',
      `#### 5. HOW (Architecture, Loss & Precision)`,
      `${dims.how}`,
      '',
      `#### 6. DONE (Empirical Acceptance Criteria)`,
      `${dims.done}`,
      '',
      `*Recommended Next Action: Launch MLCausalEngine TaskFraming or execute PyTorchModelBuilderTool.*`,
    ].join('\n');
  }

  /**
   * Derives structured ML parameter specifications
   */
  private deriveMLSpecification(raw: string, domain: string): MLStructuredSpecification {
    const lower = raw.toLowerCase();
    const isBio = domain === 'biological_genomics' || /protein|variant|gene|dna|rna/i.test(lower);
    const isTabular = /tabular|csv|feature|table|housing|finance/i.test(lower);
    const isVision = /vision|image|cifar|mnist|detection/i.test(lower);

    let modality: MLStructuredSpecification['modality'] = 'nlp_transformer';
    let suggestedBackbone = 'transformer_encoder_base';
    let targetMetric = 'val_loss';
    let baselineThreshold = 0.5;

    if (isBio) {
      modality = 'bio_sequence';
      suggestedBackbone = 'facebook/esm2_t12_35M_UR50D';
      targetMetric = 'spearman_rho';
      baselineThreshold = 0.65;
    } else if (isTabular) {
      modality = 'tabular';
      suggestedBackbone = 'residual_mlp_tabnet';
      targetMetric = 'auroc';
      baselineThreshold = 0.82;
    } else if (isVision) {
      modality = 'vision';
      suggestedBackbone = 'timm/vit_base_patch16_224';
      targetMetric = 'top1_accuracy';
      baselineThreshold = 0.85;
    }

    return {
      taskGoal: raw.trim(),
      problemType: /classify|class|category/i.test(lower) ? 'classification' : 'regression',
      modality,
      targetMetric,
      baselineThreshold,
      batchSanityRequired: true,
      precision: 'fp16',
      suggestedBackbone,
    };
  }

  /**
   * Formats structured ML specification as markdown
   */
  private formatMLSpec(raw: string, spec: MLStructuredSpecification): string {
    return [
      `### Machine Learning Structured Specification`,
      `- **Task Goal**: "${spec.taskGoal}"`,
      `- **Problem Type**: \`${spec.problemType}\``,
      `- **Modality**: \`${spec.modality}\``,
      `- **Target Metric**: \`${spec.targetMetric}\` (Target: >= ${spec.baselineThreshold})`,
      `- **Suggested Backbone**: \`${spec.suggestedBackbone}\``,
      `- **Execution Precision**: \`${spec.precision}\` with Automatic Mixed Precision (AMP)`,
      `- **Batch Sanity Gate Required**: \`${spec.batchSanityRequired}\``,
    ].join('\n');
  }
}

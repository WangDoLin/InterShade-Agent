import { z } from 'zod';
import path from 'node:path';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { ScienceSkillBridge } from '../../services/skills/ScienceSkillBridge.js';

export interface AlphaGenomeArgs {
  action:
    | 'lookup_gene'
    | 'resolve_ontology'
    | 'analyze_variant'
    | 'analyze_ism'
    | 'interpret_splicing'
    | 'visualize_tracks'
    | 'broad_scan';
  geneSymbol?: string;
  variant?: string;
  term?: string;
  interval?: string;
  outputFile?: string;
}

/**
 * AlphaGenomeTool provides genomic variant effect analysis across gene expression,
 * chromatin accessibility (DNASE), histone marks (ChIP), splicing disruption, and In-Silico Mutagenesis (ISM).
 */
export class AlphaGenomeTool extends BaseTool<AlphaGenomeArgs, string> {
  readonly name = 'alphagenome_analysis';
  readonly description =
    'Analyze genetic variant effects via DeepMind AlphaGenome: gene lookup, ontology resolution, ISM, splicing delta, and track visualization.';
  readonly isReadOnly = false;
  readonly isDestructive = false;
  readonly requiresPermission = false;
  readonly isDeferred = true;

  readonly inputSchema = z.object({
    action: z
      .enum([
        'lookup_gene',
        'resolve_ontology',
        'analyze_variant',
        'analyze_ism',
        'interpret_splicing',
        'visualize_tracks',
        'broad_scan',
      ])
      .describe('AlphaGenome analysis action'),
    geneSymbol: z.string().optional().describe('Gene symbol (e.g. TP53, BRCA1, USH2A)'),
    variant: z.string().optional().describe('Variant in chr:pos:ref>alt format (e.g. chr7:140753336:A>T)'),
    term: z.string().optional().describe('Tissue or cell-type term to map to UBERON/CL ontology (e.g. liver, heart)'),
    interval: z.string().optional().describe('Genomic interval for visualize_tracks (e.g. chr7:140750000-140760000)'),
    outputFile: z.string().optional().describe('Optional output file path for JSON results or plots'),
  });

  async execute(args: AlphaGenomeArgs, context: ToolExecutionContext): Promise<string> {
    const scriptsDir = ScienceSkillBridge.getSkillScriptsDir('alphagenome_single_variant_analysis');
    if (!scriptsDir) {
      return '[ALPHAGENOME ERROR]: alphagenome_single_variant_analysis skill scripts directory not found.';
    }

    if (context.onProgress) {
      context.onProgress(`[AlphaGenome]: Executing "${args.action}" on target "${args.geneSymbol || args.variant || args.term || 'query'}"`);
    }

    try {
      if (args.action === 'lookup_gene') {
        return await this.handleLookupGene(scriptsDir, args, context);
      }
      if (args.action === 'resolve_ontology') {
        return await this.handleResolveOntology(scriptsDir, args, context);
      }
      if (args.action === 'analyze_ism') {
        return await this.handleAnalyzeIsm(scriptsDir, args, context);
      }
      if (args.action === 'interpret_splicing') {
        return await this.handleInterpretSplicing(scriptsDir, args, context);
      }
      if (args.action === 'visualize_tracks') {
        return await this.handleVisualizeTracks(scriptsDir, args, context);
      }
      if (args.action === 'broad_scan' || args.action === 'analyze_variant') {
        return await this.handleVariantScoring(scriptsDir, args, context);
      }
      return '[ALPHAGENOME ERROR]: Unsupported action.';
    } catch (err) {
      return `[ALPHAGENOME EXCEPTION]: ${(err as Error).message}`;
    }
  }

  private async handleLookupGene(scriptsDir: string, args: AlphaGenomeArgs, ctx: ToolExecutionContext): Promise<string> {
    if (!args.geneSymbol) return '[ALPHAGENOME ERROR]: geneSymbol is required for lookup_gene (e.g. TP53, BRCA1).';
    const script = path.join(scriptsDir, 'lookup_gene_info.py');
    const scriptArgs = [args.geneSymbol];
    if (args.outputFile) scriptArgs.push('--output', args.outputFile);
    const res = await ScienceSkillBridge.runScript(script, scriptArgs, { cwd: ctx.cwd, timeoutMs: 45000 });
    if (!res.success) return `[ALPHAGENOME LOOKUP FAILED]:\n${res.stderr || res.stdout}`;
    return `🧬 [AlphaGenome Gene Lookup]:\n- Symbol: ${args.geneSymbol}\n- Result:\n${res.stdout.trim()}`;
  }

  private async handleResolveOntology(scriptsDir: string, args: AlphaGenomeArgs, ctx: ToolExecutionContext): Promise<string> {
    if (!args.term) return '[ALPHAGENOME ERROR]: term is required for resolve_ontology (e.g. liver, cerebellar cortex).';
    const script = path.join(scriptsDir, 'resolve_ontology_terms.py');
    const res = await ScienceSkillBridge.runScript(script, [args.term], { cwd: ctx.cwd, timeoutMs: 30000 });
    return `🧬 [AlphaGenome Ontology Mapping]:\n- Biological Term: "${args.term}"\n- Result:\n${res.stdout || res.stderr}`;
  }

  private async handleAnalyzeIsm(scriptsDir: string, args: AlphaGenomeArgs, ctx: ToolExecutionContext): Promise<string> {
    if (!args.variant) return '[ALPHAGENOME ERROR]: variant is required for analyze_ism.';
    const apiKeyNotice = this.checkApiKey();
    if (apiKeyNotice) return apiKeyNotice;

    const script = path.join(scriptsDir, 'analyze_ism.py');
    const scriptArgs = ['--variant', args.variant];
    if (args.outputFile) scriptArgs.push('--output', args.outputFile);
    const res = await ScienceSkillBridge.runScript(script, scriptArgs, { cwd: ctx.cwd, timeoutMs: 90000 });
    return `🧬 [AlphaGenome In-Silico Mutagenesis (ISM)]:\n- Variant: ${args.variant}\n- Output:\n${res.stdout || res.stderr}`;
  }

  private async handleInterpretSplicing(scriptsDir: string, args: AlphaGenomeArgs, ctx: ToolExecutionContext): Promise<string> {
    if (!args.variant) return '[ALPHAGENOME ERROR]: variant is required for interpret_splicing.';
    const apiKeyNotice = this.checkApiKey();
    if (apiKeyNotice) return apiKeyNotice;

    const script = path.join(scriptsDir, 'interpret_splicing.py');
    const scriptArgs = ['--variant', args.variant];
    if (args.outputFile) scriptArgs.push('--output', args.outputFile);
    const res = await ScienceSkillBridge.runScript(script, scriptArgs, { cwd: ctx.cwd, timeoutMs: 90000 });
    return `🧬 [AlphaGenome Quantitative Splicing Interpretation]:\n- Variant: ${args.variant}\n- Output:\n${res.stdout || res.stderr}`;
  }

  private async handleVisualizeTracks(scriptsDir: string, args: AlphaGenomeArgs, ctx: ToolExecutionContext): Promise<string> {
    const target = args.interval || args.variant;
    if (!target) return '[ALPHAGENOME ERROR]: interval or variant is required for visualize_tracks.';
    const apiKeyNotice = this.checkApiKey();
    if (apiKeyNotice) return apiKeyNotice;

    const script = path.join(scriptsDir, 'visualize_genome_tracks.py');
    const scriptArgs = ['--target', target];
    if (args.outputFile) scriptArgs.push('--output', args.outputFile);
    const res = await ScienceSkillBridge.runScript(script, scriptArgs, { cwd: ctx.cwd, timeoutMs: 90000 });
    return `🧬 [AlphaGenome Track Visualization]:\n- Target: ${target}\n- Output:\n${res.stdout || res.stderr}`;
  }

  private async handleVariantScoring(scriptsDir: string, args: AlphaGenomeArgs, ctx: ToolExecutionContext): Promise<string> {
    if (!args.variant) return '[ALPHAGENOME ERROR]: variant is required (format chr:pos:ref>alt, e.g. chr7:140753336:A>T).';
    const apiKeyNotice = this.checkApiKey();
    if (apiKeyNotice) return apiKeyNotice;

    const script = path.join(scriptsDir, 'visualize_variant_effects.py');
    const scriptArgs = ['--variant', args.variant];
    if (args.outputFile) scriptArgs.push('--output', args.outputFile);
    const res = await ScienceSkillBridge.runScript(script, scriptArgs, { cwd: ctx.cwd, timeoutMs: 90000 });
    return `🧬 [AlphaGenome Variant Effect Analysis (${args.action})]:\n- Variant: ${args.variant}\n- Output:\n${res.stdout || res.stderr}`;
  }

  private checkApiKey(): string | null {
    if (!process.env.ALPHAGENOME_API_KEY) {
      return [
        `[ALPHAGENOME NOTICE]: ALPHAGENOME_API_KEY is not configured in environment or .env file.`,
        `To run online variant effect scoring via DeepMind AlphaGenome API:`,
        `1. Obtain an API key at https://deepmind.google.com/science/alphagenome/`,
        `2. Add ALPHAGENOME_API_KEY=<your_key> to your ~/.env file.`,
      ].join('\n');
    }
    return null;
  }

  /**
   * Generates structured grounding context for Gemini 3.8 to eliminate hallucination in biology
   */
  static formatGroundingSummary(
    variant: string,
    payload: { effectScore?: number; tracks?: string[]; interpretation?: string }
  ): string {
    const lines = [
      `### [AlphaGenome Empirical Grounding]: ${variant}`,
      `- Context Window: 1Mbp regulatory field (DeepMind AlphaGenome)`,
      `- Biological Interpretation: ${payload.interpretation || 'Non-coding variant analyzed across chromatin, transcription & splicing.'}`,
    ];
    if (payload.effectScore !== undefined) {
      lines.push(`- Variant Effect Delta: ${payload.effectScore}`);
    }
    if (payload.tracks && payload.tracks.length > 0) {
      lines.push(`- Affected Functional Tracks: ${payload.tracks.join(', ')}`);
    }
    return lines.join('\n');
  }
}

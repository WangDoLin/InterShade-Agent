import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutionContext } from '../../types/index.js';
import { ScienceSkillBridge } from '../../services/skills/ScienceSkillBridge.js';

export interface EncodeCcresArgs {
  action:
    | 'search_ccres'
    | 'ccre_details'
    | 'nearby_genes'
    | 'biosamples'
    | 'gene_expression'
    | 'linked_genes'
    | 'orthologs'
    | 'encode_portal_search';
  chromosome?: string;
  start?: number;
  end?: number;
  accession?: string;
  geneSymbol?: string;
  portalQuery?: string;
  assembly?: 'grch38' | 'mm10';
  outputFile?: string;
}

/**
 * EncodeCcresTool queries the ENCODE Registry of candidate cis-Regulatory Elements (cCREs:
 * Promoters, Enhancers, CTCF insulators) via SCREEN GraphQL and ENCODE Portal REST API.
 */
export class EncodeCcresTool extends BaseTool<EncodeCcresArgs, string> {
  readonly name = 'encode_ccres';
  readonly description =
    'Query the ENCODE Registry of cCREs (Promoters, Enhancers, CTCF insulators), linked genes, gene expression, and raw ChIP-seq experiments.';
  readonly isReadOnly = true;
  readonly isDestructive = false;
  readonly requiresPermission = false;
  readonly isDeferred = true;

  readonly inputSchema = z.object({
    action: z
      .enum([
        'search_ccres',
        'ccre_details',
        'nearby_genes',
        'biosamples',
        'gene_expression',
        'linked_genes',
        'orthologs',
        'encode_portal_search',
      ])
      .describe('Action to execute on ENCODE Registry'),
    chromosome: z.string().optional().describe('Chromosome (e.g. chr11, chr7) for search_ccres'),
    start: z.number().optional().describe('Genomic start coordinate (e.g. 5205263) for search_ccres'),
    end: z.number().optional().describe('Genomic end coordinate (e.g. 5207263) for search_ccres'),
    accession: z.string().optional().describe('cCRE Accession ID (e.g. EH38E2941922) for ccre_details, nearby_genes, linked_genes, orthologs'),
    geneSymbol: z.string().optional().describe('Target gene symbol (e.g. GAPDH, TP53) for gene_expression'),
    portalQuery: z.string().optional().describe('Raw query string for ENCODE Portal REST API (e.g. "type=Experiment&target.label=CTCF")'),
    assembly: z.enum(['grch38', 'mm10']).optional().describe('Genomic assembly (default: grch38)'),
    outputFile: z.string().optional().describe('Output JSON file path'),
  });

  async execute(args: EncodeCcresArgs, context: ToolExecutionContext): Promise<string> {
    const scriptsDir = ScienceSkillBridge.getSkillScriptsDir('encode_ccres_database');
    if (!scriptsDir) {
      return '[ENCODE ERROR]: encode_ccres_database skill scripts directory not found.';
    }

    const defaultOutput = args.outputFile || path.resolve(context.cwd, 'data', 'encode_output.json');
    const outDir = path.dirname(defaultOutput);
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    if (context.onProgress) {
      context.onProgress(`[ENCODE cCREs]: Executing action "${args.action}" on target "${args.accession || args.geneSymbol || args.chromosome || 'query'}"`);
    }

    try {
      if (args.action === 'gene_expression') {
        return await this.handleGeneExpression(scriptsDir, args, defaultOutput, context);
      }
      if (args.action === 'linked_genes') {
        return await this.handleLinkedGenes(scriptsDir, args, defaultOutput, context);
      }
      if (args.action === 'orthologs') {
        return await this.handleOrthologs(scriptsDir, args, defaultOutput, context);
      }
      if (args.action === 'encode_portal_search') {
        return await this.handlePortalSearch(scriptsDir, args, defaultOutput, context);
      }
      return await this.handleCoreActions(scriptsDir, args, defaultOutput, context);
    } catch (err) {
      return `[ENCODE EXCEPTION]: ${(err as Error).message}`;
    }
  }

  private async handleGeneExpression(
    scriptsDir: string,
    args: EncodeCcresArgs,
    output: string,
    ctx: ToolExecutionContext
  ): Promise<string> {
    if (!args.geneSymbol) return '[ENCODE ERROR]: geneSymbol is required for gene_expression (e.g. GAPDH, TP53).';
    const script = path.join(scriptsDir, 'screen_api.py');
    const res = await ScienceSkillBridge.runScript(script, ['gene-expression', args.geneSymbol, '--output', output], {
      cwd: ctx.cwd,
      timeoutMs: 45000,
    });
    return `🧬 [ENCODE Gene Expression (TPM)]:\n- Gene: ${args.geneSymbol}\n- Output File: ${output}\n- Summary:\n${res.stdout || res.stderr}`;
  }

  private async handleLinkedGenes(
    scriptsDir: string,
    args: EncodeCcresArgs,
    output: string,
    ctx: ToolExecutionContext
  ): Promise<string> {
    if (!args.accession) return '[ENCODE ERROR]: accession is required for linked_genes (e.g. EH38E1516972).';
    const script = path.join(scriptsDir, 'screen_api.py');
    const res = await ScienceSkillBridge.runScript(script, ['linked-genes', args.accession, '--output', output], {
      cwd: ctx.cwd,
      timeoutMs: 45000,
    });
    return `🧬 [ENCODE cCRE Linked Genes (Hi-C / eQTL)]:\n- Accession: ${args.accession}\n- Output File: ${output}\n- Summary:\n${res.stdout || res.stderr}`;
  }

  private async handleOrthologs(
    scriptsDir: string,
    args: EncodeCcresArgs,
    output: string,
    ctx: ToolExecutionContext
  ): Promise<string> {
    if (!args.accession) return '[ENCODE ERROR]: accession is required for orthologs.';
    const script = path.join(scriptsDir, 'screen_api.py');
    const res = await ScienceSkillBridge.runScript(script, ['orthologs', args.accession, '--output', output], {
      cwd: ctx.cwd,
      timeoutMs: 45000,
    });
    return `🧬 [ENCODE cCRE Orthologs (Human <-> Mouse)]:\n- Accession: ${args.accession}\n- Output File: ${output}\n- Summary:\n${res.stdout || res.stderr}`;
  }

  private async handlePortalSearch(
    scriptsDir: string,
    args: EncodeCcresArgs,
    output: string,
    ctx: ToolExecutionContext
  ): Promise<string> {
    const query = args.portalQuery || 'type=Experiment&target.label=CTCF';
    const script = path.join(scriptsDir, 'encode_portal_api.py');
    const res = await ScienceSkillBridge.runScript(script, ['search', query, '--output', output], {
      cwd: ctx.cwd,
      timeoutMs: 45000,
    });
    return `🧬 [ENCODE Portal REST Search]:\n- Query: "${query}"\n- Output File: ${output}\n- Result:\n${res.stdout || res.stderr}`;
  }

  private async handleCoreActions(
    scriptsDir: string,
    args: EncodeCcresArgs,
    output: string,
    ctx: ToolExecutionContext
  ): Promise<string> {
    const script = path.join(scriptsDir, 'screen_api.py');
    if (args.action === 'search_ccres') {
      const chr = args.chromosome || 'chr11';
      const start = args.start !== undefined ? String(args.start) : '5205263';
      const end = args.end !== undefined ? String(args.end) : '5207263';
      const res = await ScienceSkillBridge.runScript(
        script,
        ['search', '--chromosome', chr, '--start', start, '--end', end, '--output', output],
        { cwd: ctx.cwd, timeoutMs: 45000 }
      );
      return `🧬 [ENCODE cCREs: Genomic Search]:\n- Coordinates: ${chr}:${start}-${end}\n- Saved File: ${output}\n- Output:\n${res.stdout || res.stderr}`;
    }

    if (args.action === 'ccre_details') {
      if (!args.accession) return '[ENCODE ERROR]: accession is required for ccre_details (e.g. EH38E2941922).';
      const res = await ScienceSkillBridge.runScript(script, ['details', args.accession, '--output', output], {
        cwd: ctx.cwd,
        timeoutMs: 45000,
      });
      return `🧬 [ENCODE cCREs: Epigenetic Element Details]:\n- Accession: ${args.accession}\n- Output File: ${output}\n- Output:\n${res.stdout || res.stderr}`;
    }

    if (args.action === 'nearby_genes') {
      if (!args.accession) return '[ENCODE ERROR]: accession is required for nearby_genes (e.g. EH38E1516972).';
      const res = await ScienceSkillBridge.runScript(script, ['nearby-genes', args.accession, '--output', output], {
        cwd: ctx.cwd,
        timeoutMs: 30000,
      });
      return `🧬 [ENCODE cCREs: Nearby Genes]:\n- Accession: ${args.accession}\n- Output File: ${output}\n- Output:\n${res.stdout || res.stderr}`;
    }

    if (args.action === 'biosamples') {
      const res = await ScienceSkillBridge.runScript(script, ['biosamples', '--output', output], {
        cwd: ctx.cwd,
        timeoutMs: 30000,
      });
      return `🧬 [ENCODE Biosamples: High-Confidence Epigenetic Targets]:\n- Saved File: ${output}\n- Summary:\n${res.stdout || res.stderr}`;
    }

    return '[ENCODE ERROR]: Unsupported action.';
  }

  /**
   * Generates structured grounding context for SCREEN cis-regulatory element annotations
   */
  static formatCcreGroundingSummary(
    accession: string,
    payload: { group?: string; nearbyGenes?: string[]; biosamples?: string[] }
  ): string {
    const lines = [
      `### [ENCODE SCREEN cCRE Grounding]: ${accession}`,
      `- Functional Group: ${payload.group || 'Candidate cis-Regulatory Element'}`,
    ];
    if (payload.nearbyGenes && payload.nearbyGenes.length > 0) {
      lines.push(`- Regulated Nearby Genes: ${payload.nearbyGenes.join(', ')}`);
    }
    if (payload.biosamples && payload.biosamples.length > 0) {
      lines.push(`- Active Biosamples: ${payload.biosamples.slice(0, 5).join(', ')}`);
    }
    return lines.join('\n');
  }
}

import type { UnifiedMessage } from '../../types/index.js';

export interface MetricClaim {
  snippet: string;
  value: string;
  category: 'PERCENTAGE' | 'SPEEDUP' | 'MEMORY' | 'LATENCY' | 'SCIENTIFIC';
  isProven: boolean;
}

export interface MetricValidationResult {
  isValid: boolean;
  unprovenClaims: MetricClaim[];
  nudgePrompt?: string;
}

const COMMON_FALSE_POSITIVES = new Set([
  '100%',
  '0%',
  '200',
  '404',
  '500',
  '3000',
  '8080',
  '2024',
  '2025',
  '2026',
  '50',
]);

/**
 * MetricProvenanceValidator scans assistant outputs for quantitative performance,
 * benchmark, memory, or scientific claims, and ensures they have empirical provenance
 * in the session's tool execution results.
 */
export class MetricProvenanceValidator {
  /**
   * Strips code blocks to avoid flagging code syntax, ports, or variable definitions
   */
  private static stripCodeBlocks(text: string): string {
    return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]+`/g, '');
  }

  /**
   * Extracts metric claims from prose text
   */
  static extractMetricClaims(proseText: string): MetricClaim[] {
    const cleanText = this.stripCodeBlocks(proseText);
    const claims: MetricClaim[] = [];

    this.matchPercentages(cleanText, claims);
    this.matchSpeedups(cleanText, claims);
    this.matchMemories(cleanText, claims);
    this.matchLatencies(cleanText, claims);

    return claims;
  }

  /**
   * Matches percentage performance or accuracy claims (e.g. "98.5%", "75%")
   */
  private static matchPercentages(text: string, claims: MetricClaim[]): void {
    const regex = /(\b\d+(?:\.\d+)?%)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const val = match[1];
      if (!COMMON_FALSE_POSITIVES.has(val)) {
        const start = Math.max(0, match.index - 20);
        const end = Math.min(text.length, match.index + val.length + 20);
        const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
        claims.push({
          snippet,
          value: val,
          category: 'PERCENTAGE',
          isProven: false,
        });
      }
    }
  }

  /**
   * Matches speedup claims (e.g. "4.5x", "3x")
   */
  private static matchSpeedups(text: string, claims: MetricClaim[]): void {
    const regex = /(\b\d+(?:\.\d+)?x)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const val = match[1];
      const start = Math.max(0, match.index - 20);
      const end = Math.min(text.length, match.index + val.length + 20);
      const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
      claims.push({
        snippet,
        value: val,
        category: 'SPEEDUP',
        isProven: false,
      });
    }
  }

  /**
   * Matches memory consumption claims (e.g. "450 MB", "2 GB")
   */
  private static matchMemories(text: string, claims: MetricClaim[]): void {
    const regex = /(\b\d+(?:\.\d+)?\s*(?:MB|GB|KB))\b/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const val = match[1];
      const start = Math.max(0, match.index - 20);
      const end = Math.min(text.length, match.index + val.length + 20);
      const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
      claims.push({
        snippet,
        value: val,
        category: 'MEMORY',
        isProven: false,
      });
    }
  }

  /**
   * Matches latency claims (e.g. "12 ms", "50 ns")
   */
  private static matchLatencies(text: string, claims: MetricClaim[]): void {
    const regex = /(\b\d+(?:\.\d+)?\s*(?:ms|microsecond|ns))\b/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const val = match[1];
      const start = Math.max(0, match.index - 20);
      const end = Math.min(text.length, match.index + val.length + 20);
      const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
      claims.push({
        snippet,
        value: val,
        category: 'LATENCY',
        isProven: false,
      });
    }
  }

  /**
   * Collects all tool output contents from conversation trajectory
   */
  private static collectToolEvidence(messages: UnifiedMessage[]): string {
    const evidenceChunks: string[] = [];
    for (const m of messages) {
      if (m.role === 'tool' && m.content) {
        evidenceChunks.push(m.content);
      } else if (m.content && m.content.includes('[TOOL RESULT]')) {
        evidenceChunks.push(m.content);
      }
    }
    return evidenceChunks.join('\n');
  }

  /**
   * Evaluates if claims in assistant prose are verified by tool outputs
   */
  static evaluate(assistantContent: string, messages: UnifiedMessage[]): MetricValidationResult {
    const claims = this.extractMetricClaims(assistantContent);
    if (claims.length === 0) {
      return { isValid: true, unprovenClaims: [] };
    }

    const toolEvidence = this.collectToolEvidence(messages);
    const unproven: MetricClaim[] = [];

    for (const c of claims) {
      const cleanVal = c.value.replace(/%/g, '').trim();
      const hasEvidence =
        toolEvidence.includes(c.value) ||
        (cleanVal.length >= 2 && toolEvidence.includes(cleanVal));

      if (hasEvidence) {
        c.isProven = true;
      } else {
        unproven.push(c);
      }
    }

    if (unproven.length === 0) {
      return { isValid: true, unprovenClaims: [] };
    }

    const unprovenDetails = unproven
      .map((u) => `- "${u.snippet}" (thông số: ${u.value})`)
      .join('\n');

    const nudgePrompt = `[CẢNH BÁO BẢO VỆ CHỈ SỐ THỰC NGHIỆM - METRIC PROVENANCE VIOLATION]:
Phát hiện câu trả lời của bạn chứa các khẳng định thông số/hiệu năng nhưng KHÔNG CÓ BẰNG CHỨNG trong bất kỳ kết quả thực thi công cụ nào:
${unprovenDetails}

NGUYÊN TẮC "NO EVIDENCE, NO DONE":
1. Tuyệt đối không được tự bịa ra thông số hiệu năng, tỷ lệ tăng tốc, độ trễ hoặc bộ nhớ.
2. Nếu bạn tối ưu hóa hoặc cải tiến, BẮT BUỘC phải viết và chạy một script benchmark thực tế (sử dụng run_shell_command) để đo lường.
3. Hãy chạy script benchmark hoặc gọi Oracle thực nghiệm để lấy con số thật, sau đó báo cáo kết quả thực tế dựa trên dữ liệu đo lường.`;

    return {
      isValid: false,
      unprovenClaims: unproven,
      nudgePrompt,
    };
  }
}

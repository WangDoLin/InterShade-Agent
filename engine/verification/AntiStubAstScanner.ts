import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

export interface StubFinding {
  file: string;
  line: number;
  kind: 'DUMMY_RETURN' | 'TODO_EVASION' | 'EMPTY_BODY' | 'MOCK_PLACEHOLDER';
  symbolName?: string;
  message: string;
}

export interface AntiStubReport {
  passed: boolean;
  findings: StubFinding[];
  summary: string;
}

const EVASION_COMMENT_PATTERNS = [
  {
    regex: /\/\/\s*(TODO|FIXME|XXX)\s*[:\-]?\s*(implement|add\s+logic|fill\s+in|placeholder|mock|stub)/i,
    message: 'Found unresolved TODO/FIXME placeholder evasion comment in business logic',
  },
  {
    regex: /\/\/\s*(mock\s+implementation|placeholder\s+only|dummy\s+return|fake\s+data)/i,
    message: 'Found explicit mock or dummy placeholder comment in source code',
  },
  {
    regex: /\/\*\s*(TODO|FIXME)\s*[:\-]?\s*(implement|placeholder|mock)[\s\S]*?\*\//i,
    message: 'Found multi-line block TODO evasion comment',
  },
];

const COMPLEX_NAME_REGEX = /^(train|evaluate|process|optimize|calculate|compute|solve|execute|transform|compile|infer)/i;

/**
 * AntiStubAstScanner analyzes modified code files to detect superficial implementations,
 * mock stubs, lazy return constants, and placeholder evasion comments.
 */
export class AntiStubAstScanner {
  /**
   * Scans a single source file for stubbing and superficial implementation patterns
   */
  static scanSource(filePath: string, fileContent?: string): StubFinding[] {
    const findings: StubFinding[] = [];
    const content = fileContent !== undefined 
      ? fileContent 
      : (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '');

    if (!content.trim()) return findings;

    this.checkEvasionComments(content, filePath, findings);
    this.checkAstStructures(content, filePath, findings);

    return findings;
  }

  /**
   * Checks for evasion comments (TODO, mock, placeholder) in source text
   */
  private static checkEvasionComments(content: string, filePath: string, findings: StubFinding[]): void {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      for (const pattern of EVASION_COMMENT_PATTERNS) {
        if (pattern.regex.test(lineText)) {
          findings.push({
            file: filePath,
            line: i + 1,
            kind: 'TODO_EVASION',
            message: pattern.message,
          });
          break;
        }
      }
    }
  }

  /**
   * Parses and inspects TypeScript AST for dummy returns and empty function bodies
   */
  private static checkAstStructures(content: string, filePath: string, findings: StubFinding[]): void {
    const sourceFile = ts.createSourceFile(
      path.basename(filePath),
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
        this.inspectFunctionNode(node, sourceFile, filePath, findings);
      }
      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  /**
   * Inspects a function node for superficial body or dummy return pattern
   */
  private static inspectFunctionNode(
    node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction,
    sourceFile: ts.SourceFile,
    filePath: string,
    findings: StubFinding[]
  ): void {
    const name = this.extractFunctionName(node);
    const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const line = pos.line + 1;

    if (!node.body) return;

    if (ts.isBlock(node.body)) {
      if (node.body.statements.length === 0) {
        findings.push({
          file: filePath,
          line,
          kind: 'EMPTY_BODY',
          symbolName: name,
          message: `Function '${name}' has an empty implementation body`,
        });
        return;
      }

      this.inspectSingleStatementReturn(node.body.statements, name, line, filePath, findings);
    }
  }

  /**
   * Checks if body has only a single dummy return statement
   */
  private static inspectSingleStatementReturn(
    statements: ts.NodeArray<ts.Statement>,
    name: string,
    line: number,
    filePath: string,
    findings: StubFinding[]
  ): void {
    if (statements.length === 1 && ts.isReturnStatement(statements[0])) {
      const retStmt = statements[0];
      if (retStmt.expression && COMPLEX_NAME_REGEX.test(name)) {
        const isLiteral =
          ts.isNumericLiteral(retStmt.expression) ||
          ts.isStringLiteral(retStmt.expression) ||
          retStmt.expression.kind === ts.SyntaxKind.TrueKeyword ||
          retStmt.expression.kind === ts.SyntaxKind.FalseKeyword;

        if (isLiteral) {
          findings.push({
            file: filePath,
            line,
            kind: 'DUMMY_RETURN',
            symbolName: name,
            message: `Function '${name}' appears to be a superficial stub returning a constant literal without business logic`,
          });
        }
      }
    }
  }

  /**
   * Helper to extract name of a function or method node
   */
  private static extractFunctionName(
    node: ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction
  ): string {
    if ('name' in node && node.name && ts.isIdentifier(node.name as ts.Node)) {
      return (node.name as ts.Identifier).text;
    }
    return 'anonymous';
  }

  /**
   * Scans a list of modified files, filtering out non-code or test files
   */
  static scanFiles(filePaths: string[], cwd: string): AntiStubReport {
    const allFindings: StubFinding[] = [];
    const codeExts = new Set(['.ts', '.tsx', '.js', '.jsx']);

    for (const file of filePaths) {
      const lower = file.toLowerCase();
      const ext = path.extname(lower);
      if (!codeExts.has(ext)) continue;
      // Do not scan unit test files as test files intentionally have mock fixtures
      if (lower.includes('test') || lower.includes('spec')) continue;

      const fullPath = path.isAbsolute(file) ? file : path.resolve(cwd, file);
      if (!fs.existsSync(fullPath)) continue;

      const findings = this.scanSource(fullPath);
      allFindings.push(...findings);
    }

    const passed = allFindings.length === 0;
    const summary = passed
      ? 'Anti-Stub AST scan passed: No superficial stubs, dummy returns, or evasion comments detected.'
      : `Anti-Stub AST scan failed: ${allFindings.length} superficial pattern(s) detected.`;

    return {
      passed,
      findings: allFindings,
      summary,
    };
  }
}

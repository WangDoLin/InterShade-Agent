import path from 'path';
import fs from 'fs';
import os from 'os';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDefinition, ToolExecutionContext } from '../../types/index.js';
import type { ToolRegistry } from '../../tools/ToolRegistry.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  trusted?: boolean;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
}

const SAFE_ENV_ALLOWLIST = new Set([
  'PATH',
  'Path',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'WINDIR',
  'windir',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'NODE_ENV',
]);

const SENSITIVE_ENV_PATTERN = /(API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|CREDENTIAL)/i;

export class McpClientManager {
  private static activeClients: Map<string, Client> = new Map();
  private static registeredTools: Map<string, string> = new Map(); // toolName -> serverName

  /**
   * Builds a sanitized environment dictionary for child MCP servers, stripping ambient secrets
   * unless explicitly passed in the server's own configuration block.
   */
  static buildSafeMcpEnv(
    explicitEnv?: Record<string, string>,
    ambientEnv: NodeJS.ProcessEnv = process.env,
  ): Record<string, string> {
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(ambientEnv)) {
      if (value === undefined) continue;
      if (SAFE_ENV_ALLOWLIST.has(key) && !SENSITIVE_ENV_PATTERN.test(key)) {
        cleanEnv[key] = value;
      }
    }
    if (explicitEnv) {
      for (const [key, value] of Object.entries(explicitEnv)) {
        if (typeof value === 'string') {
          cleanEnv[key] = value;
        }
      }
    }
    return cleanEnv;
  }

  /**
   * Discovers and resolves MCP configuration file
   */
  static findConfigFile(cwd: string): string | null {
    const candidates = [
      path.join(cwd, '.intershader', 'mcp.json'),
      path.join(cwd, '.mcp.json'),
      path.join(cwd, 'mcp.json'),
      path.join(os.homedir(), '.intershade', 'mcp.json'),
    ];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Initializes MCP servers from configuration and registers their tools with safe permission defaults
   */
  static async initializeMcpServers(cwd: string, toolRegistry: ToolRegistry): Promise<string[]> {
    const configPath = this.findConfigFile(cwd);
    if (!configPath) {
      return [];
    }

    const loadedTools: string[] = [];

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed: McpConfigFile = JSON.parse(content);

      if (!parsed.mcpServers) return [];

      for (const [serverName, serverCfg] of Object.entries(parsed.mcpServers)) {
        if (serverCfg.disabled) continue;

        try {
          const cleanEnv = this.buildSafeMcpEnv(serverCfg.env);

          const transport = new StdioClientTransport({
            command: serverCfg.command,
            args: serverCfg.args || [],
            env: cleanEnv,
          });

          const client = new Client(
            {
              name: `intershader-${serverName}`,
              version: '1.0.0',
            },
            {
              capabilities: {},
            },
          );

          await client.connect(transport);
          this.activeClients.set(serverName, client);

          // Retrieve tools provided by this MCP server
          const toolsResponse = await client.listTools();

          for (const mcpTool of toolsResponse.tools) {
            const toolName = `mcp_${serverName}_${mcpTool.name}`;
            this.registeredTools.set(toolName, serverName);

            const annotations = (mcpTool as { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } })
              .annotations;
            const isReadOnly = annotations?.readOnlyHint === true;
            const isDestructive = annotations?.destructiveHint ?? !isReadOnly;
            // Fail-safe permission default (SVC-MCP-01 / F-06): third-party MCP tools require permission
            // unless explicitly marked read-only AND server is marked trusted.
            const requiresPermission = !(isReadOnly && serverCfg.trusted === true);

            const adaptedTool: ToolDefinition<any, any> = {
              name: toolName,
              description: `[MCP: ${serverName}] ${mcpTool.description || 'External MCP tool'}`,
              inputSchema: z.record(z.any()),
              isReadOnly,
              isDestructive,
              requiresPermission,
              execute: async (args: Record<string, unknown>, _context: ToolExecutionContext) => {
                try {
                  const result = await client.callTool({
                    name: mcpTool.name,
                    arguments: args,
                  });

                  if (result.content && Array.isArray(result.content)) {
                    return result.content
                      .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
                      .join('\n');
                  }
                  return JSON.stringify(result);
                } catch (err: unknown) {
                  const msg = err instanceof Error ? err.message : String(err);
                  return `[MCP Tool Error (${serverName})]: ${msg}`;
                }
              },
            };

            toolRegistry.register(adaptedTool);
            loadedTools.push(toolName);
          }
        } catch {
          // Skip unavailable MCP servers without crashing session startup
        }
      }
    } catch {
      // Ignore invalid MCP config JSON
    }

    return loadedTools;
  }

  /**
   * Returns list of connected MCP servers
   */
  static getConnectedServers(): string[] {
    return Array.from(this.activeClients.keys());
  }

  /**
   * Cleanly disconnects all running MCP clients
   */
  static async disconnectAll(): Promise<void> {
    for (const client of this.activeClients.values()) {
      try {
        await client.close();
      } catch {
        // Ignore disconnect errors on shutdown
      }
    }
    this.activeClients.clear();
    this.registeredTools.clear();
  }
}

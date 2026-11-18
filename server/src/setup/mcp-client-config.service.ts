import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { dataDir } from '../config/data-dir';

export type McpClientId =
  | 'cursor'
  | 'claude-desktop'
  | 'claude-code'
  | 'chatgpt'
  | 'deepseek-harness';

/** Nome do servidor no DeepSeek Harness: vira prefixo das tools (`mcp__wtai__*`). */
const DSH_SERVER_NAME = 'wtai';
const DSH_BUNDLE_DIR = 'dsh-wtai-mcp';

export interface McpClientConfigResult {
  ok: boolean;
  message: string;
  configPath: string;
  restartHint?: string;
}

type McpServerEntry = Record<string, unknown>;
type McpConfigFile = { mcpServers?: Record<string, McpServerEntry> };

@Injectable()
export class McpClientConfigService {
  configure(client: McpClientId, mcpUrl: string): McpClientConfigResult {
    // O DeepSeek Harness não lê um JSON de cliente: o servidor MCP entra por um
    // bundle Cordis (`@deepseek-ai/dsh-mcp-client`) instalado no profile. Gerar o
    // bundle e devolver o comando é o máximo que dá para fazer sem mexer no
    // profile do usuário — instalar é um `dsh plugin add`.
    if (client === 'deepseek-harness') {
      return this.gerarBundleDsh(mcpUrl);
    }

    const configPath = this.resolveConfigPath(client);
    const entry = this.buildServerEntry(client, mcpUrl);

    try {
      this.mergeAndWrite(configPath, entry);
      return {
        ok: true,
        message: `wt.ai configurado em ${configPath}`,
        configPath,
        restartHint: this.restartHint(client),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Falha ao configurar: ${message}`,
        configPath,
        restartHint: this.restartHint(client),
      };
    }
  }

  getSnippet(client: McpClientId, mcpUrl: string): string {
    if (client === 'deepseek-harness') {
      return this.getDshBundlePatch(mcpUrl);
    }
    const entry = this.buildServerEntry(client, mcpUrl);
    return JSON.stringify({ mcpServers: { 'wt.ai': entry } }, null, 2);
  }

  /** Patch Cordis com o `insert` do cliente MCP — é o conteúdo do bundle do DSH. */
  getDshBundlePatch(mcpUrl: string): string {
    return `# Patch Cordis que registra o wt.ai como servidor MCP no DeepSeek Harness.
# Caminho documentado: bundle próprio com este cordis.patch.yml em
# dsh.bundle.patch, instalado com \`dsh plugin --profile <perfil> add <pasta>\`.
- insert:
    - id: ${DSH_SERVER_NAME}-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ${DSH_SERVER_NAME}
        transport: streamable-http
        url: ${mcpUrl}
        # false: o wt.ai pode estar parado ou ainda sem login, e isso não deve
        # derrubar a inicialização do profile do DeepSeek Harness.
        failOnStartupError: false
`;
  }

  private gerarBundleDsh(mcpUrl: string): McpClientConfigResult {
    const dir = join(dataDir(), DSH_BUNDLE_DIR);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify(
          {
            name: '@local/wtai-mcp',
            version: '1.0.0',
            private: true,
            type: 'module',
            files: ['cordis.patch.yml'],
            dsh: { bundle: { patch: './cordis.patch.yml' } },
          },
          null,
          2,
        ) + '\n',
        'utf-8',
      );
      writeFileSync(
        join(dir, 'cordis.patch.yml'),
        this.getDshBundlePatch(mcpUrl),
        'utf-8',
      );
      return {
        ok: true,
        message: `Bundle do DeepSeek Harness gerado em ${dir}`,
        configPath: dir,
        restartHint: `Instale com: dsh plugin --profile <perfil> add "${dir}" e reinicie o DeepSeek Harness. As tools aparecem como mcp__${DSH_SERVER_NAME}__*.`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: `Falha ao gerar o bundle do DeepSeek Harness: ${message}`,
        configPath: dir,
      };
    }
  }

  private resolveConfigPath(client: McpClientId): string {
    const home = homedir();

    switch (client) {
      case 'cursor':
        return join(home, '.cursor', 'mcp.json');
      case 'claude-code':
        return join(home, '.claude.json');
      case 'claude-desktop':
        if (process.platform === 'win32') {
          const appData =
            process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
          return join(appData, 'Claude', 'claude_desktop_config.json');
        }
        return join(
          home,
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json',
        );
      case 'chatgpt':
        if (process.platform === 'win32') {
          const appData =
            process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
          return join(appData, 'OpenAI', 'ChatGPT', 'config.json');
        }
        return join(
          home,
          'Library',
          'Application Support',
          'OpenAI',
          'ChatGPT',
          'config.json',
        );
      case 'deepseek-harness':
        // Não é um arquivo de cliente: é a pasta do bundle gerado por
        // `configure`, que o `dsh plugin add` instala no profile.
        return join(dataDir(), DSH_BUNDLE_DIR);
    }
  }

  private buildServerEntry(
    client: McpClientId,
    mcpUrl: string,
  ): McpServerEntry {
    switch (client) {
      case 'cursor':
        return { url: mcpUrl };
      case 'claude-code':
        return { type: 'http', url: mcpUrl };
      case 'claude-desktop':
        return {
          command: 'npx',
          args: ['-y', 'mcp-remote', mcpUrl, '--transport', 'http-only'],
        };
      case 'chatgpt':
        return { url: mcpUrl };
      case 'deepseek-harness':
        return {
          serverName: DSH_SERVER_NAME,
          transport: 'streamable-http',
          url: mcpUrl,
          failOnStartupError: false,
        };
    }
  }

  private restartHint(client: McpClientId): string {
    switch (client) {
      case 'cursor':
        return 'Reinicie o Cursor para carregar o servidor MCP.';
      case 'claude-code':
        return 'Reinicie o Claude Code para carregar o servidor MCP.';
      case 'claude-desktop':
        return 'Reinicie o Claude Desktop. O bridge mcp-remote requer Node.js no PATH.';
      case 'chatgpt':
        return 'Reinicie o ChatGPT Desktop. Se não funcionar, use Settings → Apps/Connectors → Add custom connector com a URL do endpoint.';
      case 'deepseek-harness':
        return 'Instale o bundle com `dsh plugin --profile <perfil> add` e reinicie o app.';
    }
  }

  private mergeAndWrite(configPath: string, entry: McpServerEntry): void {
    const existing = this.readConfig(configPath);
    const merged: McpConfigFile = {
      ...existing,
      mcpServers: {
        ...(existing.mcpServers ?? {}),
        'wt.ai': entry,
      },
    };

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  }

  private readConfig(configPath: string): McpConfigFile {
    if (!existsSync(configPath)) {
      return {};
    }
    const raw = readFileSync(configPath, 'utf-8').trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw) as McpConfigFile;
  }
}



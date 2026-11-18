import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { DuckDBInstance } from '@duckdb/node-api';
import { dataDir } from '../config/data-dir';
import { abrirDuckDB, consultarUm, executar, FatoConn } from './duckdb';
import { DDL_FATO, FATO_SCHEMA_VERSION } from './schema-fato';
import { ARQUIVO_FATO } from './vendas-arquivos';
import { migrarSeNecessario } from './vendas-migracao';
import { VendasMetaDbService } from './vendas-meta-db.service';

export { ARQUIVO_FATO } from './vendas-arquivos';

@Injectable()
export class VendasFatoDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VendasFatoDbService.name);
  private readonly caminho = join(dataDir(), ARQUIVO_FATO);
  private instance?: DuckDBInstance;
  private conn?: FatoConn;
  private ready?: Promise<void>;
  /** `abrir()` em curso: a migração v1→v2 reentra em `pronto()` de dentro dele. */
  private abrindo = false;

  constructor(private readonly metaService: VendasMetaDbService) {}

  onModuleInit(): void {
    this.ready = this.inicializar();
  }

  async pronto(): Promise<void> {
    await this.inicializar();
  }

  private async inicializar(): Promise<void> {
    if (this.conn) return;
    if (this.abrindo) {
      // Reentrância da migração v1→v2 (`abrir` → `migrarSeNecessario` → `pronto`):
      // esperar `this.ready` aqui seria esperar a própria promessa em curso e travar
      // o processo. A migração quer exatamente isto: a conexão aberta para gravar.
      await this.abrirConexao();
      return;
    }
    if (!this.ready) {
      this.abrindo = true;
      this.ready = this.abrir().finally(() => {
        this.abrindo = false;
      });
    }
    await this.ready;
  }

  private async abrir(): Promise<void> {
    mkdirSync(dataDir(), { recursive: true });

    const migracao = await migrarSeNecessario(this.metaService, this);
    if (migracao && !migracao.ok) {
      this.logger.warn(
        `migração automática falhou (${migracao.motivo}); bases serão recriadas vazias.`,
      );
    }

    // A migração abre a conexão por dentro; reabrir o mesmo arquivo aqui falha com
    // "arquivo já está sendo usado por outro processo" (DuckDB aceita um único escritor).
    if (!this.conn) {
      await this.abrirConexao();
    }

    const versao = (await this.lerVersao()) ?? 0;
    if (versao > FATO_SCHEMA_VERSION) {
      await this.fechar();
      const arquivado = `${this.caminho}.incompativel-${Date.now()}`;
      renameSync(this.caminho, arquivado);
      this.logger.warn(
        `fato na versão ${versao} (esta build entende ${FATO_SCHEMA_VERSION}); ` +
          `arquivado em ${arquivado} e recriado vazio.`,
      );
      const reaberto = await this.abrirConexao();
      await this.criarDoZero();
      return;
    }

    if (versao === 0) {
      await this.criarDoZero();
    }
  }

  async conexao(): Promise<FatoConn> {
    await this.inicializar();
    return this.conn!;
  }

  /** Abre o arquivo DuckDB e guarda instância + conexão. Não valida esquema. */
  private async abrirConexao(): Promise<{
    instance: DuckDBInstance;
    conn: FatoConn;
  }> {
    const aberto = await abrirDuckDB(this.caminho);
    this.instance = aberto.instance;
    this.conn = aberto.conn;
    return aberto;
  }

  caminhoArquivo(): string {
    return this.caminho;
  }

  async versaoEsquema(): Promise<number> {
    await this.inicializar();
    return (await this.lerVersao()) ?? 0;
  }

  async integridade(): Promise<'ok' | 'corrompido' | 'ausente'> {
    if (!existsSync(this.caminho)) return 'ausente';
    try {
      await this.inicializar();
      await consultarUm(this.conn!, 'SELECT COUNT(*) AS c FROM pedido');
      return 'ok';
    } catch {
      return 'corrompido';
    }
  }

  async contarPedidos(instanciaId?: number): Promise<number> {
    await this.inicializar();
    const sql = instanciaId
      ? 'SELECT COUNT(*) AS c FROM pedido WHERE instancia_id = ?'
      : 'SELECT COUNT(*) AS c FROM pedido';
    const r = await consultarUm<{ c: number }>(
      this.conn!,
      sql,
      instanciaId ? [instanciaId] : [],
    );
    return Number(r?.c ?? 0);
  }

  onModuleDestroy(): void {
    void this.fechar();
  }

  async fechar(): Promise<void> {
    this.conn = undefined;
    this.instance = undefined;
    this.ready = undefined;
  }

  private async criarDoZero(): Promise<void> {
    await executar(this.conn!, DDL_FATO);
    await executar(
      this.conn!,
      `DELETE FROM _schema_version; INSERT INTO _schema_version VALUES (${FATO_SCHEMA_VERSION})`,
    );
  }

  private async lerVersao(): Promise<number | null> {
    try {
      const r = await consultarUm<{ version: number }>(
        this.conn!,
        'SELECT version FROM _schema_version LIMIT 1',
      );
      return r ? Number(r.version) : null;
    } catch {
      return null;
    }
  }

  existeArquivo(): boolean {
    return existsSync(this.caminho);
  }
}

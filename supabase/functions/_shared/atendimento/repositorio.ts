// Acesso a dados do agente de atendimento, sobre Postgres. Conexão
// privilegiada: toda consulta filtra por tenant_id, e o tenant_id vem do canal
// identificado pelo token do webhook.

// @ts-types="npm:postgres@3.4.5"
import postgres from "postgres";
import type { Passo } from "./agente.ts";
import type { TurnoGuardado } from "./contexto.ts";
import type { ConfigAtendimento } from "./roteador.ts";

export interface Canal {
  canal_id: string;
  tenant_id: string;
  conta_externa: string;
  base_url: string;
  permite_http: boolean;
}

export interface Lote {
  conversa_id: string;
  tenant_id: string;
  canal_id: string;
  conversa_externa: string;
  contato: string | null;
  humano: boolean;
  mensagem_ids: string[];
  texto: string;
  anexos: number;
}

export interface RegistroExecucao {
  nivel: 0 | 1 | 2;
  modelo: string | null;
  motivo: string;
  tokens_entrada: number;
  tokens_cache: number;
  tokens_saida: number;
  custo_usd: number;
  duracao_ms: number;
  resultado: string;
}

export function execucaoDePasso(p: Passo): RegistroExecucao {
  return {
    nivel: p.nivel,
    modelo: p.modelo,
    motivo: p.motivo.slice(0, 300),
    ...p.uso,
    duracao_ms: p.duracao_ms,
    resultado: p.resultado,
  };
}

export type RepositorioAtendimento = ReturnType<typeof criarRepositorioAtendimento>;

export function criarRepositorioAtendimento(url: string) {
  const sql = postgres(url, { prepare: false, max: 2, onnotice: () => {} });

  return {
    async identificarCanal(hash: string): Promise<Canal | null> {
      const [linha] = await sql<Canal[]>`select * from atendimento.identificar_canal(${hash})`;
      return linha ?? null;
    },

    async lerSegredoCanal(tenantId: string, canalId: string): Promise<string | null> {
      const [linha] = await sql<{ segredo: string | null }[]>`
        select atendimento.ler_segredo_canal(${tenantId}, ${canalId}) as segredo`;
      return linha?.segredo ?? null;
    },

    async canalDoLote(tenantId: string, canalId: string): Promise<Canal | null> {
      const [linha] = await sql<Canal[]>`
        select id as canal_id, tenant_id, conta_externa, base_url, permite_http
        from atendimento.canais
        where id = ${canalId} and tenant_id = ${tenantId} and ativo`;
      return linha ?? null;
    },

    /** Falso quando a mensagem já tinha sido recebida. */
    async receberMensagem(
      canal: Canal,
      m: {
        conversa_externa: string;
        contato: string | null;
        externa_id: string;
        autor: "cliente" | "humano";
        texto: string;
        anexos: number;
      },
    ): Promise<boolean> {
      const [linha] = await sql<{ nova: boolean }[]>`
        select atendimento.receber_mensagem(
          ${canal.tenant_id}, ${canal.canal_id}, ${m.conversa_externa}, ${m.contato},
          ${m.externa_id}, ${m.autor}::atendimento.autor, ${m.texto}, ${m.anexos}) as nova`;
      return linha.nova;
    },

    async reivindicarLote(esperaSeg: number, leaseSeg = 120): Promise<Lote | null> {
      const [linha] = await sql<Lote[]>`
        select * from atendimento.reivindicar_lote(${esperaSeg}, ${leaseSeg})`;
      return linha ?? null;
    },

    async concluirLote(ids: string[], estado: "concluida" | "ignorada" | "falhou") {
      await sql`
        select atendimento.concluir_lote(${ids}::bigint[], ${estado}::atendimento.estado_mensagem)`;
    },

    async config(tenantId: string): Promise<ConfigAtendimento | null> {
      const [linha] = await sql`
        select modo, modelo_barato, modelo_forte, teto_diario_usd, limite_contato_hora, instrucoes
        from atendimento.config where tenant_id = ${tenantId}`;
      if (!linha) return null;
      return {
        modo: linha.modo,
        modelo_barato: linha.modelo_barato,
        modelo_forte: linha.modelo_forte,
        teto_diario_usd: Number(linha.teto_diario_usd),
        limite_contato_hora: linha.limite_contato_hora,
        instrucoes: linha.instrucoes,
      };
    },

    async usoAtual(tenantId: string, conversaId: string) {
      const [linha] = await sql`
        select * from atendimento.uso_atual(${tenantId}, ${conversaId})`;
      return {
        gasto_dia_usd: Number(linha.gasto_dia_usd),
        mensagens_contato_hora: linha.mensagens_contato_hora as number,
      };
    },

    /**
     * Resumo guardado e os turnos concluídos que vieram depois dele, do mais
     * antigo para o mais novo.
     */
    async contexto(tenantId: string, conversaId: string, limite = 200): Promise<{
      resumo: string | null;
      turnos: TurnoGuardado[];
    }> {
      const [conversa] = await sql<{ resumo: string | null; resumo_ate: string | null }[]>`
        select resumo, resumo_ate from atendimento.conversas
        where id = ${conversaId} and tenant_id = ${tenantId}`;
      const turnos = await sql<TurnoGuardado[]>`
        select id::text as id, autor, texto from (
          select id, autor, texto from atendimento.mensagens
          where conversa_id = ${conversaId} and tenant_id = ${tenantId}
            and estado = 'concluida' and texto <> ''
            and id > ${conversa?.resumo_ate ?? 0}
          order by id desc limit ${limite}
        ) recentes
        -- Qualificado de propósito: só "id" seria a coluna de saída, que é texto,
        -- e a ordem viraria alfabética ("10" antes de "9").
        order by recentes.id`;
      return { resumo: conversa?.resumo ?? null, turnos: [...turnos] };
    },

    async salvarResumo(tenantId: string, conversaId: string, resumo: string, ate: string) {
      await sql`
        update atendimento.conversas set resumo = ${resumo}, resumo_ate = ${ate}
        where id = ${conversaId} and tenant_id = ${tenantId}`;
    },

    async registrarSaida(tenantId: string, conversaId: string, texto: string) {
      await sql`
        insert into atendimento.mensagens (tenant_id, conversa_id, direcao, autor, texto, estado)
        values (${tenantId}, ${conversaId}, 'saida', 'agente', ${
        texto.slice(0, 8000)
      }, 'concluida')`;
    },

    async registrarExecucao(
      tenantId: string,
      conversaId: string,
      sombra: boolean,
      e: RegistroExecucao,
    ) {
      await sql`
        insert into atendimento.execucoes
          (tenant_id, conversa_id, nivel, modelo, motivo, tokens_entrada, tokens_cache,
           tokens_saida, custo_usd, duracao_ms, resultado, sombra)
        values (${tenantId}, ${conversaId}, ${e.nivel}, ${e.modelo}, ${e.motivo},
                ${e.tokens_entrada}, ${e.tokens_cache}, ${e.tokens_saida}, ${e.custo_usd},
                ${e.duracao_ms}, ${e.resultado}, ${sombra})`;
    },

    fechar: () => sql.end({ timeout: 2 }),
  };
}

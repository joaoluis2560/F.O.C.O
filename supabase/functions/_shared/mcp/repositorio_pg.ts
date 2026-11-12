// Implementação do repositório sobre Postgres. A conexão é privilegiada
// (ignora RLS), então toda consulta aqui filtra por tenant_id explicitamente,
// e o tenant_id sempre vem de `identificarCredencial`.

// A versão nativa de Deno do driver não traz tipos; eles vêm do pacote npm.
// @ts-types="npm:postgres@3.4.5"
import postgres from "postgres";
import {
  type ConectorAtivo,
  type Credencial,
  type FatoEncontrado,
  FilaDeRevisaoCheia,
  type Perfil,
  type PropostaPendente,
  type Repositorio,
} from "./repositorio.ts";

/** Converte o erro "fila cheia" do banco (SQLSTATE 54000) no erro do domínio. */
async function comFila<T>(operacao: () => Promise<T>): Promise<T> {
  try {
    return await operacao();
  } catch (erro) {
    if ((erro as { code?: string })?.code === "54000") throw new FilaDeRevisaoCheia();
    throw erro;
  }
}

export function criarRepositorioPg(url: string): Repositorio & { fechar(): Promise<void> } {
  // prepare:false mantém compatibilidade com o pooler em modo transação.
  const sql = postgres(url, { prepare: false, max: 2, onnotice: () => {} });

  return {
    async identificarCredencial(hash) {
      const linhas = await sql<Credencial[]>`
        select credencial_id, tenant_id, perfil
        from nucleo.identificar_credencial(${hash})`;
      return linhas[0] ?? null;
    },

    async contatoDaSessao(tenantId, hashSessao) {
      const [linha] = await sql<{ contato: string | null }[]>`
        select nucleo.contato_da_sessao(${tenantId}, ${hashSessao}) as contato`;
      return linha?.contato ?? null;
    },

    async conectoresAprovados(tenantId) {
      const linhas = await sql`
        select c.id as conector_id, c.capacidade, c.definicao, c.integracao_id,
               i.base_url, i.permite_http, i.tipo_auth, i.auth_config
        from integracao.conectores c
        join integracao.integracoes i
          on i.id = c.integracao_id and i.tenant_id = c.tenant_id
        where c.tenant_id = ${tenantId}
          and c.estado = 'aprovado'
          and i.ativo`;
      return linhas.map((l): ConectorAtivo => ({
        conector_id: l.conector_id,
        capacidade: l.capacidade,
        definicao: l.definicao,
        integracao_id: l.integracao_id,
        integracao: {
          base_url: l.base_url,
          permite_http: l.permite_http,
          tipo_auth: l.tipo_auth,
          auth_config: l.auth_config ?? {},
        },
      }));
    },

    async lerSegredo(tenantId, integracaoId) {
      const [linha] = await sql<{ segredo: string | null }[]>`
        select integracao.ler_segredo(${tenantId}, ${integracaoId}) as segredo`;
      return linha?.segredo ?? null;
    },

    async registrarExecucao(tenantId, conectorId, capacidade, r) {
      await sql`
        insert into integracao.conector_execucoes
          (tenant_id, conector_id, capacidade, ok, status_http, duracao_ms, erro)
        values (${tenantId}, ${conectorId}, ${capacidade}, ${r.ok}, ${r.status_http ?? null},
                ${r.duracao_ms}, ${r.ok ? null : `${r.erro.codigo}: ${r.erro.mensagem}`})`;
    },

    async proporFato(tenantId, fato) {
      await comFila(() =>
        sql`select cerebro.propor_fato_de_agente(${tenantId}, ${sql.json(fato as never)})`
      );
    },

    async proporOrientacao(tenantId, categoria, texto, justificativa, fonte) {
      await comFila(() =>
        sql`select atendimento.propor_orientacao(
              ${tenantId}, ${categoria}::atendimento.categoria_orientacao, ${texto},
              ${justificativa}, 'agente', ${fonte ?? null})`
      );
    },

    async ignorarPergunta(tenantId, perguntaId) {
      await sql`select atendimento.ignorar_pergunta(${tenantId}, ${perguntaId})`;
    },

    async implantacao(tenantId) {
      const [tenant] = await sql<{ segmento: string | null }[]>`
        select segmento from nucleo.tenants where id = ${tenantId}`;
      const linhas = await sql<{ fonte: string }[]>`
        select fonte from atendimento.implantacao_respondidas(${tenantId}) as fonte`;
      return { segmento: tenant?.segmento ?? null, respondidas: linhas.map((l) => l.fonte) };
    },

    async propostasPendentes(tenantId) {
      const [{ total }] = await sql<{ total: number }[]>`
        select atendimento.total_pendente(${tenantId}) as total`;
      const itens = await sql<PropostaPendente[]>`
        select tipo, categoria, titulo, texto, origem
        from atendimento.propostas_pendentes(${tenantId}, 20)`;
      return { total, itens: [...itens] };
    },

    async buscarFatos(tenantId, perfil: Perfil, pergunta, dominio) {
      // Funções distintas por perfil: o atendimento nunca passa por buscar_interno.
      return perfil === "atendimento"
        ? await sql<FatoEncontrado[]>`
            select dominio, tipo, titulo, texto
            from cerebro.buscar_publico(${tenantId}, ${pergunta}, ${dominio})`
        : await sql<FatoEncontrado[]>`
            select dominio, tipo, titulo, texto
            from cerebro.buscar_interno(${tenantId}, ${pergunta}, ${dominio})`;
    },

    fechar: () => sql.end({ timeout: 2 }),
  };
}

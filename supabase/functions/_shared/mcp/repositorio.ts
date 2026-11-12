// Acesso a dados usado pelo servidor MCP. Interface separada da implementação
// para o servidor ser testável sem banco.

import type { Dominio } from "../cerebro/tipos.ts";
import type { DefinicaoConector, Integracao, Resultado } from "../conectores/tipos.ts";

/**
 * atendimento   cliente final: só o que é público, e só os dados dele.
 * equipe        funcionários: conhecimento interno, consultas e propostas.
 * implantacao   dono durante a entrevista de implantação: só propostas. Não
 *               existe como credencial; é usado em processo pelo worker.
 */
export type Perfil = "atendimento" | "equipe" | "implantacao";

export interface Credencial {
  credencial_id: string;
  tenant_id: string;
  perfil: Perfil;
}

export interface ConectorAtivo {
  conector_id: string;
  capacidade: string;
  definicao: DefinicaoConector;
  integracao_id: string;
  integracao: Integracao;
}

export interface FatoEncontrado {
  dominio: string;
  tipo: string;
  titulo: string;
  texto: string;
}

export interface PropostaPendente {
  tipo: "fato" | "orientacao";
  categoria: string;
  titulo: string | null;
  texto: string;
  origem: string;
}

export type CategoriaOrientacao = "tom" | "limite" | "transferir";

/** Lançado quando o tenant já tem propostas demais aguardando revisão. */
export class FilaDeRevisaoCheia extends Error {
  constructor() {
    super("fila de revisão cheia");
    this.name = "FilaDeRevisaoCheia";
  }
}

export interface Repositorio {
  /** Null para token desconhecido, revogado ou de tenant desativado. */
  identificarCredencial(hash: string): Promise<Credencial | null>;
  /**
   * Telefone do cliente final de uma sessão aberta pela entrada do canal.
   * Null para sessão desconhecida, vencida ou de outro tenant.
   */
  contatoDaSessao(tenantId: string, hashSessao: string): Promise<string | null>;
  /** Conectores aprovados de integrações ativas do tenant. */
  conectoresAprovados(tenantId: string): Promise<ConectorAtivo[]>;
  lerSegredo(tenantId: string, integracaoId: string): Promise<string | null>;
  registrarExecucao(
    tenantId: string,
    conectorId: string,
    capacidade: string,
    resultado: Resultado,
  ): Promise<void>;
  // Propostas: nascem aguardando revisão de owner/admin. Nada aqui ativa nada.
  proporFato(tenantId: string, fato: {
    titulo: string;
    texto: string;
    dominio: Dominio;
    visibilidade: "publico" | "interno";
    chaves: string[];
    tipo?: string;
    /** Marca da pergunta de implantação que este fato responde. */
    fonte?: string;
  }): Promise<void>;
  proporOrientacao(
    tenantId: string,
    categoria: CategoriaOrientacao,
    texto: string,
    justificativa: string | null,
    fonte?: string | null,
  ): Promise<void>;
  /** Registra que uma pergunta do roteiro não se aplica à empresa. */
  ignorarPergunta(tenantId: string, perguntaId: string): Promise<void>;
  /** Segmento do tenant e marcas das perguntas de implantação já respondidas. */
  implantacao(tenantId: string): Promise<{ segmento: string | null; respondidas: string[] }>;
  propostasPendentes(tenantId: string): Promise<{ total: number; itens: PropostaPendente[] }>;
  /** `atendimento` só recebe fatos públicos; `equipe` recebe públicos e internos. */
  buscarFatos(
    tenantId: string,
    perfil: Perfil,
    pergunta: string,
    dominio: Dominio | null,
  ): Promise<FatoEncontrado[]>;
}

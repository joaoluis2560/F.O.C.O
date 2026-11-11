// Acesso a dados usado pelo servidor MCP. Interface separada da implementação
// para o servidor ser testável sem banco.

import type { Dominio } from "../cerebro/tipos.ts";
import type { DefinicaoConector, Integracao, Resultado } from "../conectores/tipos.ts";

export type Perfil = "atendimento" | "equipe";

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
  /** `atendimento` só recebe fatos públicos; `equipe` recebe públicos e internos. */
  buscarFatos(
    tenantId: string,
    perfil: Perfil,
    pergunta: string,
    dominio: Dominio | null,
  ): Promise<FatoEncontrado[]>;
}

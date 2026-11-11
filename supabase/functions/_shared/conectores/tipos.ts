export type TipoCapacidade = "leitura" | "escrita";
export type Identidade = "nenhuma" | "cliente";
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Capacidade canônica: o que o agente enxerga, igual para todo tenant. */
export interface Capacidade {
  nome: string;
  dominio: string;
  tipo: TipoCapacidade;
  identidade: Identidade;
  descricao: string;
  entrada: Record<string, unknown>;
  saida: Record<string, unknown>;
}

export interface Catalogo {
  versao: number;
  capacidades: Capacidade[];
}

export type TipoAuth = "nenhuma" | "bearer" | "cabecalho" | "basic";

/** Sistema de gestão de um tenant. O segredo vem do Vault, fora deste objeto. */
export interface Integracao {
  base_url: string;
  permite_http: boolean;
  tipo_auth: TipoAuth;
  auth_config: { cabecalho?: string; usuario?: string };
}

export type Metodo = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Definição declarativa de um conector. Executada sem modelo de linguagem. */
export interface DefinicaoConector {
  requisicao: {
    metodo: Metodo;
    /** Relativo à base_url. Aceita {{entrada.x}} e {{contexto.cliente_id}}. */
    caminho: string;
    query?: Record<string, string>;
    cabecalhos?: Record<string, string>;
    /** Corpo fixo com marcadores. Use este ou corpo_mapeamento, não os dois. */
    corpo?: Json;
    /** Expressão JSONata sobre {entrada, contexto} que produz o corpo. */
    corpo_mapeamento?: string;
  };
  resposta: {
    /** Expressão JSONata: corpo da resposta -> saída canônica. */
    mapeamento: string;
    /** Saída fixa para um status HTTP esperado, ex.: {"404": {"encontrado": false}}. */
    por_status?: Record<string, Json>;
  };
}

/** Dados resolvidos pelo servidor. Nunca preenchidos pelo modelo. */
export interface Contexto {
  cliente_id?: string;
}

export type CodigoErro =
  | "definicao_invalida"
  | "entrada_invalida"
  | "identidade_ausente"
  | "aprovacao_ausente"
  | "destino_bloqueado"
  | "tempo_esgotado"
  | "falha_de_rede"
  | "http_erro"
  | "resposta_grande"
  | "resposta_invalida"
  | "mapeamento_falhou"
  | "saida_invalida";

export type Resultado =
  | { ok: true; saida: Json; status_http: number; duracao_ms: number }
  | {
    ok: false;
    erro: { codigo: CodigoErro; mensagem: string };
    status_http?: number;
    duracao_ms: number;
  };

export class ErroConector extends Error {
  constructor(public codigo: CodigoErro, mensagem: string) {
    super(mensagem);
    this.name = "ErroConector";
  }
}

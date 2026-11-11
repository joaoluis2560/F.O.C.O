// Construtor de conectores: para cada capacidade do catálogo, pede um rascunho
// a um gerador (Claude), valida a forma, testa contra o sandbox do sistema do
// tenant e devolve o resultado para revisão humana. Nada aqui publica ou aprova.

import {
  executarConector,
  hashDefinicao,
  validarDefinicao,
} from "../../supabase/functions/_shared/conectores/executor.ts";
import {
  type Capacidade,
  type Contexto,
  type DefinicaoConector,
  ErroConector,
  type Integracao,
  type Json,
} from "../../supabase/functions/_shared/conectores/tipos.ts";

export interface Proposta {
  /** Falso quando a API não oferece o necessário para a capacidade. */
  viavel: boolean;
  motivo: string;
  definicao?: DefinicaoConector;
}

export interface TentativaAnterior {
  definicao: DefinicaoConector;
  erro: string;
}

/** Gera um rascunho de conector. Implementado por Claude ou por um dublê de teste. */
export type Gerador = (
  capacidade: Capacidade,
  openapi: string,
  anterior?: TentativaAnterior,
) => Promise<Proposta>;

export interface Exemplo {
  entrada: Json;
  contexto: Contexto;
}

export type EstadoRascunho =
  /** Rodou contra o sandbox e a saída bate com o esquema canônico. */
  | "testado"
  /** Forma válida, mas não foi executado (sem exemplo, ou escrita não autorizada). */
  | "nao_testado"
  /** Todas as tentativas falharam. */
  | "falhou"
  /** O gerador concluiu que a API não cobre a capacidade. */
  | "inviavel";

export interface Rascunho {
  capacidade: string;
  tipo: Capacidade["tipo"];
  estado: EstadoRascunho;
  tentativas: number;
  motivo: string;
  definicao?: DefinicaoConector;
  hash?: string;
}

export interface OpcoesConstrucao {
  capacidades: Capacidade[];
  openapi: string;
  integracao: Integracao;
  segredo?: string;
  exemplos: Record<string, Exemplo>;
  gerar: Gerador;
  /** Executa capacidades de escrita no sandbox. Só ligue em ambiente de teste. */
  testar_escrita?: boolean;
  max_tentativas?: number;
}

async function construirUm(cap: Capacidade, o: OpcoesConstrucao): Promise<Rascunho> {
  const max = o.max_tentativas ?? 2;
  const base = { capacidade: cap.nome, tipo: cap.tipo };
  let anterior: TentativaAnterior | undefined;

  for (let tentativa = 1; tentativa <= max; tentativa++) {
    const proposta = await o.gerar(cap, o.openapi, anterior);
    if (!proposta.viavel || !proposta.definicao) {
      return { ...base, estado: "inviavel", tentativas: tentativa, motivo: proposta.motivo };
    }
    const definicao = proposta.definicao;

    let erro: string | null = null;
    try {
      validarDefinicao(definicao, cap);
    } catch (causa) {
      erro = causa instanceof ErroConector
        ? `${causa.codigo}: ${causa.message}`
        : "erro inesperado";
    }

    const exemplo = o.exemplos[cap.nome];
    const podeExecutar = exemplo !== undefined && (cap.tipo === "leitura" || o.testar_escrita);
    if (erro === null && !podeExecutar) {
      return {
        ...base,
        estado: "nao_testado",
        tentativas: tentativa,
        motivo: exemplo === undefined
          ? "sem exemplo de entrada para testar"
          : "escrita não executada no sandbox",
        definicao,
        hash: await hashDefinicao(definicao),
      };
    }
    if (erro === null) {
      const r = await executarConector({
        capacidade: cap,
        integracao: o.integracao,
        definicao,
        entrada: exemplo.entrada,
        contexto: exemplo.contexto,
        segredo: o.segredo,
        aprovado: cap.tipo === "escrita" ? true : undefined,
      });
      if (r.ok) {
        return {
          ...base,
          estado: "testado",
          tentativas: tentativa,
          motivo: proposta.motivo,
          definicao,
          hash: await hashDefinicao(definicao),
        };
      }
      // Só código e mensagem do executor: nenhum dado da resposta volta ao modelo.
      erro = `${r.erro.codigo}: ${r.erro.mensagem}`;
    }

    anterior = { definicao, erro };
    if (tentativa === max) {
      return { ...base, estado: "falhou", tentativas: tentativa, motivo: erro, definicao };
    }
  }
  throw new Error("max_tentativas deve ser pelo menos 1");
}

/** Gera e testa um rascunho por capacidade, em sequência. */
export async function construir(o: OpcoesConstrucao): Promise<Rascunho[]> {
  const rascunhos: Rascunho[] = [];
  for (const cap of o.capacidades) rascunhos.push(await construirUm(cap, o));
  return rascunhos;
}

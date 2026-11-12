// Pacote de domínio: roteiro de perguntas da implantação. Cada resposta vira
// um fato proposto.

import {
  type Dominio,
  type FatoProposto,
  LIMITE_TEXTO,
  type TipoFato,
  type Visibilidade,
} from "./tipos.ts";

export interface PerguntaPacote {
  id: string;
  dominio: Dominio;
  tipo: TipoFato;
  visibilidade: Visibilidade;
  titulo: string;
  pergunta: string;
  chaves: string[];
  /**
   * Quando presente, a resposta não vira fato do cérebro: vira orientação de
   * comportamento do atendimento (tom, limite ou quando transferir).
   */
  orientacao?: "tom" | "limite" | "transferir";
}

export interface OrientacaoProposta {
  categoria: "tom" | "limite" | "transferir";
  texto: string;
  fonte: string;
}

/** Orientação de partida de um nicho. Entra como proposta para o dono aprovar. */
export interface OrientacaoPadrao {
  id: string;
  categoria: "tom" | "limite" | "transferir";
  texto: string;
}

export interface Pacote {
  versao: number;
  nome: string;
  descricao: string;
  perguntas: PerguntaPacote[];
  /** Presentes em pacote montado a partir de um nicho. */
  segmento?: string;
  orientacoes_padrao?: OrientacaoPadrao[];
  /** Capacidades canônicas que fazem sentido para o nicho. */
  capacidades?: string[];
}

/** Camada de nicho: perguntas a mais, perguntas da base que não se aplicam e limites de partida. */
export interface PacoteDeNicho {
  versao: number;
  nome: string;
  segmento: string;
  rotulo: string;
  estende: string;
  descricao: string;
  omitir: string[];
  capacidades: string[];
  perguntas: PerguntaPacote[];
  orientacoes_padrao: OrientacaoPadrao[];
}

/**
 * Junta a base com um nicho. As perguntas do nicho vêm primeiro: são as que
 * mostram ao dono que a ferramenta entende do negócio dele.
 */
export function montarPacote(base: Pacote, nicho?: PacoteDeNicho): Pacote {
  if (!nicho) return base;
  if (nicho.estende !== base.nome) {
    throw new Error(`pacote ${nicho.nome} estende ${nicho.estende}, não ${base.nome}`);
  }
  const daBase = new Set(base.perguntas.map((p) => p.id));
  const inexistentes = nicho.omitir.filter((id) => !daBase.has(id));
  if (inexistentes.length) {
    throw new Error(
      `pacote ${nicho.nome} omite perguntas inexistentes: ${inexistentes.join(", ")}`,
    );
  }
  const repetidas = nicho.perguntas.filter((p) => daBase.has(p.id)).map((p) => p.id);
  if (repetidas.length) {
    throw new Error(`pacote ${nicho.nome} repete perguntas da base: ${repetidas.join(", ")}`);
  }
  const omitir = new Set(nicho.omitir);
  return {
    // Versão composta: muda se a base ou o nicho mudarem.
    versao: base.versao * 1000 + nicho.versao,
    nome: nicho.nome,
    descricao: nicho.descricao,
    segmento: nicho.segmento,
    capacidades: nicho.capacidades,
    orientacoes_padrao: nicho.orientacoes_padrao,
    perguntas: [...nicho.perguntas, ...base.perguntas.filter((p) => !omitir.has(p.id))],
  };
}

/** Marca de origem gravada no fato ou na orientação que responde a uma pergunta. */
export function fonteDaPergunta(pacote: Pacote, perguntaId: string): string {
  return `pacote:${pacote.nome}@${pacote.versao}#${perguntaId}`;
}

/** Id da pergunta (ou orientação padrão) dentro de uma marca de origem; null se não for de pacote. */
export function perguntaDaFonte(fonte: string | null): string | null {
  return fonte?.match(/^pacote:[^#]+#(.+)$/)?.[1] ?? null;
}

export interface ResultadoPacote {
  fatos: FatoProposto[];
  orientacoes: OrientacaoProposta[];
  /** Perguntas ainda sem resposta. */
  pendentes: string[];
}

/**
 * Converte respostas (id da pergunta -> texto) em fatos propostos.
 * Resposta em branco fica pendente. Id desconhecido ou resposta longa demais
 * é erro: melhor parar do que gravar algo cortado ou no lugar errado.
 */
export function fatosDoPacote(pacote: Pacote, respostas: Record<string, string>): ResultadoPacote {
  const conhecidas = new Set(pacote.perguntas.map((p) => p.id));
  const desconhecidas = Object.keys(respostas).filter((id) => !conhecidas.has(id));
  if (desconhecidas.length) {
    throw new Error(`respostas para perguntas inexistentes: ${desconhecidas.join(", ")}`);
  }

  const fatos: FatoProposto[] = [];
  const orientacoes: OrientacaoProposta[] = [];
  const pendentes: string[] = [];
  for (const p of pacote.perguntas) {
    const texto = (respostas[p.id] ?? "").trim();
    if (!texto) {
      pendentes.push(p.id);
      continue;
    }
    if (texto.length > LIMITE_TEXTO) {
      throw new Error(`resposta de ${p.id} passa de ${LIMITE_TEXTO} caracteres; divida em partes`);
    }
    if (p.orientacao) {
      if (texto.length > 600) {
        throw new Error(`resposta de ${p.id} passa de 600 caracteres; resuma ou divida`);
      }
      orientacoes.push({ categoria: p.orientacao, texto, fonte: fonteDaPergunta(pacote, p.id) });
      continue;
    }
    fatos.push({
      dominio: p.dominio,
      tipo: p.tipo,
      titulo: p.titulo,
      texto,
      visibilidade: p.visibilidade,
      chaves: p.chaves,
      fonte: fonteDaPergunta(pacote, p.id),
    });
  }
  return { fatos, orientacoes, pendentes };
}

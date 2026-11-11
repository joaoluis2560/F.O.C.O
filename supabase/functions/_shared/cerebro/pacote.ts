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
}

export interface Pacote {
  versao: number;
  nome: string;
  descricao: string;
  perguntas: PerguntaPacote[];
}

export interface ResultadoPacote {
  fatos: FatoProposto[];
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
    fatos.push({
      dominio: p.dominio,
      tipo: p.tipo,
      titulo: p.titulo,
      texto,
      visibilidade: p.visibilidade,
      chaves: p.chaves,
      fonte: `pacote:${pacote.nome}@${pacote.versao}#${p.id}`,
    });
  }
  return { fatos, pendentes };
}

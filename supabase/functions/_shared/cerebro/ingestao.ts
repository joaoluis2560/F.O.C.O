// Ingestão de material: um documento da empresa vira fatos propostos.
// A extração é feita por um extrator injetado (Claude ou dublê de teste).
// Tudo que sai daqui é proposta: nada chega ao cliente sem revisão humana.

import { DOMINIOS, type FatoProposto, LIMITE_TEXTO, LIMITE_TITULO, TIPOS_FATO } from "./tipos.ts";

/** Fato bruto devolvido pelo extrator, ainda não conferido. */
export interface FatoExtraido {
  dominio: string;
  tipo: string;
  titulo: string;
  texto: string;
  chaves: string[];
}

export type Extrator = (titulo: string, texto: string) => Promise<FatoExtraido[]>;

export interface ResultadoIngestao {
  fatos: FatoProposto[];
  /** Itens devolvidos pelo extrator que não passaram na conferência. */
  descartados: { titulo: string; motivo: string }[];
}

/** Acima disso o material deve ser dividido antes; nunca é cortado em silêncio. */
export const LIMITE_MATERIAL = 60_000;
const MAX_FATOS = 60;

function inclui<T extends string>(lista: readonly T[], valor: string): valor is T {
  return (lista as readonly string[]).includes(valor);
}

export async function proporDeMaterial(
  titulo: string,
  texto: string,
  extrair: Extrator,
): Promise<ResultadoIngestao> {
  const conteudo = texto.trim();
  if (!conteudo) throw new Error("material vazio");
  if (conteudo.length > LIMITE_MATERIAL) {
    throw new Error(
      `material com ${conteudo.length} caracteres passa do limite de ${LIMITE_MATERIAL}; divida em partes`,
    );
  }

  const extraidos = await extrair(titulo, conteudo);
  const fatos: FatoProposto[] = [];
  const descartados: ResultadoIngestao["descartados"] = [];
  const vistos = new Set<string>();

  for (const e of extraidos) {
    const t = (e.titulo ?? "").trim();
    const corpo = (e.texto ?? "").trim();
    const recusar = (motivo: string) => descartados.push({ titulo: t.slice(0, 80), motivo });

    if (!t || !corpo) recusar("título ou texto vazio");
    else if (t.length > LIMITE_TITULO) recusar("título longo demais");
    else if (corpo.length > LIMITE_TEXTO) recusar("texto longo demais");
    else if (!inclui(DOMINIOS, e.dominio)) recusar(`domínio desconhecido: ${e.dominio}`);
    else if (!inclui(TIPOS_FATO, e.tipo)) recusar(`tipo desconhecido: ${e.tipo}`);
    else if (vistos.has(t.toLowerCase())) recusar("título repetido");
    else if (fatos.length >= MAX_FATOS) recusar(`mais de ${MAX_FATOS} fatos em um material`);
    else {
      vistos.add(t.toLowerCase());
      fatos.push({
        dominio: e.dominio,
        tipo: e.tipo,
        titulo: t,
        texto: corpo,
        // O extrator não decide o que o cliente pode ver: isso é da revisão humana.
        visibilidade: "interno",
        chaves: (e.chaves ?? []).filter((c) => typeof c === "string" && c.trim()).slice(0, 8),
        fonte: `material:${titulo}`,
      });
    }
  }
  return { fatos, descartados };
}

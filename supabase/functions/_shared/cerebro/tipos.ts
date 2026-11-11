export const DOMINIOS = [
  "geral",
  "vendas",
  "marketing",
  "financeiro",
  "estoque",
  "clientes",
  "operacao",
] as const;
export const TIPOS_FATO = ["informacao", "regra", "procedimento", "faq"] as const;
export const VISIBILIDADES = ["publico", "interno", "restrito"] as const;

export type Dominio = typeof DOMINIOS[number];
export type TipoFato = typeof TIPOS_FATO[number];
export type Visibilidade = typeof VISIBILIDADES[number];

/** Fato no formato aceito por cerebro.propor_fatos (sempre nasce proposto). */
export interface FatoProposto {
  dominio: Dominio;
  tipo: TipoFato;
  titulo: string;
  texto: string;
  /** Sugestão. Só vale depois que owner/admin revisa. */
  visibilidade: Visibilidade;
  chaves: string[];
  fonte?: string;
}

export const LIMITE_TITULO = 200;
export const LIMITE_TEXTO = 4000;

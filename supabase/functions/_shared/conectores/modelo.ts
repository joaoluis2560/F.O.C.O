// Preenchimento de {{entrada.x}} e {{contexto.y}} na definição do conector.

import { type Contexto, ErroConector, type Json } from "./tipos.ts";

export interface Variaveis {
  entrada: Json;
  contexto: Contexto;
}

const MARCADOR = /\{\{\s*([a-z_]+(?:\.[A-Za-z0-9_]+)+)\s*\}\}/g;
const MARCADOR_UNICO = /^\{\{\s*([a-z_]+(?:\.[A-Za-z0-9_]+)+)\s*\}\}$/;

function buscar(caminho: string, vars: Variaveis): Json {
  const [raiz, ...resto] = caminho.split(".");
  if (raiz !== "entrada" && raiz !== "contexto") {
    throw new ErroConector("definicao_invalida", `variável desconhecida: ${caminho}`);
  }
  let atual: unknown = raiz === "entrada" ? vars.entrada : vars.contexto;
  for (const chave of resto) {
    if (atual === null || typeof atual !== "object" || !Object.hasOwn(atual, chave)) {
      throw new ErroConector("entrada_invalida", `valor ausente: ${caminho}`);
    }
    atual = (atual as Record<string, unknown>)[chave];
  }
  if (atual === undefined) {
    throw new ErroConector("entrada_invalida", `valor ausente: ${caminho}`);
  }
  return atual as Json;
}

function escalar(caminho: string, valor: Json): string {
  if (typeof valor === "string" || typeof valor === "number" || typeof valor === "boolean") {
    return String(valor);
  }
  throw new ErroConector("entrada_invalida", `valor não escalar em texto: ${caminho}`);
}

/** Texto com marcadores substituídos. `codificar` é aplicado a cada valor. */
export function preencherTexto(
  texto: string,
  vars: Variaveis,
  codificar: (v: string) => string = (v) => v,
): string {
  return texto.replace(
    MARCADOR,
    (_, caminho) => codificar(escalar(caminho, buscar(caminho, vars))),
  );
}

/** Caminho de URL: cada valor vira um único segmento codificado. */
export function preencherCaminho(caminho: string, vars: Variaveis): string {
  return preencherTexto(caminho, vars, (v) => {
    if (v === "" || v === "." || v === "..") {
      throw new ErroConector("entrada_invalida", "valor inválido em caminho de URL");
    }
    return encodeURIComponent(v);
  });
}

/** Corpo JSON: marcador sozinho preserva o tipo; dentro de texto vira string. */
export function preencherJson(modelo: Json, vars: Variaveis): Json {
  if (typeof modelo === "string") {
    const unico = modelo.match(MARCADOR_UNICO);
    return unico ? buscar(unico[1], vars) : preencherTexto(modelo, vars);
  }
  if (Array.isArray(modelo)) return modelo.map((item) => preencherJson(item, vars));
  if (modelo !== null && typeof modelo === "object") {
    return Object.fromEntries(
      Object.entries(modelo).map(([k, v]) => [k, preencherJson(v, vars)]),
    );
  }
  return modelo;
}

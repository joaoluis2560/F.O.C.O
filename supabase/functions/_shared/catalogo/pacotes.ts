// Pacotes de implantação: o pacote base (perguntas que toda PME responde) e os
// de nicho, que estendem a base. O segmento informado pelo cliente escolhe o
// pacote; sem pacote de nicho, vale a base.

import base from "./pacotes/base.json" with { type: "json" };
import otica from "./pacotes/otica.json" with { type: "json" };
import supermercado from "./pacotes/supermercado.json" with { type: "json" };
import { montarPacote, type Pacote, type PacoteDeNicho } from "../cerebro/pacote.ts";

const NICHOS: PacoteDeNicho[] = [otica as PacoteDeNicho, supermercado as PacoteDeNicho];

/** Segmentos com pacote próprio, para oferecer na página de cadastro. */
export const SEGMENTOS = NICHOS.map((n) => ({ segmento: n.segmento, rotulo: n.rotulo }));

/** Pacote completo (base + nicho) de um segmento. Segmento desconhecido usa a base. */
export function pacoteDoSegmento(segmento: string | null | undefined): Pacote {
  const nicho = NICHOS.find((n) => n.segmento === segmento);
  return montarPacote(base as Pacote, nicho);
}

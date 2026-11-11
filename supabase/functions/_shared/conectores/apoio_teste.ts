// Apoio para testes: sobe o ERP simulado em porta livre e carrega o catálogo
// e os conectores de referência.

import { criarErpSimulado, TOKEN_PADRAO } from "../../../../ferramentas/erp-simulado/servidor.ts";
import type { Capacidade, Catalogo, DefinicaoConector, Integracao } from "./tipos.ts";

const raiz = new URL("../../../../", import.meta.url);

export async function carregarCatalogo(): Promise<Map<string, Capacidade>> {
  const texto = await Deno.readTextFile(new URL("catalogo/capacidades.json", raiz));
  const catalogo = JSON.parse(texto) as Catalogo;
  return new Map(catalogo.capacidades.map((c) => [c.nome, c]));
}

export async function carregarConector(capacidade: string): Promise<DefinicaoConector> {
  const arquivo = new URL(`ferramentas/erp-simulado/conectores/${capacidade}.json`, raiz);
  return JSON.parse(await Deno.readTextFile(arquivo));
}

export function subirErp() {
  const erp = criarErpSimulado();
  const servidor = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, erp.tratar);
  const integracao: Integracao = {
    base_url: `http://127.0.0.1:${servidor.addr.port}`,
    permite_http: true,
    tipo_auth: "bearer",
    auth_config: {},
  };
  return { erp, integracao, segredo: TOKEN_PADRAO, parar: () => servidor.shutdown() };
}

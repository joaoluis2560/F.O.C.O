// Servidor MCP do F.O.C.O rodando direto no host, para desenvolvimento e piloto
// local. Mesmo código da Edge Function `mcp`; a diferença é que daqui ele
// alcança o ERP simulado em 127.0.0.1.
//
// deno task mcp-local

import catalogo from "../supabase/functions/_shared/catalogo/capacidades.json" with {
  type: "json",
};
import type { Catalogo } from "../supabase/functions/_shared/conectores/tipos.ts";
import { criarRepositorioPg } from "../supabase/functions/_shared/mcp/repositorio_pg.ts";
import { tratarMcp } from "../supabase/functions/_shared/mcp/servidor.ts";

const url = Deno.env.get("FOCO_DB_URL");
if (!url) {
  console.error("defina FOCO_DB_URL (use `deno task mcp-local`)");
  Deno.exit(2);
}
const porta = Number(Deno.env.get("FOCO_MCP_PORTA") ?? 8790);
const repo = criarRepositorioPg(url);

// Só loopback: é um servidor de desenvolvimento, não deve ficar visível na rede.
Deno.serve({ port: porta, hostname: "127.0.0.1" }, async (req) => {
  if (new URL(req.url).pathname !== "/mcp") return new Response("não encontrado", { status: 404 });
  try {
    return await tratarMcp(req, { repo, catalogo: catalogo as Catalogo });
  } catch (erro) {
    console.error("mcp: erro interno", erro instanceof Error ? erro.message : "desconhecido");
    return new Response(JSON.stringify({ error: "erro interno" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

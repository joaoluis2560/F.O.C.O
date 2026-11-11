// Edge Function: servidor MCP do F.O.C.O.
// A verificação de JWT da plataforma fica desligada (supabase/config.toml):
// a autenticação é o token por tenant conferido em tratarMcp.

import catalogo from "../_shared/catalogo/capacidades.json" with { type: "json" };
import type { Catalogo } from "../_shared/conectores/tipos.ts";
import { criarRepositorioPg } from "../_shared/mcp/repositorio_pg.ts";
import { tratarMcp } from "../_shared/mcp/servidor.ts";

const url = Deno.env.get("SUPABASE_DB_URL");
if (!url) throw new Error("SUPABASE_DB_URL não definida");

const repo = criarRepositorioPg(url);

Deno.serve(async (req) => {
  try {
    return await tratarMcp(req, { repo, catalogo: catalogo as Catalogo });
  } catch (erro) {
    // Sem detalhes para o cliente: o erro pode conter dado de tenant.
    console.error(
      "mcp: erro interno",
      erro instanceof Error ? `${erro.name}: ${erro.message}` : "desconhecido",
    );
    return new Response(JSON.stringify({ error: "erro interno" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

// Edge Function: worker do atendimento. Cada chamada processa os lotes que já
// estão prontos na fila. Exige o JWT de serviço da plataforma (verify_jwt
// ligado, que é o padrão), então só o próprio projeto consegue invocá-la.

import catalogo from "../_shared/catalogo/capacidades.json" with { type: "json" };
import { criarClienteChatwoot } from "../_shared/atendimento/chatwoot.ts";
import { type ClienteModelo, criarClienteOpenRouter } from "../_shared/atendimento/modelo.ts";
import { criarRepositorioAtendimento } from "../_shared/atendimento/repositorio.ts";
import { processarProximoLote } from "../_shared/atendimento/worker.ts";
import type { Catalogo } from "../_shared/conectores/tipos.ts";
import { criarRepositorioPg } from "../_shared/mcp/repositorio_pg.ts";

const url = Deno.env.get("SUPABASE_DB_URL");
if (!url) throw new Error("SUPABASE_DB_URL não definida");
// Sem a chave o worker continua aplicando as regras sem modelo; o que precisar
// de modelo falha e é transferido para a equipe, com o motivo na nota interna.
const chave = Deno.env.get("OPENROUTER_API_KEY");

const repo = criarRepositorioAtendimento(url);
const nucleo = criarRepositorioPg(url);
const modelo: ClienteModelo = chave
  ? criarClienteOpenRouter({ chave })
  : () => Promise.reject(new Error("OPENROUTER_API_KEY não definida"));
const MAX_LOTES = 5;

Deno.serve(async () => {
  let processados = 0;
  let falhas = 0;
  for (let i = 0; i < MAX_LOTES; i++) {
    try {
      const r = await processarProximoLote({
        repo,
        nucleo,
        catalogo: catalogo as Catalogo,
        modelo,
        canal: (c, token) =>
          criarClienteChatwoot({
            base_url: c.base_url,
            permite_http: c.permite_http,
            conta_externa: c.conta_externa,
            token,
          }),
      });
      if (!r) break;
      processados++;
    } catch (erro) {
      falhas++;
      console.error("worker: lote falhou", erro instanceof Error ? erro.message : "desconhecido");
    }
  }
  return new Response(JSON.stringify({ processados, falhas }), {
    headers: { "content-type": "application/json" },
  });
});

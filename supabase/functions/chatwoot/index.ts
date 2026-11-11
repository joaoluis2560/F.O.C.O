// Edge Function: entrada do Chatwoot (webhook de Agent Bot).
// Só grava a mensagem na fila e responde rápido; quem pensa é o worker.
// URL: /functions/v1/chatwoot?t=<token do canal>

import { criarRepositorioAtendimento } from "../_shared/atendimento/repositorio.ts";
import { interpretarWebhook } from "../_shared/atendimento/chatwoot.ts";
import { lerCorpoLimitado, sha256Hex } from "../_shared/mcp/servidor.ts";

const url = Deno.env.get("SUPABASE_DB_URL");
if (!url) throw new Error("SUPABASE_DB_URL não definida");
const repo = criarRepositorioAtendimento(url);

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "use POST" }, 405);

    // 1. O token na URL identifica canal e tenant. Nada no corpo é confiável para isso.
    const token = new URL(req.url).searchParams.get("t") ?? "";
    const canal = /^[A-Za-z0-9_-]{20,}$/.test(token)
      ? await repo.identificarCanal(await sha256Hex(token))
      : null;
    if (!canal) return json({ error: "não autorizado" }, 401);

    const bruto = await lerCorpoLimitado(req, 200_000);
    if (bruto === null) return json({ error: "requisição grande demais" }, 413);
    let corpo: unknown;
    try {
      corpo = JSON.parse(bruto);
    } catch {
      return json({ error: "JSON inválido" }, 400);
    }

    const evento = interpretarWebhook(corpo);
    if (evento.tipo === "ignorar") return json({ ok: true, ignorado: evento.motivo });
    // 2. A conta do corpo precisa ser a do canal cadastrado.
    if (evento.conta_externa !== canal.conta_externa) {
      return json({ error: "conta não corresponde ao canal" }, 403);
    }
    const nova = await repo.receberMensagem(canal, evento);
    return json({ ok: true, nova });
  } catch (erro) {
    console.error("chatwoot: erro interno", erro instanceof Error ? erro.message : "desconhecido");
    return json({ error: "erro interno" }, 500);
  }
});

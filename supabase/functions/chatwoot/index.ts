// Edge Function: entrada do Chatwoot (webhook de Agent Bot).
// Só grava a mensagem na fila e responde rápido; quem pensa é o worker.
//
// URL: /functions/v1/chatwoot?c=<id do canal>
// O id do canal não é segredo. A origem é provada pela assinatura que o
// Chatwoot envia em X-Chatwoot-Signature, calculada sobre o horário e o corpo
// bruto com o segredo do webhook (guardado no Vault).

import { interpretarWebhook, verificarAssinatura } from "../_shared/atendimento/chatwoot.ts";
import { criarRepositorioAtendimento } from "../_shared/atendimento/repositorio.ts";
import { lerCorpoLimitado } from "../_shared/mcp/servidor.ts";

const url = Deno.env.get("SUPABASE_DB_URL");
if (!url) throw new Error("SUPABASE_DB_URL não definida");
const repo = criarRepositorioAtendimento(url);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return json({ error: "use POST" }, 405);

    const canalId = new URL(req.url).searchParams.get("c") ?? "";
    const canal = UUID.test(canalId) ? await repo.canalDoWebhook(canalId) : null;
    // Mesma resposta para canal inexistente e assinatura errada.
    const negado = () => json({ error: "não autorizado" }, 401);
    if (!canal) {
      await req.body?.cancel();
      return negado();
    }

    const bruto = await lerCorpoLimitado(req, 200_000);
    if (bruto === null) return json({ error: "requisição grande demais" }, 413);

    // 1. Prova de origem: assinatura sobre o corpo bruto, antes de interpretá-lo.
    const recusa = await verificarAssinatura(
      canal.segredo_assinatura,
      req.headers.get("x-chatwoot-timestamp"),
      req.headers.get("x-chatwoot-signature"),
      bruto,
    );
    if (recusa) return negado();

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
    // 3. Reenvio da mesma mensagem não entra duas vezes (id externo único).
    const nova = await repo.receberMensagem(canal, evento);
    return json({ ok: true, nova });
  } catch (erro) {
    console.error("chatwoot: erro interno", erro instanceof Error ? erro.message : "desconhecido");
    return json({ error: "erro interno" }, 500);
  }
});

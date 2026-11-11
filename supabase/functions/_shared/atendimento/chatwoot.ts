// Chatwoot: leitura do webhook de Agent Bot e envio de respostas pela API.
//
// O formato do webhook e os endpoints seguem a documentação pública do
// Chatwoot e ainda não foram exercitados contra uma instância real.

import { validarDestino } from "../conectores/seguranca.ts";

export type EventoCanal =
  | { tipo: "ignorar"; motivo: string }
  | {
    tipo: "mensagem";
    autor: "cliente" | "humano";
    conta_externa: string;
    conversa_externa: string;
    externa_id: string;
    contato: string | null;
    texto: string;
    anexos: number;
  };

function telefone(valor: unknown): string | null {
  if (typeof valor !== "string") return null;
  const digitos = valor.replace(/\D/g, "");
  return /^[0-9]{10,15}$/.test(digitos) ? digitos : null;
}

/** Converte o corpo do webhook em um evento do canal. Nunca lança. */
export function interpretarWebhook(corpo: unknown): EventoCanal {
  // deno-lint-ignore no-explicit-any
  const p = corpo as any;
  if (!p || typeof p !== "object") return { tipo: "ignorar", motivo: "corpo inválido" };
  if (p.event !== "message_created") return { tipo: "ignorar", motivo: "evento não tratado" };
  if (p.private === true) return { tipo: "ignorar", motivo: "nota interna" };

  const entrada = p.message_type === "incoming" || p.message_type === 0;
  const saida = p.message_type === "outgoing" || p.message_type === 1;
  if (!entrada && !saida) return { tipo: "ignorar", motivo: "tipo de mensagem não tratado" };
  // Resposta enviada por pessoa da equipe conta; a enviada por bot (nós) não.
  if (saida && p.sender?.type !== "user") return { tipo: "ignorar", motivo: "saída de bot" };

  const conta = p.account?.id;
  const conversa = p.conversation?.id;
  const id = p.id;
  if (conta == null || conversa == null || id == null) {
    return { tipo: "ignorar", motivo: "identificadores ausentes" };
  }
  return {
    tipo: "mensagem",
    autor: entrada ? "cliente" : "humano",
    conta_externa: String(conta),
    conversa_externa: String(conversa),
    externa_id: String(id),
    contato: entrada
      ? telefone(p.sender?.phone_number) ?? telefone(p.conversation?.meta?.sender?.phone_number)
      : null,
    texto: typeof p.content === "string" ? p.content : "",
    anexos: Array.isArray(p.attachments) ? p.attachments.length : 0,
  };
}

/** O que o worker precisa fazer no canal, qualquer que seja ele. */
export interface ClienteCanal {
  /** Mensagem visível para o cliente. */
  enviar(conversaExterna: string, texto: string): Promise<void>;
  /** Nota visível só para a equipe. */
  notaInterna(conversaExterna: string, texto: string): Promise<void>;
  /** Tira a conversa do bot e a coloca na fila da equipe. */
  transferir(conversaExterna: string): Promise<void>;
}

export interface OpcoesChatwoot {
  base_url: string;
  permite_http: boolean;
  conta_externa: string;
  token: string;
  fetch?: typeof fetch;
}

export function criarClienteChatwoot(o: OpcoesChatwoot): ClienteCanal {
  async function chamar(conversa: string, sufixo: string, corpo: unknown): Promise<void> {
    if (!/^[0-9]+$/.test(conversa)) throw new Error("conversa inválida");
    // A URL base é configurada pelo tenant: mesma proteção dos conectores.
    const url = await validarDestino(
      { base_url: o.base_url, permite_http: o.permite_http, tipo_auth: "nenhuma", auth_config: {} },
      `/api/v1/accounts/${o.conta_externa}/conversations/${conversa}/${sufixo}`,
      new URLSearchParams(),
    );
    const resposta = await (o.fetch ?? fetch)(url, {
      method: "POST",
      headers: { api_access_token: o.token, "content-type": "application/json" },
      body: JSON.stringify(corpo),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    await resposta.body?.cancel();
    if (!resposta.ok) throw new Error(`canal respondeu HTTP ${resposta.status}`);
  }
  return {
    enviar: (c, texto) =>
      chamar(c, "messages", { content: texto, message_type: "outgoing", private: false }),
    notaInterna: (c, texto) =>
      chamar(c, "messages", { content: texto, message_type: "outgoing", private: true }),
    transferir: (c) => chamar(c, "toggle_status", { status: "open" }),
  };
}

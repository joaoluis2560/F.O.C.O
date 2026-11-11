// Chatwoot: leitura do webhook de Agent Bot e envio de respostas pela API.
//
// O formato do webhook, a assinatura e os endpoints seguem a documentação e o
// código-fonte públicos do Chatwoot; ainda não rodaram contra uma instância real.

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

/** Tolerância entre o horário assinado e o relógio do servidor. */
export const JANELA_ASSINATURA_SEG = 300;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Confere a assinatura do webhook do Chatwoot:
 *   X-Chatwoot-Signature = "sha256=" + HMAC-SHA256(segredo, "{timestamp}.{corpo bruto}")
 * O horário assinado precisa estar dentro da janela, o que limita reenvio de
 * uma requisição capturada. Devolve o motivo da recusa, ou null se válida.
 */
export async function verificarAssinatura(
  segredo: string,
  timestamp: string | null,
  assinatura: string | null,
  corpoBruto: string,
  agoraSeg = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  if (!timestamp || !assinatura) return "assinatura ausente";
  if (!/^[0-9]{9,12}$/.test(timestamp)) return "horário inválido";
  if (Math.abs(agoraSeg - Number(timestamp)) > JANELA_ASSINATURA_SEG) {
    return "horário fora da janela";
  }
  const recebida = assinatura.startsWith("sha256=") ? assinatura.slice(7) : "";
  if (!/^[0-9a-f]{64}$/.test(recebida)) return "assinatura malformada";

  const codificador = new TextEncoder();
  const chave = await crypto.subtle.importKey(
    "raw",
    codificador.encode(segredo),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const esperada = hex(
    await crypto.subtle.sign("HMAC", chave, codificador.encode(`${timestamp}.${corpoBruto}`)),
  );
  // Comparação em tempo constante.
  let diferenca = 0;
  for (let i = 0; i < esperada.length; i++) {
    diferenca |= esperada.charCodeAt(i) ^ recebida.charCodeAt(i);
  }
  return diferenca === 0 ? null : "assinatura não confere";
}

/**
 * Falha ao falar com o canal. `nao_entregue` é verdadeiro quando o canal
 * respondeu com erro (a mensagem com certeza não foi aceita) e falso quando a
 * chamada caiu no meio (tempo esgotado, rede): aí não se sabe se chegou.
 */
export class ErroCanal extends Error {
  constructor(mensagem: string, public nao_entregue: boolean) {
    super(mensagem);
    this.name = "ErroCanal";
  }
}

/** O que o worker precisa fazer no canal, qualquer que seja ele. */
export interface ClienteCanal {
  /** Mensagem visível para o cliente. */
  enviar(conversaExterna: string, texto: string): Promise<void>;
  /** Nota visível só para a equipe. */
  notaInterna(conversaExterna: string, texto: string): Promise<void>;
  /** Tira a conversa do bot e a coloca na fila da equipe. */
  transferir(conversaExterna: string): Promise<void>;
  /** Telefone do contato, lido direto do canal. Null se não houver. */
  telefoneDaConversa(conversaExterna: string): Promise<string | null>;
}

export interface OpcoesChatwoot {
  base_url: string;
  permite_http: boolean;
  conta_externa: string;
  token: string;
  fetch?: typeof fetch;
}

export function criarClienteChatwoot(o: OpcoesChatwoot): ClienteCanal {
  async function chamar(
    conversa: string,
    sufixo: string,
    corpo?: unknown,
  ): Promise<Response> {
    if (!/^[0-9]+$/.test(conversa)) throw new ErroCanal("conversa inválida", true);
    // A URL base é configurada pelo tenant: mesma proteção dos conectores.
    const url = await validarDestino(
      { base_url: o.base_url, permite_http: o.permite_http, tipo_auth: "nenhuma", auth_config: {} },
      `/api/v1/accounts/${o.conta_externa}/conversations/${conversa}${sufixo}`,
      new URLSearchParams(),
    );
    let resposta: Response;
    try {
      resposta = await (o.fetch ?? fetch)(url, {
        method: corpo === undefined ? "GET" : "POST",
        headers: { api_access_token: o.token, "content-type": "application/json" },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Caiu no meio: o canal pode ou não ter recebido.
      throw new ErroCanal("falha de rede ao falar com o canal", false);
    }
    if (!resposta.ok) {
      await resposta.body?.cancel();
      throw new ErroCanal(`canal respondeu HTTP ${resposta.status}`, true);
    }
    return resposta;
  }
  const enviarCorpo = async (conversa: string, sufixo: string, corpo: unknown) => {
    await (await chamar(conversa, sufixo, corpo)).body?.cancel();
  };
  return {
    enviar: (c, texto) =>
      enviarCorpo(c, "/messages", { content: texto, message_type: "outgoing", private: false }),
    notaInterna: (c, texto) =>
      enviarCorpo(c, "/messages", { content: texto, message_type: "outgoing", private: true }),
    transferir: (c) => enviarCorpo(c, "/toggle_status", { status: "open" }),
    async telefoneDaConversa(c) {
      const dados = await (await chamar(c, "")).json();
      return telefone(dados?.meta?.sender?.phone_number);
    },
  };
}

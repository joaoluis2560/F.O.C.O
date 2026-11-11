// Cliente de modelo de linguagem. O agente fala com esta interface; a
// implementação real usa o OpenRouter, que dá acesso aos modelos baratos e aos
// da Anthropic pela mesma chave.

export interface FerramentaModelo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChamadaFerramenta {
  id: string;
  nome: string;
  /** JSON em texto, como o modelo produziu. */
  argumentos: string;
}

export type MensagemModelo =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; chamadas?: ChamadaFerramenta[] }
  | { role: "tool"; chamada_id: string; content: string };

export interface Uso {
  tokens_entrada: number;
  tokens_cache: number;
  tokens_saida: number;
  custo_usd: number;
}

export interface RespostaModelo {
  texto: string;
  chamadas: ChamadaFerramenta[];
  uso: Uso;
}

export type ClienteModelo = (pedido: {
  modelo: string;
  mensagens: MensagemModelo[];
  ferramentas: FerramentaModelo[];
}) => Promise<RespostaModelo>;

export const USO_ZERO: Uso = { tokens_entrada: 0, tokens_cache: 0, tokens_saida: 0, custo_usd: 0 };

export function somarUso(a: Uso, b: Uso): Uso {
  return {
    tokens_entrada: a.tokens_entrada + b.tokens_entrada,
    tokens_cache: a.tokens_cache + b.tokens_cache,
    tokens_saida: a.tokens_saida + b.tokens_saida,
    custo_usd: a.custo_usd + b.custo_usd,
  };
}

export interface OpcoesOpenRouter {
  chave: string;
  fetch?: typeof fetch;
  timeout_ms?: number;
  max_tokens?: number;
}

export function criarClienteOpenRouter(o: OpcoesOpenRouter): ClienteModelo {
  return async ({ modelo, mensagens, ferramentas }) => {
    const anthropic = modelo.startsWith("anthropic/");
    const corpo = {
      model: modelo,
      max_tokens: o.max_tokens ?? 1200,
      // Pede o custo real da chamada na resposta.
      usage: { include: true },
      messages: mensagens.map((m) => {
        if (m.role === "tool") {
          return { role: "tool", tool_call_id: m.chamada_id, content: m.content };
        }
        if (m.role === "assistant") {
          return {
            role: "assistant",
            content: m.content,
            ...(m.chamadas?.length && {
              tool_calls: m.chamadas.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.nome, arguments: c.argumentos },
              })),
            }),
          };
        }
        // O prompt de sistema é o prefixo estável: nos modelos da Anthropic ele
        // é marcado para cache, o que barateia as chamadas seguintes.
        if (m.role === "system" && anthropic) {
          return {
            role: "system",
            content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }],
          };
        }
        return { role: m.role, content: m.content };
      }),
      ...(ferramentas.length && {
        tools: ferramentas.map((f) => ({
          type: "function",
          function: { name: f.name, description: f.description, parameters: f.inputSchema },
        })),
      }),
    };

    const resposta = await (o.fetch ?? fetch)("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${o.chave}`, "content-type": "application/json" },
      body: JSON.stringify(corpo),
      signal: AbortSignal.timeout(o.timeout_ms ?? 45_000),
    });
    if (!resposta.ok) {
      await resposta.body?.cancel();
      throw new Error(`modelo respondeu HTTP ${resposta.status}`);
    }
    const dados = await resposta.json();
    const mensagem = dados?.choices?.[0]?.message;
    if (!mensagem) throw new Error("resposta do modelo sem mensagem");
    const uso = dados.usage ?? {};
    return {
      texto: typeof mensagem.content === "string" ? mensagem.content : "",
      chamadas: (mensagem.tool_calls ?? []).map((
        c: { id: string; function: { name: string; arguments: string } },
      ) => ({ id: c.id, nome: c.function.name, argumentos: c.function.arguments ?? "{}" })),
      uso: {
        tokens_entrada: uso.prompt_tokens ?? 0,
        tokens_cache: uso.prompt_tokens_details?.cached_tokens ?? 0,
        tokens_saida: uso.completion_tokens ?? 0,
        custo_usd: typeof uso.cost === "number" ? uso.cost : 0,
      },
    };
  };
}

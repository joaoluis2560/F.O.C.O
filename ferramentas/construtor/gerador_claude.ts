// Gerador de rascunhos com Claude. Roda só na implantação de um tenant, nunca
// no caminho de uma mensagem de cliente.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { DefinicaoConector, Json } from "../../supabase/functions/_shared/conectores/tipos.ts";
import type { Gerador, Proposta } from "./construtor.ts";

const Par = z.object({ nome: z.string(), valor: z.string() });

// Saída estruturada não aceita objetos de chaves livres: query, cabeçalhos e
// por_status vêm como listas e são convertidos em `paraDefinicao`.
const Saida = z.object({
  viavel: z.boolean(),
  motivo: z.string(),
  requisicao: z.object({
    metodo: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    caminho: z.string(),
    query: z.array(Par),
    cabecalhos: z.array(Par),
    corpo_mapeamento: z.string().nullable(),
  }).nullable(),
  resposta: z.object({
    mapeamento: z.string(),
    por_status: z.array(z.object({ status: z.string(), saida_json: z.string() })),
  }).nullable(),
});

export function paraDefinicao(s: z.infer<typeof Saida>): DefinicaoConector | undefined {
  if (!s.requisicao || !s.resposta) return undefined;
  const objeto = (pares: { nome: string; valor: string }[]) =>
    pares.length ? Object.fromEntries(pares.map((p) => [p.nome, p.valor])) : undefined;
  const porStatus = s.resposta.por_status.length
    ? Object.fromEntries(
      s.resposta.por_status.map((p) => [p.status, JSON.parse(p.saida_json) as Json]),
    )
    : undefined;
  return {
    requisicao: {
      metodo: s.requisicao.metodo,
      caminho: s.requisicao.caminho,
      ...(objeto(s.requisicao.query) && { query: objeto(s.requisicao.query) }),
      ...(objeto(s.requisicao.cabecalhos) && { cabecalhos: objeto(s.requisicao.cabecalhos) }),
      ...(s.requisicao.corpo_mapeamento !== null &&
        { corpo_mapeamento: s.requisicao.corpo_mapeamento }),
    },
    resposta: {
      mapeamento: s.resposta.mapeamento,
      ...(porStatus && { por_status: porStatus }),
    },
  };
}

const INSTRUCOES = `Você escreve conectores declarativos que ligam uma capacidade canônica de um
assistente de atendimento à API do sistema de gestão de uma empresa. O conector que você escreve é
revisado por uma pessoa e depois executado por um programa determinístico, sem modelo de linguagem.
Por isso ele precisa estar exato: caminho, parâmetros e mapeamento conforme a especificação
OpenAPI fornecida, sem supor endpoints ou campos que ela não descreve.

Formato do conector:
- requisicao.metodo: capacidade de leitura usa sempre GET; capacidade de escrita nunca usa GET.
- requisicao.caminho: relativo à URL base, começando com "/". Sem query string dentro dele.
- requisicao.query e requisicao.cabecalhos: listas de pares nome/valor em texto.
- requisicao.corpo_mapeamento: expressão JSONata avaliada sobre {"entrada": ..., "contexto": ...}
  que produz o corpo JSON. Use null quando não houver corpo.
- resposta.mapeamento: expressão JSONata avaliada sobre o corpo JSON da resposta. O resultado
  precisa obedecer ao esquema "saida" da capacidade. Dentro dela, $entrada e $contexto também
  estão disponíveis.
- resposta.por_status: saída fixa (JSON em texto) para um status HTTP esperado que não seja
  sucesso, por exemplo 404 em uma busca que não encontrou nada.

Marcadores em caminho, query e cabecalhos: {{entrada.campo}} e {{contexto.cliente_id}}.

Identidade do cliente: quando a capacidade tem identidade "cliente", o identificador vem de
contexto.cliente_id, preenchido pelo servidor a partir do telefone de quem está falando. Ele nunca
vem da entrada, porque a entrada é escolhida pelo modelo de atendimento e um cliente não pode
consultar dados de outro.

Autenticação: é aplicada pelo executor a partir da configuração da integração. Não inclua
Authorization, Cookie, Host nem chaves de API em cabecalhos.

JSONata: uma projeção sobre lista com um único elemento devolve objeto em vez de lista. Onde o
esquema de saída pede lista, envolva a projeção em colchetes: [itens.{ "id": id }]. Campos
ausentes somem do resultado, o que é aceitável para campos opcionais. Converta unidades quando a
API e o esquema diferirem (centavos para reais, por exemplo).

Se a API não oferecer o necessário para a capacidade, responda viavel=false, explique em "motivo"
o que falta e deixe requisicao e resposta como null. Um conector ausente é melhor que um conector
que aproxima a capacidade com o endpoint errado. Quando viavel=true, use "motivo" para registrar
em uma frase qual endpoint foi escolhido e qualquer suposição que a pessoa revisora deva conferir.`;

export interface OpcoesGerador {
  cliente?: Anthropic;
  modelo?: string;
}

export function criarGeradorClaude(opcoes: OpcoesGerador = {}): Gerador {
  // Sem argumentos, o SDK resolve a credencial do ambiente.
  const cliente = opcoes.cliente ?? new Anthropic();
  const modelo = opcoes.modelo ?? "claude-opus-5-5";

  return async (capacidade, openapi, anterior): Promise<Proposta> => {
    let pedido = `Capacidade a implementar:\n${JSON.stringify(capacidade, null, 2)}`;
    if (anterior) {
      pedido += `\n\nA tentativa anterior foi executada contra o ambiente de teste e falhou.\n` +
        `Definição anterior:\n${JSON.stringify(anterior.definicao, null, 2)}\n` +
        `Erro do executor: ${anterior.erro}\n` +
        `Corrija a causa do erro. Se o erro mostrar que a API não cobre a capacidade, ` +
        `responda viavel=false.`;
    }

    const resposta = await cliente.messages.parse({
      model: modelo,
      max_tokens: 16000,
      output_config: { effort: "high", format: zodOutputFormat(Saida) },
      system: [
        { type: "text", text: INSTRUCOES },
        {
          // Prefixo estável entre capacidades: a especificação é lida do cache.
          type: "text",
          text: `Especificação OpenAPI do sistema de gestão:\n${openapi}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: pedido }],
    });

    if (resposta.stop_reason === "refusal") {
      return { viavel: false, motivo: "o modelo recusou o pedido" };
    }
    const saida = resposta.parsed_output;
    if (!saida) {
      return { viavel: false, motivo: `resposta sem saída estruturada (${resposta.stop_reason})` };
    }
    let definicao: DefinicaoConector | undefined;
    try {
      definicao = paraDefinicao(saida);
    } catch {
      return { viavel: false, motivo: "por_status com JSON inválido" };
    }
    return { viavel: saida.viavel && definicao !== undefined, motivo: saida.motivo, definicao };
  };
}

import { assert, assertEquals } from "@std/assert";
import type { ResultadoFerramenta } from "../mcp/servidor.ts";
import { atender } from "./agente.ts";
import { interpretarWebhook } from "./chatwoot.ts";
import { dividir, LIMITE_TURNOS, resumir, TURNOS_MANTIDOS } from "./contexto.ts";
import type { ClienteModelo, MensagemModelo, RespostaModelo } from "./modelo.ts";
import { type ConfigAtendimento, decidirSemModelo } from "./roteador.ts";

const config: ConfigAtendimento = {
  modo: "producao",
  modelo_barato: "teste/barato",
  modelo_forte: "teste/forte",
  teto_diario_usd: 2,
  limite_contato_hora: 30,
  instrucoes: null,
};
const situacao = {
  texto: "oi",
  anexos: 0,
  humano: false,
  gasto_dia_usd: 0,
  mensagens_contato_hora: 1,
};

Deno.test("regras sem modelo", () => {
  assertEquals(decidirSemModelo(situacao, config), null);
  assertEquals(decidirSemModelo({ ...situacao, humano: true }, config)?.motivo, "humano_assumiu");
  assertEquals(
    decidirSemModelo({ ...situacao, mensagens_contato_hora: 31 }, config)?.motivo,
    "limite_do_contato",
  );
  assertEquals(decidirSemModelo({ ...situacao, texto: "  " }, config)?.motivo, "mensagem_vazia");
  const midia = decidirSemModelo({ ...situacao, texto: "", anexos: 1 }, config);
  assertEquals([midia?.acao, midia?.motivo], ["transferir", "midia_nao_suportada"]);
  const teto = decidirSemModelo({ ...situacao, gasto_dia_usd: 2 }, config);
  assertEquals([teto?.acao, teto?.motivo], ["transferir", "teto_diario"]);
  // Humano assumiu vence o teto: não se manda aviso em conversa que já tem gente.
  assertEquals(
    decidirSemModelo({ ...situacao, humano: true, gasto_dia_usd: 9 }, config)?.acao,
    "ignorar",
  );
});

const webhook = (mudancas: Record<string, unknown> = {}) => ({
  event: "message_created",
  id: 501,
  message_type: "incoming",
  content: "Tem tinta branca?",
  private: false,
  account: { id: 7 },
  conversation: { id: 42, meta: { sender: { phone_number: "+55 (11) 99999-0001" } } },
  sender: { type: "contact", phone_number: "+5511999990001" },
  ...mudancas,
});

Deno.test("webhook do Chatwoot: mensagem de cliente", () => {
  assertEquals(interpretarWebhook(webhook()), {
    tipo: "mensagem",
    autor: "cliente",
    conta_externa: "7",
    conversa_externa: "42",
    externa_id: "501",
    contato: "5511999990001",
    texto: "Tem tinta branca?",
    anexos: 0,
  });
});

Deno.test("webhook do Chatwoot: telefone vem da conversa quando falta no remetente", () => {
  const e = interpretarWebhook(webhook({ sender: { type: "contact" } }));
  assert(e.tipo === "mensagem");
  assertEquals(e.contato, "5511999990001");
});

Deno.test("webhook do Chatwoot: resposta de pessoa da equipe conta, de bot não", () => {
  const humano = interpretarWebhook(
    webhook({ message_type: "outgoing", sender: { type: "user" } }),
  );
  assert(humano.tipo === "mensagem");
  assertEquals([humano.autor, humano.contato], ["humano", null]);
  assertEquals(
    interpretarWebhook(webhook({ message_type: "outgoing", sender: { type: "agent_bot" } })).tipo,
    "ignorar",
  );
});

Deno.test("webhook do Chatwoot: o que é ignorado", () => {
  for (
    const corpo of [
      null,
      "texto",
      webhook({ event: "conversation_updated" }),
      webhook({ private: true }),
      webhook({ message_type: "activity" }),
      webhook({ account: undefined }),
      webhook({ conversation: {} }),
    ]
  ) {
    assertEquals(interpretarWebhook(corpo).tipo, "ignorar");
  }
  const anexo = interpretarWebhook(webhook({ content: null, attachments: [{}, {}] }));
  assert(anexo.tipo === "mensagem");
  assertEquals([anexo.texto, anexo.anexos], ["", 2]);
});

// Agente com modelo roteirizado -------------------------------------------------

const uso = { tokens_entrada: 100, tokens_cache: 0, tokens_saida: 20, custo_usd: 0.001 };
const fala = (texto: string): RespostaModelo => ({ texto, chamadas: [], uso });
const chama = (nome: string, args: unknown, id = "c1"): RespostaModelo => ({
  texto: "",
  chamadas: [{ id, nome, argumentos: JSON.stringify(args) }],
  uso,
});

/** Modelo falso: cada modelo tem uma fila de respostas. Registra o que recebeu. */
function roteiro(filas: Record<string, (RespostaModelo | Error)[]>) {
  const pedidos: { modelo: string; mensagens: MensagemModelo[]; ferramentas: string[] }[] = [];
  const modelo: ClienteModelo = ({ modelo, mensagens, ferramentas }) => {
    pedidos.push({
      modelo,
      mensagens: structuredClone(mensagens),
      ferramentas: ferramentas.map((f) => f.name),
    });
    const proxima = filas[modelo]?.shift();
    if (!proxima) return Promise.reject(new Error(`sem resposta roteirizada para ${modelo}`));
    return proxima instanceof Error ? Promise.reject(proxima) : Promise.resolve(proxima);
  };
  return { modelo, pedidos };
}

const ferramentas = [{
  name: "cerebro_buscar",
  description: "busca",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
}];
const ok = (texto: string): ResultadoFerramenta => ({ content: [{ type: "text", text: texto }] });
const erro = (texto: string): ResultadoFerramenta => ({ ...ok(texto), isError: true });

function pedido(
  modelo: ClienteModelo,
  executar = (_n: string, _a: unknown) => Promise.resolve(ok("{}")),
) {
  return { modelo, config, ferramentas, executar, historico: [], texto: "Que horas abre?" };
}

Deno.test("agente: modelo barato consulta e responde; o forte não é chamado", async () => {
  const { modelo, pedidos } = roteiro({
    "teste/barato": [chama("cerebro_buscar", { pergunta: "horário" }), fala("Abrimos às 8h.")],
  });
  const chamadas: string[] = [];
  const r = await atender(pedido(modelo, (nome) => {
    chamadas.push(nome);
    return Promise.resolve(ok('{"fatos":[{"texto":"8h às 18h"}]}'));
  }));
  assertEquals([r.acao, r.texto], ["responder", "Abrimos às 8h."]);
  assertEquals(r.passos.map((p) => [p.nivel, p.modelo, p.resultado]), [[
    1,
    "teste/barato",
    "respondeu",
  ]]);
  assertEquals(r.passos[0].uso.custo_usd, 0.002);
  assertEquals(chamadas, ["cerebro_buscar"]);
  assertEquals(pedidos.every((p) => p.modelo === "teste/barato"), true);
  // O resultado da ferramenta volta ao modelo na segunda rodada.
  assertEquals(pedidos[1].mensagens.at(-1), {
    role: "tool",
    chamada_id: "c1",
    content: '{"fatos":[{"texto":"8h às 18h"}]}',
  });
});

Deno.test("agente: só o nível 1 pode escalar", async () => {
  const { modelo, pedidos } = roteiro({
    "teste/barato": [chama("escalar", { motivo: "regras combinadas" })],
    "teste/forte": [fala("Resposta cuidadosa.")],
  });
  const r = await atender(pedido(modelo));
  assertEquals(r.acao, "responder");
  assertEquals(r.passos.map((p) => [p.nivel, p.resultado]), [[1, "escalou"], [2, "respondeu"]]);
  assertEquals(r.passos[1].motivo, "escalou: regras combinadas");
  assertEquals(pedidos[0].ferramentas.includes("escalar"), true);
  assertEquals(pedidos[1].ferramentas.includes("escalar"), false);
  assertEquals(pedidos[1].ferramentas.includes("transferir_para_humano"), true);
});

Deno.test("agente: dois erros de ferramenta no barato sobem para o forte", async () => {
  const { modelo } = roteiro({
    "teste/barato": [
      chama("cerebro_buscar", {}, "a"),
      chama("cerebro_buscar", {}, "b"),
      fala("nunca chega aqui"),
    ],
    "teste/forte": [fala("Pronto.")],
  });
  const r = await atender(pedido(modelo, () => Promise.resolve(erro("entrada_invalida"))));
  assertEquals(r.passos.map((p) => p.resultado), ["escalou", "respondeu"]);
  assertEquals(r.passos[1].motivo, "escalou: erros_de_ferramenta");
});

Deno.test("agente: falha do barato sobe; falha dos dois transfere", async () => {
  const sobe = roteiro({
    "teste/barato": [new Error("modelo respondeu HTTP 503")],
    "teste/forte": [fala("Oi!")],
  });
  assertEquals((await atender(pedido(sobe.modelo))).passos.map((p) => p.resultado), [
    "falhou",
    "respondeu",
  ]);

  const cai = roteiro({
    "teste/barato": [new Error("timeout")],
    "teste/forte": [new Error("timeout")],
  });
  const r = await atender(pedido(cai.modelo));
  assertEquals(r.acao, "transferir");
  assert(r.motivo.startsWith("agente_falhou"));
});

Deno.test("agente: transferência encerra sem executar mais nada", async () => {
  const { modelo } = roteiro({
    "teste/barato": [chama("transferir_para_humano", { motivo: "cliente quer cancelar" })],
  });
  let executou = false;
  const r = await atender(pedido(modelo, () => {
    executou = true;
    return Promise.resolve(ok("{}"));
  }));
  assertEquals([r.acao, r.motivo], ["transferir", "cliente quer cancelar"]);
  assertEquals(executou, false);
  assertEquals(r.passos.length, 1);
});

Deno.test("agente: laço sem fim é cortado e resposta vazia não vai para o cliente", async () => {
  const laco = roteiro({
    "teste/barato": Array.from({ length: 10 }, (_, i) => chama("cerebro_buscar", {}, `c${i}`)),
    "teste/forte": [fala("   ")],
  });
  const r = await atender(pedido(laco.modelo));
  assertEquals(r.passos.map((p) => p.resultado), ["falhou", "falhou"]);
  assertEquals(r.acao, "transferir");
  assertEquals(laco.pedidos.filter((p) => p.modelo === "teste/barato").length, 6);
});

Deno.test("agente: histórico vira contexto e orientações da empresa entram no prompt", async () => {
  const { modelo, pedidos } = roteiro({ "teste/barato": [fala("Ok.")] });
  await atender({
    ...pedido(modelo),
    config: { ...config, instrucoes: "Trate por você." },
    historico: [{ autor: "cliente", texto: "Oi" }, { autor: "agente", texto: "Olá!" }],
  });
  const m = pedidos[0].mensagens;
  assertEquals(m.map((x) => x.role), ["system", "user", "assistant", "user"]);
  assert(m[0].content.includes("Trate por você."));
  assertEquals(m.at(-1)?.content, "Que horas abre?");
});

// Contexto ----------------------------------------------------------------------

const turnos = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: String(i + 1),
    autor: i % 2 ? "agente" as const : "cliente" as const,
    texto: `turno ${i + 1}`,
  }));

Deno.test("contexto: conversa curta segue inteira; longa separa antigos e recentes", () => {
  const curta = dividir(turnos(LIMITE_TURNOS));
  assertEquals([curta.antigos.length, curta.recentes.length], [0, LIMITE_TURNOS]);

  const longa = dividir(turnos(LIMITE_TURNOS + 1));
  assertEquals(longa.recentes.length, TURNOS_MANTIDOS);
  assertEquals(longa.antigos.length, LIMITE_TURNOS + 1 - TURNOS_MANTIDOS);
  assertEquals(longa.antigos.at(-1)?.id, String(LIMITE_TURNOS + 1 - TURNOS_MANTIDOS));
  assertEquals(longa.recentes.at(-1)?.texto, `turno ${LIMITE_TURNOS + 1}`);
});

Deno.test("contexto: resumo sem ferramentas, levando o resumo anterior", async () => {
  const { modelo, pedidos } = roteiro({ "teste/barato": [fala("  Cliente quer tinta.  ")] });
  const r = await resumir(modelo, "teste/barato", "Cliente se chama Maria.", [
    { autor: "cliente", texto: "tem tinta?" },
    { autor: "humano", texto: "Tem sim." },
  ]);
  assertEquals(r.texto, "Cliente quer tinta.");
  assertEquals(r.uso.custo_usd, 0.001);
  assertEquals(pedidos[0].ferramentas, []);
  const corpo = pedidos[0].mensagens[1].content;
  assert(corpo.includes("Resumo até aqui:\nCliente se chama Maria."));
  assert(corpo.includes("Cliente: tem tinta?\nAtendimento (pessoa): Tem sim."));
});

Deno.test("contexto: resumo vazio é falha, não resumo", async () => {
  const vazio = roteiro({ "teste/barato": [fala("   ")] });
  let mensagem = "";
  try {
    await resumir(vazio.modelo, "teste/barato", null, [{ autor: "cliente", texto: "oi" }]);
  } catch (e) {
    mensagem = (e as Error).message;
  }
  assertEquals(mensagem, "resumo vazio");
});

Deno.test("agente: resumo entra em mensagem própria, depois do prompt estável", async () => {
  const semResumo = roteiro({ "teste/barato": [fala("Ok.")] });
  await atender(pedido(semResumo.modelo));
  const comResumo = roteiro({ "teste/barato": [fala("Ok.")] });
  await atender({ ...pedido(comResumo.modelo), resumo: "Cliente quer tinta branca." });

  const m = comResumo.pedidos[0].mensagens;
  assertEquals(m.map((x) => x.role), ["system", "system", "user"]);
  assert(m[1].content.includes("Cliente quer tinta branca."));
  // O primeiro bloco é idêntico com e sem resumo: continua servindo de prefixo de cache.
  assertEquals(m[0].content, semResumo.pedidos[0].mensagens[0].content);
});

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { type FatoExtraido, LIMITE_MATERIAL, proporDeMaterial } from "./ingestao.ts";
import { pacoteDoSegmento, SEGMENTOS } from "../catalogo/pacotes.ts";
import {
  fatosDoPacote,
  fonteDaPergunta,
  montarPacote,
  type Pacote,
  perguntaDaFonte,
} from "./pacote.ts";
import { DOMINIOS, TIPOS_FATO, VISIBILIDADES } from "./tipos.ts";

const pacote: Pacote = JSON.parse(
  await Deno.readTextFile(new URL("../catalogo/pacotes/base.json", import.meta.url)),
);

Deno.test("pacote base é bem formado", () => {
  const ids = pacote.perguntas.map((p) => p.id);
  assertEquals(new Set(ids).size, ids.length, "ids únicos");
  for (const p of pacote.perguntas) {
    assertEquals((DOMINIOS as readonly string[]).includes(p.dominio), true, p.id);
    assertEquals((TIPOS_FATO as readonly string[]).includes(p.tipo), true, p.id);
    assertEquals((VISIBILIDADES as readonly string[]).includes(p.visibilidade), true, p.id);
    assertEquals(p.id.startsWith(p.dominio + "."), true, p.id);
    assertEquals(p.chaves.every((c) => /^[a-z0-9]+( [a-z0-9]+)*$/.test(c)), true, p.id);
  }
  // Todo domínio de negócio tem ao menos uma pergunta.
  assertEquals(new Set(pacote.perguntas.map((p) => p.dominio)).size, DOMINIOS.length);
});

Deno.test("respostas viram fatos propostos; em branco fica pendente", () => {
  const r = fatosDoPacote(pacote, {
    "operacao.horario": "  Segunda a sexta, 8h às 18h.  ",
    "vendas.desconto": "Até 5% sem consultar.",
    "vendas.troca": "   ",
    "marketing.tom": "Tratar por você, sem emoji.",
    "clientes.reclamacao": "Reclamação vai direto para a gerência.",
  });
  assertEquals(r.fatos.length, 2);
  // Tom e regra de transferência não viram fato: viram orientação do atendimento.
  assertEquals(r.orientacoes, [
    {
      categoria: "transferir",
      texto: "Reclamação vai direto para a gerência.",
      fonte: "pacote:base@3#clientes.reclamacao",
    },
    {
      categoria: "tom",
      texto: "Tratar por você, sem emoji.",
      fonte: "pacote:base@3#marketing.tom",
    },
  ]);
  assertEquals(r.fatos[0], {
    dominio: "operacao",
    tipo: "informacao",
    titulo: "Horário de atendimento",
    texto: "Segunda a sexta, 8h às 18h.",
    visibilidade: "publico",
    chaves: pacote.perguntas.find((p) => p.id === "operacao.horario")!.chaves,
    fonte: "pacote:base@3#operacao.horario",
  });
  assertEquals(r.fatos[1].visibilidade, "interno");
  assertEquals(r.pendentes.includes("vendas.troca"), true);
  assertEquals(r.pendentes.length, pacote.perguntas.length - 4);
});

Deno.test("resposta para pergunta inexistente ou longa demais é erro", () => {
  assertThrows(() => fatosDoPacote(pacote, { "vendas.inexistente": "x" }), Error, "inexistentes");
  assertThrows(
    () => fatosDoPacote(pacote, { "operacao.horario": "x".repeat(4001) }),
    Error,
    "divida em partes",
  );
});

const extraido = (mudancas: Partial<FatoExtraido> = {}): FatoExtraido => ({
  dominio: "vendas",
  tipo: "regra",
  titulo: "Política de troca",
  texto: "Trocas em até 30 dias com nota fiscal.",
  chaves: ["troca", "devolucao"],
  ...mudancas,
});

Deno.test("material vira fatos internos, com a fonte registrada", async () => {
  const r = await proporDeMaterial(
    "Manual da loja",
    "conteúdo",
    () => Promise.resolve([extraido()]),
  );
  assertEquals(r.descartados, []);
  assertEquals(r.fatos, [{
    dominio: "vendas",
    tipo: "regra",
    titulo: "Política de troca",
    texto: "Trocas em até 30 dias com nota fiscal.",
    visibilidade: "interno",
    chaves: ["troca", "devolucao"],
    fonte: "material:Manual da loja",
  }]);
});

Deno.test("itens inválidos do extrator são descartados com motivo", async () => {
  const r = await proporDeMaterial("Manual", "conteúdo", () =>
    Promise.resolve([
      extraido(),
      extraido({ titulo: "política de troca" }),
      extraido({ titulo: "Sem texto", texto: "  " }),
      extraido({ titulo: "Domínio errado", dominio: "juridico" }),
      extraido({ titulo: "Tipo errado", tipo: "segredo" }),
      extraido({ titulo: "Longo", texto: "x".repeat(4001) }),
    ]));
  assertEquals(r.fatos.length, 1);
  assertEquals(r.descartados.map((d) => d.motivo), [
    "título repetido",
    "título ou texto vazio",
    "domínio desconhecido: juridico",
    "tipo desconhecido: segredo",
    "texto longo demais",
  ]);
});

Deno.test("material vazio ou grande demais é recusado sem chamar o extrator", async () => {
  let chamadas = 0;
  const extrair = () => {
    chamadas++;
    return Promise.resolve([]);
  };
  await assertRejects(() => proporDeMaterial("x", "   ", extrair), Error, "vazio");
  await assertRejects(
    () => proporDeMaterial("x", "a".repeat(LIMITE_MATERIAL + 1), extrair),
    Error,
    "divida em partes",
  );
  assertEquals(chamadas, 0);
});

// Pacotes de nicho -------------------------------------------------------------

const capacidades: string[] = JSON.parse(
  await Deno.readTextFile(new URL("../catalogo/capacidades.json", import.meta.url)),
).capacidades.map((c: { nome: string }) => c.nome);

Deno.test("segmentos com pacote próprio: ótica e supermercado", () => {
  assertEquals(SEGMENTOS.map((s) => s.segmento).sort(), ["otica", "supermercado"]);
});

for (const { segmento } of SEGMENTOS) {
  Deno.test(`pacote de ${segmento} é bem formado e estende a base`, () => {
    const p = pacoteDoSegmento(segmento);
    const ids = p.perguntas.map((q) => q.id);
    assertEquals(new Set(ids).size, ids.length, "ids de pergunta únicos");
    assertEquals(p.segmento, segmento);
    // As perguntas do nicho vêm antes das da base.
    assertEquals(ids[0].startsWith(`${segmento}.`), true);
    assertEquals(ids.some((id) => id === "operacao.horario"), true, "mantém perguntas da base");
    for (const q of p.perguntas) {
      assertEquals((DOMINIOS as readonly string[]).includes(q.dominio), true, q.id);
      assertEquals((TIPOS_FATO as readonly string[]).includes(q.tipo), true, q.id);
      assertEquals(q.chaves.every((c) => /^[a-z0-9]+( [a-z0-9]+)*$/.test(c)), true, q.id);
      assertEquals(q.pergunta.trim().endsWith("?"), true, q.id);
    }
    const sugeridas = p.orientacoes_padrao ?? [];
    assertEquals(sugeridas.length > 0, true);
    for (const o of sugeridas) {
      assertEquals(["tom", "limite", "transferir"].includes(o.categoria), true, o.id);
      assertEquals(o.texto.length >= 3 && o.texto.length <= 600, true, o.id);
      assertEquals(ids.includes(o.id), false, "id de orientação não colide com pergunta");
    }
    assertEquals(new Set(sugeridas.map((o) => o.id)).size, sugeridas.length);
    for (const c of p.capacidades ?? []) assertEquals(capacidades.includes(c), true, c);
  });
}

Deno.test("segmento desconhecido ou ausente usa o pacote base", () => {
  assertEquals(pacoteDoSegmento("petshop").nome, "base");
  assertEquals(pacoteDoSegmento(null).perguntas.length, pacote.perguntas.length);
});

Deno.test("supermercado omite a pergunta de orçamento da base", () => {
  const ids = pacoteDoSegmento("supermercado").perguntas.map((q) => q.id);
  assertEquals(ids.includes("vendas.orcamento"), false);
  assertEquals(pacoteDoSegmento("otica").perguntas.some((q) => q.id === "vendas.orcamento"), true);
});

Deno.test("montarPacote recusa nicho inconsistente com a base", () => {
  const nicho = {
    versao: 1,
    nome: "x",
    segmento: "x",
    rotulo: "X",
    estende: "base",
    descricao: "",
    omitir: [] as string[],
    capacidades: [] as string[],
    perguntas: [] as Pacote["perguntas"],
    orientacoes_padrao: [],
  };
  assertThrows(() => montarPacote(pacote, { ...nicho, estende: "outra" }), Error, "estende");
  assertThrows(
    () => montarPacote(pacote, { ...nicho, omitir: ["nao.existe"] }),
    Error,
    "inexistentes",
  );
  assertThrows(
    () => montarPacote(pacote, { ...nicho, perguntas: [pacote.perguntas[0]] }),
    Error,
    "repete",
  );
});

Deno.test("marca de origem de pergunta vai e volta", () => {
  const p = pacoteDoSegmento("otica");
  const fonte = fonteDaPergunta(p, "otica.prazo");
  assertEquals(fonte, `pacote:otica@${p.versao}#otica.prazo`);
  assertEquals(perguntaDaFonte(fonte), "otica.prazo");
  assertEquals(perguntaDaFonte("material:Manual"), null);
  assertEquals(perguntaDaFonte(null), null);
});

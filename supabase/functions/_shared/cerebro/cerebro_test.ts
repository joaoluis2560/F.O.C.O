import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { type FatoExtraido, LIMITE_MATERIAL, proporDeMaterial } from "./ingestao.ts";
import { fatosDoPacote, type Pacote } from "./pacote.ts";
import { DOMINIOS, TIPOS_FATO, VISIBILIDADES } from "./tipos.ts";

const pacote: Pacote = JSON.parse(
  await Deno.readTextFile(new URL("../../../../catalogo/pacotes/base.json", import.meta.url)),
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
  });
  assertEquals(r.fatos.length, 2);
  assertEquals(r.fatos[0], {
    dominio: "operacao",
    tipo: "informacao",
    titulo: "Horário de atendimento",
    texto: "Segunda a sexta, 8h às 18h.",
    visibilidade: "publico",
    chaves: ["horario", "funcionamento", "aberto", "feriado"],
    fonte: "pacote:base@1#operacao.horario",
  });
  assertEquals(r.fatos[1].visibilidade, "interno");
  assertEquals(r.pendentes.includes("vendas.troca"), true);
  assertEquals(r.pendentes.length, pacote.perguntas.length - 2);
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

import { assert, assertEquals } from "@std/assert";
import { carregarCatalogo, carregarConector, subirErp } from "./apoio_teste.ts";
import { executarConector, hashDefinicao, indicaDegradacao } from "./executor.ts";
import type { Capacidade, DefinicaoConector, Integracao, Json, Resultado } from "./tipos.ts";

const catalogo = await carregarCatalogo();
const cap = (nome: string): Capacidade => catalogo.get(nome)!;

function saida(r: Resultado): Json {
  if (!r.ok) throw new Error(`esperava sucesso, veio ${r.erro.codigo}: ${r.erro.mensagem}`);
  return r.saida;
}
function codigo(r: Resultado): string {
  if (r.ok) throw new Error("esperava erro, veio sucesso");
  return r.erro.codigo;
}

Deno.test("conectores de referência contra o ERP simulado", async (t) => {
  const { erp, integracao, segredo, parar } = subirErp();
  const rodar = async (
    nome: string,
    entrada: Json,
    contexto: { cliente_id?: string } = {},
    extra: { aprovado?: boolean; chave_idempotencia?: string } = {},
  ) =>
    executarConector({
      capacidade: cap(nome),
      integracao,
      definicao: await carregarConector(nome),
      entrada,
      contexto,
      segredo,
      ...extra,
    });

  try {
    await t.step("clientes.identificar encontra pelo telefone", async () => {
      assertEquals(saida(await rodar("clientes.identificar", { telefone: "5511999990001" })), {
        encontrado: true,
        cliente_id: "C-100",
        nome: "Maria Souza",
      });
    });

    await t.step("clientes.identificar devolve encontrado=false", async () => {
      assertEquals(saida(await rodar("clientes.identificar", { telefone: "5500000000000" })), {
        encontrado: false,
      });
    });

    await t.step("produtos.consultar converte centavos e mantém lista", async () => {
      assertEquals(saida(await rodar("produtos.consultar", { termo: "parafusadeira" })), {
        itens: [{ produto_id: "P-2", nome: "Parafusadeira 12V", preco: 349.9, unidade: "un" }],
      });
      assertEquals(saida(await rodar("produtos.consultar", { termo: "inexistente" })), {
        itens: [],
      });
    });

    await t.step("estoque.consultar calcula disponível", async () => {
      assertEquals(saida(await rodar("estoque.consultar", { produto_id: "P-2" })), {
        produto_id: "P-2",
        disponivel: 5,
      });
    });

    await t.step("estoque.consultar de produto inexistente vira http_erro", async () => {
      const r = await rodar("estoque.consultar", { produto_id: "X-9" });
      assertEquals(codigo(r), "http_erro");
      assertEquals(r.status_http, 404);
    });

    await t.step("pedidos.status usa o cliente do contexto", async () => {
      assertEquals(saida(await rodar("pedidos.status", {}, { cliente_id: "C-100" })), {
        pedidos: [{ pedido_id: "PED-1001", situacao: "shipped", total: 352.9, data: "2026-11-03" }],
      });
    });

    await t.step("financeiro.titulos_em_aberto só traz títulos do cliente", async () => {
      const r = saida(
        await rodar("financeiro.titulos_em_aberto", {}, { cliente_id: "C-200" }),
      ) as { titulos: { titulo_id: string }[] };
      assertEquals(r.titulos.map((x) => x.titulo_id), ["T-3"]);
    });

    await t.step("capacidade com identidade recusa contexto sem cliente", async () => {
      assertEquals(codigo(await rodar("pedidos.status", {})), "identidade_ausente");
    });

    await t.step("modelo não consegue informar cliente pela entrada", async () => {
      const r = await rodar("pedidos.status", { cliente_id: "C-200" }, { cliente_id: "C-100" });
      assertEquals(codigo(r), "entrada_invalida");
    });

    await t.step("escrita sem aprovação não chega ao ERP", async () => {
      const antes = erp.pedidos.length;
      const itens = [{ produto_id: "P-1", quantidade: 10 }];
      const r = await rodar("pedidos.criar", { itens }, { cliente_id: "C-100" });
      assertEquals(codigo(r), "aprovacao_ausente");
      assertEquals(erp.pedidos.length, antes);
    });

    await t.step("escrita aprovada cria pedido e é idempotente", async () => {
      const antes = erp.pedidos.length;
      const itens = [{ produto_id: "P-1", quantidade: 10 }];
      const extra = { aprovado: true, chave_idempotencia: "proposta-1" };
      const r1 = saida(await rodar("pedidos.criar", { itens }, { cliente_id: "C-100" }, extra));
      const r2 = saida(await rodar("pedidos.criar", { itens }, { cliente_id: "C-100" }, extra));
      assertEquals(r1, { pedido_id: "PED-1003", situacao: "pending", total: 15 });
      assertEquals(r2, r1);
      assertEquals(erp.pedidos.length, antes + 1);
    });

    await t.step("entrada fora do esquema é recusada", async () => {
      assertEquals(codigo(await rodar("produtos.consultar", { termo: "a" })), "entrada_invalida");
      assertEquals(
        codigo(await rodar("clientes.identificar", { telefone: "11 99999-0001" })),
        "entrada_invalida",
      );
    });

    await t.step("valor de caminho não escapa do segmento", async () => {
      const r = await rodar("estoque.consultar", { produto_id: "../customers" });
      assertEquals(codigo(r), "http_erro");
      assertEquals(
        codigo(await rodar("estoque.consultar", { produto_id: ".." })),
        "entrada_invalida",
      );
    });

    await t.step("segredo errado vira http_erro sem vazar o segredo", async () => {
      const r = await executarConector({
        capacidade: cap("produtos.consultar"),
        integracao,
        definicao: await carregarConector("produtos.consultar"),
        entrada: { termo: "tinta" },
        contexto: {},
        segredo: "segredo-errado-123",
      });
      assertEquals(codigo(r), "http_erro");
      assert(!JSON.stringify(r).includes("segredo-errado-123"));
    });
  } finally {
    await parar();
  }
});

// Daqui para baixo: fetch falso, sem rede. -------------------------------------

const integracaoHttps: Integracao = {
  base_url: "https://erp.example/base",
  permite_http: false,
  tipo_auth: "nenhuma",
  auth_config: {},
};
const dnsPublico = () => Promise.resolve(["203.0.113.10"]);
const definicaoProdutos: DefinicaoConector = {
  requisicao: { metodo: "GET", caminho: "/produtos", query: { q: "{{entrada.termo}}" } },
  resposta: {
    mapeamento: '{ "itens": [items.{ "produto_id": id, "nome": nome, "preco": preco }] }',
  },
};

function rodarFalso(
  responder: (url: URL, init: RequestInit) => Response | Promise<Response>,
  mudancas: Partial<Parameters<typeof executarConector>[0]> = {},
) {
  const chamadas: URL[] = [];
  const promessa = executarConector({
    capacidade: cap("produtos.consultar"),
    integracao: integracaoHttps,
    definicao: definicaoProdutos,
    entrada: { termo: "tinta" },
    contexto: {},
    opcoes: {
      resolver_dns: dnsPublico,
      fetch: ((url: URL, init: RequestInit) => {
        chamadas.push(url);
        return Promise.resolve(responder(url, init));
      }) as unknown as typeof fetch,
    },
    ...mudancas,
  });
  return { promessa, chamadas };
}

Deno.test("monta a URL dentro da base e codifica a query", async () => {
  const { promessa, chamadas } = rodarFalso(() => Response.json({ items: [] }), {
    entrada: { termo: "tinta & verniz" },
  });
  assertEquals(saida(await promessa), { itens: [] });
  assertEquals(chamadas[0].href, "https://erp.example/base/produtos?q=tinta+%26+verniz");
});

Deno.test("resposta fora do esquema canônico indica degradação", async () => {
  const { promessa } = rodarFalso(() => Response.json({ items: [{ id: 1, nome: "x" }] }));
  const r = await promessa;
  assertEquals(codigo(r), "saida_invalida");
  assert(indicaDegradacao(r));
});

Deno.test("resposta que não é JSON indica degradação", async () => {
  const { promessa } = rodarFalso(() => new Response("<html>manutenção</html>"));
  const r = await promessa;
  assertEquals(codigo(r), "resposta_invalida");
  assert(indicaDegradacao(r));
});

Deno.test("redirecionamento não é seguido", async () => {
  const { promessa, chamadas } = rodarFalso(() =>
    new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } })
  );
  const r = await promessa;
  assertEquals(codigo(r), "http_erro");
  assertEquals(chamadas.length, 1);
  assert(!indicaDegradacao(r));
});

Deno.test("resposta maior que o limite é cortada", async () => {
  const { promessa } = rodarFalso(() => new Response("x".repeat(5000)), {
    opcoes: {
      resolver_dns: dnsPublico,
      max_bytes: 1000,
      fetch: (() => Promise.resolve(new Response("x".repeat(5000)))) as unknown as typeof fetch,
    },
  });
  assertEquals(codigo(await promessa), "resposta_grande");
});

Deno.test("tempo esgotado", async () => {
  const lento = ((_: URL, init: RequestInit) =>
    new Promise<Response>((_, rejeitar) => {
      init.signal!.addEventListener("abort", () => rejeitar(init.signal!.reason));
    })) as unknown as typeof fetch;
  const r = await executarConector({
    capacidade: cap("produtos.consultar"),
    integracao: integracaoHttps,
    definicao: definicaoProdutos,
    entrada: { termo: "tinta" },
    contexto: {},
    opcoes: { resolver_dns: dnsPublico, timeout_ms: 30, fetch: lento },
  });
  assertEquals(codigo(r), "tempo_esgotado");
});

Deno.test("por_status devolve saída fixa", async () => {
  const { promessa } = rodarFalso(() => new Response("nada", { status: 404 }), {
    capacidade: cap("clientes.identificar"),
    entrada: { telefone: "5511999990001" },
    definicao: {
      requisicao: { metodo: "GET", caminho: "/clientes/{{entrada.telefone}}" },
      resposta: {
        mapeamento: '{ "encontrado": true, "cliente_id": id }',
        por_status: { "404": { encontrado: false } },
      },
    },
  });
  assertEquals(saida(await promessa), { encontrado: false });
});

Deno.test("definições inválidas são recusadas antes de qualquer chamada", async () => {
  const casos: DefinicaoConector[] = [
    { ...definicaoProdutos, requisicao: { metodo: "POST", caminho: "/produtos" } },
    { ...definicaoProdutos, requisicao: { metodo: "GET", caminho: "produtos" } },
    {
      ...definicaoProdutos,
      requisicao: { metodo: "GET", caminho: "/p", cabecalhos: { Authorization: "Bearer x" } },
    },
    { ...definicaoProdutos, resposta: { mapeamento: "{ invalido" } },
  ];
  for (const definicao of casos) {
    const { promessa, chamadas } = rodarFalso(() => Response.json({}), { definicao });
    assertEquals(codigo(await promessa), "definicao_invalida");
    assertEquals(chamadas.length, 0);
  }
});

Deno.test("hash da definição ignora a ordem das chaves", async () => {
  const a = await hashDefinicao(definicaoProdutos);
  const b = await hashDefinicao({
    resposta: definicaoProdutos.resposta,
    requisicao: { query: { q: "{{entrada.termo}}" }, caminho: "/produtos", metodo: "GET" },
  });
  assertEquals(a, b);
  assertEquals(a.length, 64);
});

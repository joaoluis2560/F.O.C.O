import { assertEquals } from "@std/assert";
import {
  carregarCatalogo,
  carregarConector,
  subirErp,
} from "../../supabase/functions/_shared/conectores/apoio_teste.ts";
import { construir, type Exemplo, type Gerador } from "./construtor.ts";
import { paraDefinicao } from "./gerador_claude.ts";

const catalogo = await carregarCatalogo();
const capacidades = [...catalogo.values()];
const exemplos: Record<string, Exemplo> = JSON.parse(
  await Deno.readTextFile(new URL("../erp-simulado/exemplos.json", import.meta.url)),
);
const openapi = await Deno.readTextFile(new URL("../erp-simulado/openapi.json", import.meta.url));

/** Dublê do gerador: devolve os conectores de referência, sem chamar modelo. */
const geradorDeReferencia: Gerador = async (cap) => ({
  viavel: true,
  motivo: "referência",
  definicao: await carregarConector(cap.nome),
});

Deno.test("rascunhos corretos passam no sandbox; escrita fica sem executar", async () => {
  const { erp, integracao, segredo, parar } = subirErp();
  try {
    const antes = erp.pedidos.length;
    const r = await construir({
      capacidades,
      openapi,
      integracao,
      segredo,
      exemplos,
      gerar: geradorDeReferencia,
    });
    assertEquals(
      Object.fromEntries(r.map((x) => [x.capacidade, x.estado])),
      {
        "clientes.identificar": "testado",
        "produtos.consultar": "testado",
        "estoque.consultar": "testado",
        "pedidos.status": "testado",
        "financeiro.titulos_em_aberto": "testado",
        "pedidos.criar": "nao_testado",
      },
    );
    assertEquals(erp.pedidos.length, antes);
    assertEquals(r.every((x) => x.hash?.length === 64), true);
  } finally {
    await parar();
  }
});

Deno.test("escrita só roda no sandbox com testar_escrita", async () => {
  const { erp, integracao, segredo, parar } = subirErp();
  try {
    const antes = erp.pedidos.length;
    const [r] = await construir({
      capacidades: [catalogo.get("pedidos.criar")!],
      openapi,
      integracao,
      segredo,
      exemplos,
      gerar: geradorDeReferencia,
      testar_escrita: true,
    });
    assertEquals(r.estado, "testado");
    assertEquals(erp.pedidos.length, antes + 1);
  } finally {
    await parar();
  }
});

Deno.test("erro do sandbox volta ao gerador e a segunda tentativa corrige", async () => {
  const { integracao, segredo, parar } = subirErp();
  const errosRecebidos: (string | undefined)[] = [];
  const gerar: Gerador = async (cap, _openapi, anterior) => {
    errosRecebidos.push(anterior?.erro);
    const certo = await carregarConector(cap.nome);
    return anterior ? { viavel: true, motivo: "corrigido", definicao: certo } : {
      viavel: true,
      motivo: "primeira",
      // Campo errado: a saída fica sem "disponivel" e reprova no esquema.
      definicao: { ...certo, resposta: { mapeamento: '{ "produto_id": sku, "qtd": on_hand }' } },
    };
  };
  try {
    const [r] = await construir({
      capacidades: [catalogo.get("estoque.consultar")!],
      openapi,
      integracao,
      segredo,
      exemplos,
      gerar,
    });
    assertEquals(r.estado, "testado");
    assertEquals(r.tentativas, 2);
    assertEquals(errosRecebidos[0], undefined);
    assertEquals(errosRecebidos[1]?.startsWith("saida_invalida"), true);
  } finally {
    await parar();
  }
});

Deno.test("rascunho que nunca passa termina como falhou", async () => {
  const { integracao, segredo, parar } = subirErp();
  try {
    const [r] = await construir({
      capacidades: [catalogo.get("produtos.consultar")!],
      openapi,
      integracao,
      segredo,
      exemplos,
      gerar: () =>
        Promise.resolve({
          viavel: true,
          motivo: "endpoint inventado",
          definicao: {
            requisicao: { metodo: "GET", caminho: "/api/v1/nao-existe" },
            resposta: { mapeamento: '{ "itens": [] }' },
          },
        }),
    });
    assertEquals(r.estado, "falhou");
    assertEquals(r.tentativas, 2);
    assertEquals(r.motivo.startsWith("http_erro"), true);
    assertEquals(r.hash, undefined);
  } finally {
    await parar();
  }
});

Deno.test("definição com forma inválida não chega a ser executada", async () => {
  const { integracao, segredo, parar } = subirErp();
  try {
    const [r] = await construir({
      capacidades: [catalogo.get("produtos.consultar")!],
      openapi,
      integracao,
      segredo,
      exemplos,
      max_tentativas: 1,
      gerar: () =>
        Promise.resolve({
          viavel: true,
          motivo: "leitura com POST",
          definicao: {
            requisicao: { metodo: "POST", caminho: "/api/v1/products" },
            resposta: { mapeamento: "$" },
          },
        }),
    });
    assertEquals(r.estado, "falhou");
    assertEquals(r.motivo.startsWith("definicao_invalida"), true);
  } finally {
    await parar();
  }
});

Deno.test("capacidade sem cobertura na API vira inviavel", async () => {
  const { integracao, segredo, parar } = subirErp();
  try {
    const [r] = await construir({
      capacidades: [catalogo.get("estoque.consultar")!],
      openapi,
      integracao,
      segredo,
      exemplos,
      gerar: () => Promise.resolve({ viavel: false, motivo: "API sem endpoint de estoque" }),
    });
    assertEquals(r, {
      capacidade: "estoque.consultar",
      tipo: "leitura",
      estado: "inviavel",
      tentativas: 1,
      motivo: "API sem endpoint de estoque",
    });
  } finally {
    await parar();
  }
});

Deno.test("saída estruturada do modelo vira definição de conector", () => {
  assertEquals(
    paraDefinicao({
      viavel: true,
      motivo: "",
      requisicao: {
        metodo: "GET",
        caminho: "/clientes/{{entrada.telefone}}",
        query: [{ nome: "ativo", valor: "true" }],
        cabecalhos: [],
        corpo_mapeamento: null,
      },
      resposta: {
        mapeamento: '{ "encontrado": true }',
        por_status: [{ status: "404", saida_json: '{"encontrado": false}' }],
      },
    }),
    {
      requisicao: {
        metodo: "GET",
        caminho: "/clientes/{{entrada.telefone}}",
        query: { ativo: "true" },
      },
      resposta: {
        mapeamento: '{ "encontrado": true }',
        por_status: { "404": { encontrado: false } },
      },
    },
  );
  assertEquals(
    paraDefinicao({ viavel: false, motivo: "x", requisicao: null, resposta: null }),
    undefined,
  );
});

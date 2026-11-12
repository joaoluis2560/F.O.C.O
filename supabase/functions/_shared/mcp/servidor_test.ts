import { assert, assertEquals } from "@std/assert";
import { carregarCatalogo, carregarConector, subirErp } from "../conectores/apoio_teste.ts";
import type { Catalogo, Integracao } from "../conectores/tipos.ts";
import {
  type ConectorAtivo,
  type Credencial,
  FilaDeRevisaoCheia,
  type Repositorio,
} from "./repositorio.ts";
import { executarFerramenta, ferramentasDe, MAX_CORPO, tratarMcp } from "./servidor.ts";
import { gerarTokenSessao } from "./sessao.ts";

const mapa = await carregarCatalogo();
const catalogo: Catalogo = { versao: 1, capacidades: [...mapa.values()] };

async function sha256Hex(texto: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TOKEN_ATENDIMENTO = "foco_teste_atendimento";
const TOKEN_EQUIPE = "foco_teste_equipe";

/** Repositório em memória para um tenant com todos os conectores de referência. */
async function repoFalso(integracao: Integracao, segredo: string) {
  const credenciais = new Map<string, Credencial>([
    [await sha256Hex(TOKEN_ATENDIMENTO), {
      credencial_id: "c1",
      tenant_id: "tenant-a",
      perfil: "atendimento",
    }],
    [await sha256Hex(TOKEN_EQUIPE), {
      credencial_id: "c2",
      tenant_id: "tenant-a",
      perfil: "equipe",
    }],
  ]);
  const conectores: ConectorAtivo[] = [];
  for (const cap of catalogo.capacidades) {
    conectores.push({
      conector_id: `con-${cap.nome}`,
      capacidade: cap.nome,
      definicao: await carregarConector(cap.nome),
      integracao_id: "int-1",
      integracao,
    });
  }
  const execucoes: { capacidade: string; ok: boolean }[] = [];
  const buscas: { perfil: string; pergunta: string }[] = [];
  /** Sessões abertas "pela entrada do canal": hash do token -> tenant e telefone. */
  const sessoes = new Map<string, { tenant: string; contato: string }>();
  const abrirSessao = async (contato: string, tenant = "tenant-a") => {
    const { token, hash } = await gerarTokenSessao();
    sessoes.set(hash, { tenant, contato });
    return token;
  };
  const propostas: { tipo: string; tenant: string; dados: unknown }[] = [];
  const implantacao: { segmento: string | null; respondidas: string[] } = {
    segmento: null,
    respondidas: [],
  };
  let filaCheia = false;
  const repo: Repositorio = {
    proporFato: (tenant, fato) => {
      if (filaCheia) return Promise.reject(new FilaDeRevisaoCheia());
      propostas.push({ tipo: "fato", tenant, dados: fato });
      return Promise.resolve();
    },
    proporOrientacao: (tenant, categoria, texto, justificativa) => {
      if (filaCheia) return Promise.reject(new FilaDeRevisaoCheia());
      propostas.push({ tipo: "orientacao", tenant, dados: { categoria, texto, justificativa } });
      return Promise.resolve();
    },
    propostasPendentes: () => Promise.resolve({ total: propostas.length, itens: [] }),
    implantacao: () => Promise.resolve(implantacao),
    ignorarPergunta: (_tenant, id) => {
      implantacao.respondidas.push(`pacote:ignorada#${id}`);
      return Promise.resolve();
    },
    identificarCredencial: (hash) => Promise.resolve(credenciais.get(hash) ?? null),
    contatoDaSessao: (tenant, hash) => {
      const sessao = sessoes.get(hash);
      return Promise.resolve(sessao && sessao.tenant === tenant ? sessao.contato : null);
    },
    conectoresAprovados: (tenant) => Promise.resolve(tenant === "tenant-a" ? conectores : []),
    lerSegredo: () => Promise.resolve(segredo),
    registrarExecucao: (_t, _c, capacidade, r) => {
      execucoes.push({ capacidade, ok: r.ok });
      return Promise.resolve();
    },
    buscarFatos: (_t, perfil, pergunta) => {
      buscas.push({ perfil, pergunta });
      return Promise.resolve([{
        dominio: "operacao",
        tipo: "informacao",
        titulo: "Horário",
        texto: "8h às 18h",
      }]);
    },
  };
  return {
    repo,
    execucoes,
    buscas,
    abrirSessao,
    propostas,
    implantacao,
    encherFila: (cheia: boolean) => (filaCheia = cheia),
  };
}

interface Opcoes {
  token?: string | null;
  /** Token de sessão, enviado em x-foco-sessao. */
  sessao?: string;
  /** Telefone no cabeçalho antigo, que o servidor deve recusar. */
  contatoLegado?: string;
  metodoHttp?: string;
}

function cliente(repo: Repositorio) {
  let id = 0;
  return async (method: string, params?: unknown, o: Opcoes = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (o.token !== null) headers.authorization = `Bearer ${o.token ?? TOKEN_ATENDIMENTO}`;
    if (o.sessao) headers["x-foco-sessao"] = o.sessao;
    if (o.contatoLegado) headers["x-foco-contato"] = o.contatoLegado;
    const metodoHttp = o.metodoHttp ?? "POST";
    const resposta = await tratarMcp(
      new Request("http://local/mcp", {
        method: metodoHttp,
        headers,
        body: metodoHttp === "POST"
          ? JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
          : undefined,
      }),
      { repo, catalogo },
    );
    const corpo = resposta.status === 202 ? null : await resposta.json();
    return { status: resposta.status, corpo };
  };
}

// deno-lint-ignore no-explicit-any
const conteudo = (corpo: any) => JSON.parse(corpo.result.content[0].text);
// deno-lint-ignore no-explicit-any
const nomes = (corpo: any): string[] => corpo.result.tools.map((t: { name: string }) => t.name);

Deno.test("servidor MCP", async (t) => {
  const { erp, integracao, segredo, parar } = subirErp();
  const { repo, execucoes, buscas, abrirSessao, propostas, implantacao, encherFila } =
    await repoFalso(
      integracao,
      segredo,
    );
  const rpc = cliente(repo);
  const MARIA = await abrirSessao("5511999990001");
  const JOAO = await abrirSessao("5511999990002");
  const TELEFONE_JOAO = "5511999990002";

  try {
    await t.step("sem token ou com token errado: 401", async () => {
      assertEquals((await rpc("tools/list", {}, { token: null })).status, 401);
      assertEquals((await rpc("tools/list", {}, { token: "foco_invalido" })).status, 401);
    });

    await t.step("só POST", async () => {
      assertEquals((await rpc("ping", {}, { metodoHttp: "GET" })).status, 405);
    });

    await t.step("initialize negocia versão e devolve instruções do perfil", async () => {
      const r = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
      assertEquals(r.corpo.result.protocolVersion, "2025-03-26");
      assertEquals(r.corpo.result.capabilities, { tools: {} });
      assert(r.corpo.result.instructions.includes("cliente final"));
      const outra = await rpc("initialize", { protocolVersion: "1999-01-01" });
      assertEquals(outra.corpo.result.protocolVersion, "2025-06-18");
    });

    await t.step("notificação não tem resposta; método desconhecido dá erro", async () => {
      const resposta = await tratarMcp(
        new Request("http://local/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN_ATENDIMENTO}` },
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        }),
        { repo, catalogo },
      );
      assertEquals(resposta.status, 202);
      assertEquals((await rpc("resources/list")).corpo.error.code, -32601);
    });

    await t.step("atendimento não vê escrita nem identificação de cliente", async () => {
      assertEquals(nomes((await rpc("tools/list")).corpo), [
        "cerebro_buscar",
        "produtos_consultar",
        "estoque_consultar",
        "pedidos_status",
        "financeiro_titulos_em_aberto",
      ]);
    });

    await t.step("equipe vê identificação e recebe cliente_id no esquema", async () => {
      const r = await rpc("tools/list", {}, { token: TOKEN_EQUIPE });
      assertEquals(nomes(r.corpo).includes("clientes_identificar"), true);
      assertEquals(nomes(r.corpo).includes("pedidos_criar"), false);
      const pedidos = r.corpo.result.tools.find((x: { name: string }) =>
        x.name === "pedidos_status"
      );
      assertEquals(pedidos.inputSchema.required, ["cliente_id"]);
      // Tudo é leitura, menos as duas ferramentas que registram propostas.
      assertEquals(
        r.corpo.result.tools
          .filter((x: { annotations: { readOnlyHint: boolean } }) => !x.annotations.readOnlyHint)
          .map((x: { name: string }) => x.name),
        ["cerebro_propor_fato", "atendimento_propor_orientacao", "implantacao_nao_se_aplica"],
      );
    });

    await t.step("busca no cérebro usa o perfil da credencial", async () => {
      const args = { name: "cerebro_buscar", arguments: { pergunta: "que horas abre?" } };
      assertEquals(conteudo((await rpc("tools/call", args)).corpo).fatos[0].texto, "8h às 18h");
      await rpc("tools/call", args, { token: TOKEN_EQUIPE });
      assertEquals(buscas.map((b) => b.perfil), ["atendimento", "equipe"]);
    });

    await t.step("atendimento: pedidos são os do telefone da sessão", async () => {
      const maria = await rpc("tools/call", { name: "pedidos_status", arguments: {} }, {
        sessao: MARIA,
      });
      assertEquals(conteudo(maria.corpo).pedidos.map((p: { pedido_id: string }) => p.pedido_id), [
        "PED-1001",
      ]);
      const joao = await rpc("tools/call", { name: "pedidos_status", arguments: {} }, {
        sessao: JOAO,
      });
      assertEquals(conteudo(joao.corpo).pedidos.map((p: { pedido_id: string }) => p.pedido_id), [
        "PED-1002",
      ]);
    });

    await t.step("atendimento: modelo não escolhe o cliente por argumento", async () => {
      const r = await rpc(
        "tools/call",
        { name: "pedidos_status", arguments: { cliente_id: "C-200" } },
        { sessao: MARIA },
      );
      assertEquals(r.corpo.result.isError, true);
      assert(r.corpo.result.content[0].text.startsWith("entrada_invalida"));
    });

    await t.step("atendimento: sem sessão ou telefone sem cadastro não consulta", async () => {
      const sem = await rpc("tools/call", { name: "financeiro_titulos_em_aberto", arguments: {} });
      assertEquals(sem.corpo.result.isError, true);
      const semCadastro = await rpc(
        "tools/call",
        { name: "financeiro_titulos_em_aberto", arguments: {} },
        { sessao: await abrirSessao("5500000000000") },
      );
      assertEquals(semCadastro.corpo.result.isError, true);
    });

    await t.step("telefone informado por quem chama é recusado", async () => {
      const r = await rpc("tools/call", { name: "pedidos_status", arguments: {} }, {
        contatoLegado: "5511999990001",
      });
      assertEquals(r.corpo.error.code, -32602);
      assertEquals(r.corpo.result, undefined);
      // Telefone no lugar do token de sessão também não vale.
      const noLugarDaSessao = await rpc("tools/call", { name: "pedidos_status", arguments: {} }, {
        sessao: "5511999990001",
      });
      assertEquals(noLugarDaSessao.corpo.error.code, -32602);
    });

    await t.step("sessão inventada, de outro tenant ou malformada derruba a chamada", async () => {
      const inventada = (await gerarTokenSessao()).token;
      const deOutroTenant = await abrirSessao("5511999990001", "tenant-b");
      for (const sessao of [inventada, deOutroTenant, "foco_s_curto", "abc"]) {
        // Mesmo uma ferramenta sem identidade falha: sessão inválida é falha fechada.
        const r = await rpc("tools/call", {
          name: "produtos_consultar",
          arguments: { termo: "tinta" },
        }, {
          sessao,
        });
        assertEquals(r.corpo.error?.code, -32602, sessao);
        assertEquals(r.corpo.error.message, "sessão inválida ou expirada", sessao);
      }
    });

    await t.step("atendimento não chama identificação nem escrita", async () => {
      for (const name of ["clientes_identificar", "pedidos_criar", "inexistente"]) {
        const r = await rpc("tools/call", { name, arguments: {} }, { sessao: MARIA });
        assertEquals(r.corpo.result.isError, true, name);
        assertEquals(r.corpo.result.content[0].text, "ferramenta desconhecida", name);
      }
      assertEquals(erp.pedidos.length, 2);
    });

    await t.step("equipe identifica o cliente e consulta com cliente_id", async () => {
      const o = { token: TOKEN_EQUIPE };
      const id = await rpc("tools/call", {
        name: "clientes_identificar",
        arguments: { telefone: TELEFONE_JOAO },
      }, o);
      assertEquals(conteudo(id.corpo), {
        encontrado: true,
        cliente_id: "C-200",
        nome: "João Lima",
      });
      const titulos = await rpc("tools/call", {
        name: "financeiro_titulos_em_aberto",
        arguments: { cliente_id: "C-200" },
      }, o);
      assertEquals(conteudo(titulos.corpo).titulos[0].titulo_id, "T-3");
      const sem = await rpc("tools/call", { name: "pedidos_status", arguments: {} }, o);
      assertEquals(sem.corpo.result.isError, true);
    });

    await t.step("equipe ignora a sessão de atendimento", async () => {
      const r = await rpc("tools/call", { name: "pedidos_status", arguments: {} }, {
        token: TOKEN_EQUIPE,
        sessao: MARIA,
      });
      assertEquals(r.corpo.result.isError, true);
    });

    await t.step("consulta sem identidade funciona e toda execução é registrada", async () => {
      const r = await rpc("tools/call", {
        name: "produtos_consultar",
        arguments: { termo: "tinta" },
      });
      assertEquals(conteudo(r.corpo).itens[0].produto_id, "P-3");
      assert(execucoes.some((e) => e.capacidade === "produtos.consultar" && e.ok));
      assert(execucoes.some((e) => e.capacidade === "clientes.identificar"));
    });

    await t.step("erro do conector volta como erro da ferramenta, sem derrubar", async () => {
      const r = await rpc("tools/call", {
        name: "estoque_consultar",
        arguments: { produto_id: "X-9" },
      });
      assertEquals(r.status, 200);
      assertEquals(r.corpo.result.isError, true);
      assert(r.corpo.result.content[0].text.startsWith("http_erro"));
    });

    await t.step("propostas: só o perfil equipe vê e chama", async () => {
      const equipe = nomes((await rpc("tools/list", {}, { token: TOKEN_EQUIPE })).corpo);
      for (
        const f of [
          "cerebro_propor_fato",
          "atendimento_propor_orientacao",
          "propostas_pendentes",
          "implantacao_pendencias",
          "implantacao_nao_se_aplica",
        ]
      ) {
        assert(equipe.includes(f), f);
        const r = await rpc("tools/call", { name: f, arguments: {} }, { sessao: MARIA });
        assertEquals(r.corpo.result.content[0].text, "ferramenta desconhecida", f);
      }
      assertEquals(propostas.length, 0);
    });

    await t.step("propostas: ferramentas que escrevem não são marcadas como leitura", async () => {
      const { tools } = (await rpc("tools/list", {}, { token: TOKEN_EQUIPE })).corpo.result;
      const marca = (n: string) =>
        tools.find((x: { name: string }) => x.name === n).annotations.readOnlyHint;
      assertEquals(
        [
          marca("cerebro_propor_fato"),
          marca("atendimento_propor_orientacao"),
          marca("propostas_pendentes"),
        ],
        [false, false, true],
      );
    });

    await t.step(
      "propostas: fato e orientação entram na fila do tenant da credencial",
      async () => {
        const o = { token: TOKEN_EQUIPE };
        const fato = await rpc("tools/call", {
          name: "cerebro_propor_fato",
          arguments: { titulo: "Aceita Pix", texto: "Pix com 3% de desconto.", chaves: ["pix"] },
        }, o);
        assert(fato.corpo.result.content[0].text.includes("depois que o dono"));
        const orientacao = await rpc("tools/call", {
          name: "atendimento_propor_orientacao",
          arguments: { categoria: "tom", texto: "Sem emoji.", justificativa: "A dona pediu." },
        }, o);
        assertEquals(orientacao.corpo.result.isError, undefined);
        assertEquals(propostas, [
          {
            tipo: "fato",
            tenant: "tenant-a",
            dados: {
              titulo: "Aceita Pix",
              texto: "Pix com 3% de desconto.",
              dominio: "geral",
              visibilidade: "interno",
              chaves: ["pix"],
            },
          },
          {
            tipo: "orientacao",
            tenant: "tenant-a",
            dados: { categoria: "tom", texto: "Sem emoji.", justificativa: "A dona pediu." },
          },
        ]);
      },
    );

    await t.step("propostas: entrada inválida e visibilidade restrita são recusadas", async () => {
      const o = { token: TOKEN_EQUIPE };
      const antes = propostas.length;
      const casos: [string, Record<string, unknown>][] = [
        ["cerebro_propor_fato", { titulo: "x", texto: "curto demais no título" }],
        ["cerebro_propor_fato", { titulo: "Margem", texto: "32%", visibilidade: "restrito" }],
        ["cerebro_propor_fato", { titulo: "Certo", texto: "texto", dominio: "juridico" }],
        ["cerebro_propor_fato", { titulo: "Certo", texto: "texto", chaves: "pix" }],
        ["atendimento_propor_orientacao", { categoria: "preco", texto: "Dar desconto." }],
        ["atendimento_propor_orientacao", { categoria: "tom", texto: "x".repeat(601) }],
      ];
      for (const [name, args] of casos) {
        const r = await rpc("tools/call", { name, arguments: args }, o);
        assertEquals(r.corpo.result.isError, true, JSON.stringify(args).slice(0, 60));
      }
      assertEquals(propostas.length, antes);
    });

    await t.step("propostas: fila cheia vira aviso para a equipe, não erro interno", async () => {
      encherFila(true);
      const r = await rpc("tools/call", {
        name: "atendimento_propor_orientacao",
        arguments: { categoria: "tom", texto: "Mais uma." },
      }, { token: TOKEN_EQUIPE });
      encherFila(false);
      assertEquals(r.status, 200);
      assertEquals(r.corpo.result.isError, true);
      assert(r.corpo.result.content[0].text.includes("fila de revisão está cheia"));
    });

    await t.step(
      "implantação: roteiro do segmento, o que falta e orientações sugeridas",
      async () => {
        const o = { token: TOKEN_EQUIPE };
        implantacao.segmento = "otica";
        implantacao.respondidas = [];
        const inicio = conteudo(
          (await rpc("tools/call", { name: "implantacao_pendencias", arguments: {} }, o)).corpo,
        );
        assertEquals([inicio.segmento, inicio.respondidas], ["otica", 0]);
        assertEquals(inicio.proximas_perguntas.length, 4);
        assertEquals(inicio.proximas_perguntas[0].pergunta_id, "otica.receita");
        assertEquals(inicio.proximas_perguntas[0].registrar_com, "cerebro_propor_fato");
        assert(
          inicio.orientacoes_sugeridas_para_o_segmento.some((x: { pergunta_id: string }) =>
            x.pergunta_id === "otica.limite.saude"
          ),
        );

        // Respondidas saem da lista, inclusive orientação sugerida já registrada.
        implantacao.respondidas = [
          "pacote:otica@3001#otica.receita",
          "pacote:otica@3001#otica.limite.saude",
          "material:site",
        ];
        const depois = conteudo(
          (await rpc("tools/call", { name: "implantacao_pendencias", arguments: {} }, o)).corpo,
        );
        assertEquals(depois.respondidas, 1);
        assertEquals(depois.proximas_perguntas[0].pergunta_id, "otica.exame");
        // As demais em aberto vêm só com id e assunto, para ligar resposta adiantada.
        assertEquals(
          depois.proximas_perguntas.length + depois.outras_perguntas_em_aberto.length,
          depois.perguntas_no_roteiro - 1,
        );
        assert(
          depois.outras_perguntas_em_aberto.some((x: { pergunta_id: string; assunto: string }) =>
            x.pergunta_id === "otica.convenios" && x.assunto === "Convênios e parcerias"
          ),
        );
        assert(
          !depois.orientacoes_sugeridas_para_o_segmento.some((x: { pergunta_id: string }) =>
            x.pergunta_id === "otica.limite.saude"
          ),
        );
      },
    );

    await t.step("implantação: resposta herda da pergunta e fica ligada a ela", async () => {
      const o = { token: TOKEN_EQUIPE };
      implantacao.segmento = "otica";
      propostas.length = 0;
      await rpc("tools/call", {
        name: "cerebro_propor_fato",
        arguments: {
          pergunta_id: "otica.prazo",
          texto: "5 dias úteis; multifocal, 10.",
          // O agente tenta decidir o que o roteiro já define: vale o roteiro.
          titulo: "Título inventado",
          dominio: "clientes",
          visibilidade: "interno",
          chaves: ["entrega dos oculos", "prazo"],
        },
      }, o);
      await rpc("tools/call", {
        name: "atendimento_propor_orientacao",
        arguments: { pergunta_id: "otica.limite.saude", texto: "Não interpretar receita." },
      }, o);
      await rpc("tools/call", {
        name: "atendimento_propor_orientacao",
        arguments: { pergunta_id: "marketing.tom", texto: "Tratar por você." },
      }, o);
      // deno-lint-ignore no-explicit-any
      const [fato, limite, tom] = propostas.map((p) => p.dados as any);
      assertEquals(fato.titulo, "Prazo para os óculos ficarem prontos");
      assertEquals([fato.dominio, fato.visibilidade, fato.tipo], [
        "operacao",
        "publico",
        "informacao",
      ]);
      // Chaves do roteiro primeiro, somadas às do agente, sem repetir.
      assertEquals(fato.chaves, [
        "prazo",
        "fica pronto",
        "quando fica pronto",
        "multifocal",
        "entrega dos oculos",
      ]);
      assert(fato.fonte.endsWith("#otica.prazo"));
      assertEquals([limite.categoria, tom.categoria], ["limite", "tom"]);
    });

    await t.step("implantação: pergunta que não se aplica deixa de ser feita", async () => {
      const o = { token: TOKEN_EQUIPE };
      implantacao.segmento = "otica";
      implantacao.respondidas = [];
      const marcar = (pergunta_id: string) =>
        rpc("tools/call", { name: "implantacao_nao_se_aplica", arguments: { pergunta_id } }, o);
      assertEquals((await marcar("otica.receita")).corpo.result.isError, undefined);
      const depois = conteudo(
        (await rpc("tools/call", { name: "implantacao_pendencias", arguments: {} }, o)).corpo,
      );
      assertEquals(depois.proximas_perguntas[0].pergunta_id, "otica.exame");
      // Só perguntas do roteiro da empresa podem ser marcadas.
      assertEquals((await marcar("supermercado.delivery")).corpo.result.isError, true);
      assertEquals((await marcar("otica.limite.saude")).corpo.result.isError, true);
      implantacao.respondidas = [];
    });

    await t.step("implantação: pergunta inexistente ou ferramenta trocada é recusada", async () => {
      const o = { token: TOKEN_EQUIPE };
      implantacao.segmento = "otica";
      const antes = propostas.length;
      const casos: [string, Record<string, unknown>][] = [
        ["cerebro_propor_fato", { pergunta_id: "supermercado.delivery", texto: "Entregamos." }],
        ["cerebro_propor_fato", { pergunta_id: "marketing.tom", texto: "Tratar por você." }],
        ["cerebro_propor_fato", { pergunta_id: "otica.limite.saude", texto: "Não interpretar." }],
        ["atendimento_propor_orientacao", { pergunta_id: "otica.prazo", texto: "5 dias." }],
      ];
      for (const [name, args] of casos) {
        const r = await rpc("tools/call", { name, arguments: args }, o);
        assertEquals(r.corpo.result.isError, true, JSON.stringify(args));
      }
      assertEquals(propostas.length, antes);
      implantacao.segmento = null;
      implantacao.respondidas = [];
    });

    await t.step("corpo acima do limite: 413 pelo Content-Length, sem ler", async () => {
      let lido = false;
      const corpo = new ReadableStream<Uint8Array>({
        pull(controle) {
          lido = true;
          controle.enqueue(new Uint8Array(1024));
        },
        // Sem pré-carga: `pull` só roda se alguém ler de fato.
      }, { highWaterMark: 0 });
      const resposta = await tratarMcp(
        new Request("http://local/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN_ATENDIMENTO}`,
            "content-length": String(MAX_CORPO + 1),
          },
          body: corpo,
        }),
        { repo, catalogo },
      );
      assertEquals(resposta.status, 413);
      assertEquals(lido, false);
    });

    await t.step(
      "corpo em pedaços sem Content-Length: para de ler ao passar do limite",
      async () => {
        const PEDACO = 10_000;
        let enviados = 0;
        let cancelado = false;
        const corpo = new ReadableStream<Uint8Array>({
          pull(controle) {
            enviados += PEDACO;
            controle.enqueue(new Uint8Array(PEDACO).fill(97));
          },
          cancel() {
            cancelado = true;
          },
        }, { highWaterMark: 0 });
        const resposta = await tratarMcp(
          new Request("http://local/mcp", {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN_ATENDIMENTO}` },
            body: corpo,
          }),
          { repo, catalogo },
        );
        assertEquals(resposta.status, 413);
        assertEquals(cancelado, true);
        // Fonte infinita: sem o corte, o teste nunca terminaria.
        assert(enviados <= MAX_CORPO + 2 * PEDACO, `leu ${enviados} bytes`);
      },
    );

    await t.step("limite é em bytes, não em caracteres", async () => {
      // Cada "é" ocupa 2 bytes em UTF-8: cabe em caracteres, estoura em bytes.
      const texto = "é".repeat(Math.floor(MAX_CORPO / 2) + 10);
      assert(texto.length < MAX_CORPO);
      const resposta = await tratarMcp(
        new Request("http://local/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN_ATENDIMENTO}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { texto } }),
        }),
        { repo, catalogo },
      );
      assertEquals(resposta.status, 413);
    });

    await t.step("corpo dentro do limite continua funcionando", async () => {
      const texto = "a".repeat(MAX_CORPO - 200);
      const r = await rpc("ping", { texto });
      assertEquals(r.status, 200);
      assertEquals(r.corpo.result, {});
    });

    await t.step("tenant sem conectores só tem o cérebro", async () => {
      const vazio: Repositorio = { ...repo, conectoresAprovados: () => Promise.resolve([]) };
      assertEquals(nomes((await cliente(vazio)("tools/list")).corpo), ["cerebro_buscar"]);
    });
  } finally {
    await parar();
  }
});

Deno.test("perfil de implantação: só propostas, sem busca e sem sistema da empresa", async () => {
  const { integracao, segredo, parar } = subirErp();
  try {
    const { repo, buscas, execucoes, propostas, implantacao } = await repoFalso(
      integracao,
      segredo,
    );
    const deps = { repo, catalogo };
    const cred: Credencial = {
      credencial_id: "agente",
      tenant_id: "tenant-a",
      perfil: "implantacao",
    };
    assertEquals((await ferramentasDe(deps, cred)).map((f) => f.name), [
      "cerebro_propor_fato",
      "atendimento_propor_orientacao",
      "implantacao_pendencias",
      "propostas_pendentes",
      "implantacao_nao_se_aplica",
    ]);

    // O tenant tem conectores aprovados e fatos, mas este perfil não os alcança,
    // nem informando um telefone de cliente.
    for (
      const [nome, args] of [
        ["cerebro_buscar", { pergunta: "desconto máximo" }],
        ["estoque_consultar", { produto_id: "P-100" }],
        ["clientes_identificar", { telefone: "5511999990001" }],
        ["financeiro_titulos_em_aberto", { cliente_id: "C-1" }],
      ] as const
    ) {
      const r = await executarFerramenta(deps, cred, "5511999990001", nome, args);
      assertEquals([r.isError, r.content[0].text], [true, "ferramenta desconhecida"], nome);
    }
    assertEquals([buscas.length, execucoes.length], [0, 0]);

    implantacao.segmento = "otica";
    const pendencias = JSON.parse(
      (await executarFerramenta(deps, cred, null, "implantacao_pendencias", {})).content[0].text,
    );
    assertEquals(pendencias.segmento, "otica");
    const r = await executarFerramenta(deps, cred, null, "cerebro_propor_fato", {
      pergunta_id: "otica.prazo",
      texto: "Óculos ficam prontos em 5 dias úteis.",
    });
    assertEquals(r.isError, undefined);
    assertEquals(propostas.map((p) => [p.tipo, p.tenant]), [["fato", "tenant-a"]]);
  } finally {
    await parar();
  }
});

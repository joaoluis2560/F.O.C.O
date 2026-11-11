// Teste de integração do servidor MCP contra o Postgres local (supabase db start).
// Só roda com FOCO_DB_URL definida: `deno task integracao`.

import { assert, assertEquals } from "@std/assert";
// A versão nativa de Deno do driver não traz tipos; eles vêm do pacote npm.
// @ts-types="npm:postgres@3.4.5"
import postgres from "postgres";
import { carregarCatalogo, carregarConector, subirErp } from "../conectores/apoio_teste.ts";
import { hashDefinicao } from "../conectores/executor.ts";
import type { Catalogo } from "../conectores/tipos.ts";
import { criarRepositorioPg } from "./repositorio_pg.ts";
import { tratarMcp } from "./servidor.ts";
import { gerarTokenSessao } from "./sessao.ts";

const url = Deno.env.get("FOCO_DB_URL");

async function sha256Hex(texto: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test({
  name: "MCP de ponta a ponta com Postgres local",
  ignore: !url,
  fn: async (t) => {
    const mapa = await carregarCatalogo();
    const catalogo: Catalogo = { versao: 1, capacidades: [...mapa.values()] };
    const sql = postgres(url!, { prepare: false, max: 1, onnotice: () => {} });
    const repo = criarRepositorioPg(url!);
    const { integracao, segredo, parar } = subirErp();
    const sufixo = crypto.randomUUID().slice(0, 8);
    const tokens = {
      a_atendimento: `foco_${crypto.randomUUID()}`,
      a_equipe: `foco_${crypto.randomUUID()}`,
      b_atendimento: `foco_${crypto.randomUUID()}`,
    };

    const limpar = async () => {
      await sql`delete from nucleo.tenants where slug like ${"itest-" + sufixo + "-%"}`;
      await sql`delete from vault.secrets where name = ${"itest-" + sufixo}`;
    };

    try {
      // Montagem: dois tenants; só o A tem integração com o ERP simulado.
      const [a] = await sql`
        insert into nucleo.tenants (nome, slug) values ('Tenant A', ${`itest-${sufixo}-a`})
        returning id`;
      const [b] = await sql`
        insert into nucleo.tenants (nome, slug) values ('Tenant B', ${`itest-${sufixo}-b`})
        returning id`;
      const [{ segredo_id }] = await sql`
        select vault.create_secret(${segredo}, ${"itest-" + sufixo}) as segredo_id`;
      const [integ] = await sql`
        insert into integracao.integracoes
          (tenant_id, nome, base_url, permite_http, tipo_auth, segredo_id)
        values (${a.id}, 'erp', ${integracao.base_url}, true, 'bearer', ${segredo_id})
        returning id`;
      for (const cap of catalogo.capacidades) {
        const definicao = await carregarConector(cap.nome);
        await sql`
          insert into integracao.conectores
            (tenant_id, integracao_id, capacidade, tipo, definicao, hash, estado, aprovado_em)
          values (${a.id}, ${integ.id}, ${cap.nome}, ${cap.tipo}, ${sql.json(definicao as never)},
                  ${await hashDefinicao(definicao)}, 'aprovado', now())`;
      }
      const fatos = (tenant: string, lista: unknown[]) =>
        sql`select cerebro.propor_fatos(${tenant}, ${sql.json(lista as never)}, 'pacote')`;
      await fatos(a.id, [
        {
          titulo: "Horário de funcionamento",
          texto: "Segunda a sexta, das 8h às 18h.",
          visibilidade: "publico",
          dominio: "operacao",
        },
        {
          titulo: "Desconto máximo",
          texto: "Até 5% sem consultar a gerência.",
          visibilidade: "interno",
          dominio: "vendas",
        },
      ]);
      await fatos(b.id, [{
        titulo: "Horário de funcionamento",
        texto: "Aberto 24 horas.",
        visibilidade: "publico",
        dominio: "operacao",
      }]);
      await sql`
        update cerebro.fatos set status = 'ativo', revisado_em = now()
        where tenant_id in (${a.id}, ${b.id})`;
      await sql`
        insert into nucleo.credenciais (tenant_id, nome, perfil, hash) values
          (${a.id}, 'atendimento', 'atendimento', ${await sha256Hex(tokens.a_atendimento)}),
          (${a.id}, 'hermes', 'equipe', ${await sha256Hex(tokens.a_equipe)}),
          (${b.id}, 'atendimento', 'atendimento', ${await sha256Hex(tokens.b_atendimento)})`;

      let id = 0;
      const rpc = async (token: string, method: string, params?: unknown, sessao?: string) => {
        const resposta = await tratarMcp(
          new Request("http://local/mcp", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              ...(sessao && { "x-foco-sessao": sessao }),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          }),
          { repo, catalogo },
        );
        return { status: resposta.status, corpo: await resposta.json() };
      };
      // deno-lint-ignore no-explicit-any
      const conteudo = (corpo: any) => JSON.parse(corpo.result.content[0].text);
      const buscar = (token: string, pergunta: string) =>
        rpc(token, "tools/call", { name: "cerebro_buscar", arguments: { pergunta } });

      await t.step("token resolve tenant e perfil; token revogado deixa de valer", async () => {
        assertEquals((await rpc(tokens.a_atendimento, "ping")).status, 200);
        await sql`update nucleo.credenciais set revogada_em = now()
                  where hash = ${await sha256Hex(tokens.b_atendimento)}`;
        assertEquals((await rpc(tokens.b_atendimento, "ping")).status, 401);
        await sql`update nucleo.credenciais set revogada_em = null
                  where hash = ${await sha256Hex(tokens.b_atendimento)}`;
      });

      await t.step("ferramentas refletem os conectores aprovados do tenant", async () => {
        const a = await rpc(tokens.a_atendimento, "tools/list");
        assertEquals(a.corpo.result.tools.length, 5);
        const b = await rpc(tokens.b_atendimento, "tools/list");
        assertEquals(b.corpo.result.tools.map((x: { name: string }) => x.name), [
          "cerebro_buscar",
        ]);
      });

      await t.step("cérebro: atendimento só vê público, equipe vê interno", async () => {
        const horario = conteudo((await buscar(tokens.a_atendimento, "que horas abre?")).corpo);
        assertEquals(horario.fatos, []);
        const funcionamento = conteudo(
          (await buscar(tokens.a_atendimento, "horário de funcionamento")).corpo,
        );
        assertEquals(funcionamento.fatos[0].texto, "Segunda a sexta, das 8h às 18h.");
        const desconto = "qual o desconto máximo?";
        assertEquals(conteudo((await buscar(tokens.a_atendimento, desconto)).corpo).fatos, []);
        assertEquals(
          conteudo((await buscar(tokens.a_equipe, desconto)).corpo).fatos[0].titulo,
          "Desconto máximo",
        );
      });

      await t.step("cérebro: um tenant não vê fatos do outro", async () => {
        const b = conteudo((await buscar(tokens.b_atendimento, "horário de funcionamento")).corpo);
        assertEquals(b.fatos.map((f: { texto: string }) => f.texto), ["Aberto 24 horas."]);
      });

      // A entrada do canal abre a sessão pelo banco; o agente só recebe o token.
      const abrirSessao = async (tenant: string, contato: string) => {
        const { token, hash } = await gerarTokenSessao();
        await sql`select nucleo.abrir_sessao_atendimento(${tenant}, ${contato}, ${hash})`;
        return { token, hash };
      };
      const titulos = (token: string, sessao?: string) =>
        rpc(token, "tools/call", { name: "financeiro_titulos_em_aberto", arguments: {} }, sessao);

      await t.step("conector roda com segredo do Vault e fica registrado", async () => {
        const maria = await abrirSessao(a.id, "5511999990001");
        const r = await titulos(tokens.a_atendimento, maria.token);
        assertEquals(conteudo(r.corpo).titulos.map((x: { titulo_id: string }) => x.titulo_id), [
          "T-1",
        ]);
        const execucoes = await sql`
          select capacidade, ok from integracao.conector_execucoes
          where tenant_id = ${a.id} order by id`;
        assertEquals(execucoes.map((e) => [e.capacidade, e.ok]), [
          ["clientes.identificar", true],
          ["financeiro.titulos_em_aberto", true],
        ]);
      });

      await t.step("token de atendimento sozinho não alcança dados de cliente", async () => {
        // Sem sessão: nada de dados.
        assertEquals((await titulos(tokens.a_atendimento)).corpo.result.isError, true);
        // Telefone conhecido no cabeçalho antigo: recusado.
        const legado = await tratarMcp(
          new Request("http://local/mcp", {
            method: "POST",
            headers: {
              authorization: `Bearer ${tokens.a_atendimento}`,
              "x-foco-contato": "5511999990001",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 99,
              method: "tools/call",
              params: { name: "financeiro_titulos_em_aberto", arguments: {} },
            }),
          }),
          { repo, catalogo },
        );
        assertEquals((await legado.json()).error.code, -32602);
        // Sessão inventada: recusada.
        const inventada = (await gerarTokenSessao()).token;
        assertEquals((await titulos(tokens.a_atendimento, inventada)).corpo.error.code, -32602);
      });

      await t.step("sessão não atravessa tenants e vence", async () => {
        const maria = await abrirSessao(a.id, "5511999990001");
        // Sessão do Tenant A apresentada com o token do Tenant B.
        assertEquals((await titulos(tokens.b_atendimento, maria.token)).corpo.error.code, -32602);
        // Sessão aberta no Tenant B para o mesmo telefone não serve no Tenant A.
        const noB = await abrirSessao(b.id, "5511999990001");
        assertEquals((await titulos(tokens.a_atendimento, noB.token)).corpo.error.code, -32602);
        // Vencida.
        await sql`
          update nucleo.sessoes_atendimento
          set criado_em = now() - interval '2 hours', expira_em = now() - interval '1 hour'
          where hash = ${maria.hash}`;
        assertEquals((await titulos(tokens.a_atendimento, maria.token)).corpo.error.code, -32602);
      });

      await t.step("conector degradado ou integração inativa some das ferramentas", async () => {
        await sql`update integracao.conectores set estado = 'degradado'
                  where tenant_id = ${a.id} and capacidade = 'estoque.consultar'`;
        const nomes = async () =>
          (await rpc(tokens.a_atendimento, "tools/list")).corpo.result.tools
            .map((x: { name: string }) => x.name);
        assert(!(await nomes()).includes("estoque_consultar"));
        await sql`update integracao.integracoes set ativo = false where id = ${integ.id}`;
        assertEquals(await nomes(), ["cerebro_buscar"]);
      });
    } finally {
      await limpar();
      await sql.end({ timeout: 2 });
      await repo.fechar();
      await parar();
    }
  },
});

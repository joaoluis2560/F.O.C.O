// Atendimento de ponta a ponta contra o Postgres local: fila, regras, agente,
// ferramentas reais (cérebro e ERP simulado) e entrega em um canal falso.
// O modelo é roteirizado. Só roda com FOCO_DB_URL: `deno task integracao`.

import { assert, assertEquals } from "@std/assert";
// @ts-types="npm:postgres@3.4.5"
import postgres from "postgres";
import { carregarCatalogo, carregarConector, subirErp } from "../conectores/apoio_teste.ts";
import { hashDefinicao } from "../conectores/executor.ts";
import type { Catalogo } from "../conectores/tipos.ts";
import { criarRepositorioPg } from "../mcp/repositorio_pg.ts";
import type { ClienteCanal } from "./chatwoot.ts";
import type { ClienteModelo, RespostaModelo } from "./modelo.ts";
import { criarRepositorioAtendimento } from "./repositorio.ts";
import { processarProximoLote } from "./worker.ts";

const url = Deno.env.get("FOCO_DB_URL");

Deno.test({
  name: "atendimento de ponta a ponta com Postgres local",
  ignore: !url,
  fn: async (t) => {
    const mapa = await carregarCatalogo();
    const catalogo: Catalogo = { versao: 1, capacidades: [...mapa.values()] };
    const sql = postgres(url!, { prepare: false, max: 1, onnotice: () => {} });
    const repo = criarRepositorioAtendimento(url!);
    const nucleo = criarRepositorioPg(url!);
    const { integracao, segredo, parar } = subirErp();
    const sufixo = crypto.randomUUID().slice(0, 8);
    const hashCanal = crypto.randomUUID().replaceAll("-", "").repeat(2);

    // Canal falso: guarda o que seria enviado.
    const canal: { tipo: string; conversa: string; texto?: string }[] = [];
    const clienteCanal: ClienteCanal = {
      enviar: (conversa, texto) =>
        Promise.resolve(void canal.push({ tipo: "enviar", conversa, texto })),
      notaInterna: (conversa, texto) =>
        Promise.resolve(void canal.push({ tipo: "nota", conversa, texto })),
      transferir: (conversa) => Promise.resolve(void canal.push({ tipo: "transferir", conversa })),
    };

    // Modelo roteirizado, com registro das ferramentas oferecidas e dos resultados vistos.
    const fila: RespostaModelo[] = [];
    const visto: { modelo: string; ultima: string }[] = [];
    const uso = { tokens_entrada: 500, tokens_cache: 0, tokens_saida: 40, custo_usd: 0.0004 };
    const modelo: ClienteModelo = ({ modelo, mensagens }) => {
      visto.push({ modelo, ultima: mensagens.at(-1)!.content });
      const r = fila.shift();
      return r ? Promise.resolve(r) : Promise.reject(new Error("roteiro vazio"));
    };
    const fala = (texto: string): RespostaModelo => ({ texto, chamadas: [], uso });
    const chama = (nome: string, args: unknown): RespostaModelo => ({
      texto: "",
      chamadas: [{ id: crypto.randomUUID(), nome, argumentos: JSON.stringify(args) }],
      uso,
    });

    const deps = {
      repo,
      nucleo,
      catalogo,
      modelo,
      canal: () => clienteCanal,
      espera_seg: 0,
    };

    try {
      const [tenant] = await sql`
        insert into nucleo.tenants (nome, slug) values ('Atendimento', ${`itest-at-${sufixo}`})
        returning id`;
      const [{ seg_erp }] = await sql`
        select vault.create_secret(${segredo}, ${`itest-at-erp-${sufixo}`}) as seg_erp`;
      const [{ seg_canal }] = await sql`
        select vault.create_secret('token-do-canal', ${`itest-at-canal-${sufixo}`}) as seg_canal`;
      const [integ] = await sql`
        insert into integracao.integracoes
          (tenant_id, nome, base_url, permite_http, tipo_auth, segredo_id)
        values (${tenant.id}, 'erp', ${integracao.base_url}, true, 'bearer', ${seg_erp})
        returning id`;
      for (const cap of catalogo.capacidades) {
        const definicao = await carregarConector(cap.nome);
        await sql`
          insert into integracao.conectores
            (tenant_id, integracao_id, capacidade, tipo, definicao, hash, estado, aprovado_em)
          values (${tenant.id}, ${integ.id}, ${cap.nome}, ${cap.tipo},
                  ${sql.json(definicao as never)}, ${await hashDefinicao(definicao)},
                  'aprovado', now())`;
      }
      await sql`select cerebro.propor_fatos(${tenant.id}, ${
        sql.json([
          {
            titulo: "Horário de atendimento",
            texto: "Segunda a sexta, das 8h às 18h.",
            visibilidade: "publico",
            chaves: ["horario", "abre"],
          },
          {
            titulo: "Desconto máximo",
            texto: "Até 5% sem a gerência.",
            visibilidade: "interno",
            chaves: ["desconto"],
          },
        ] as never)
      }, 'pacote')`;
      await sql`update cerebro.fatos set status = 'ativo', revisado_em = now()
                where tenant_id = ${tenant.id}`;
      await sql`
        insert into atendimento.canais
          (tenant_id, tipo, nome, hash, conta_externa, base_url, segredo_id)
        values (${tenant.id}, 'chatwoot', 'whatsapp', ${hashCanal}, '7',
                'https://chat.example', ${seg_canal})`;
      await sql`
        insert into atendimento.config (tenant_id, modo, modelo_barato, modelo_forte)
        values (${tenant.id}, 'producao', 'teste/barato', 'teste/forte')`;

      const canalId = await repo.identificarCanal(hashCanal);
      assert(canalId);
      let n = 0;
      const chega = (conversa: string, contato: string | null, texto: string, extra = {}) =>
        repo.receberMensagem(canalId, {
          conversa_externa: conversa,
          contato,
          externa_id: `m${++n}`,
          autor: "cliente",
          texto,
          anexos: 0,
          ...extra,
        });
      const execucoes = () =>
        sql`select nivel, modelo, resultado, motivo, custo_usd::float8 as custo, sombra
            from atendimento.execucoes where tenant_id = ${tenant.id} order by id`;

      await t.step("fila vazia não faz nada", async () => {
        assertEquals(await processarProximoLote(deps), null);
      });

      await t.step("dúvida comum: modelo barato usa o cérebro e responde ao cliente", async () => {
        await chega("100", "5511999990001", "Oi");
        await chega("100", "5511999990001", "que horas vocês abrem?");
        fila.push(chama("cerebro_buscar", { pergunta: "que horas abre" }), fala("Abrimos às 8h."));
        const r = await processarProximoLote(deps);
        assertEquals([r?.acao, r?.nivel, r?.sombra], ["responder", 1, false]);
        assertEquals(r?.custo_usd, 0.0008);
        // As duas mensagens foram juntadas em um pedido só.
        assertEquals(visto[0].ultima, "Oi\nque horas vocês abrem?");
        // O modelo viu o fato público, vindo do banco.
        assert(visto[1].ultima.includes("das 8h às 18h"));
        assertEquals(canal, [{ tipo: "enviar", conversa: "100", texto: "Abrimos às 8h." }]);
        assertEquals((await execucoes()).map((e) => [e.nivel, e.modelo, e.resultado, e.custo]), [
          [1, "teste/barato", "respondeu", 0.0008],
        ]);
      });

      await t.step("perfil de atendimento não alcança fato interno", async () => {
        await chega("100", "5511999990001", "qual o desconto máximo?");
        fila.push(chama("cerebro_buscar", { pergunta: "desconto máximo" }), fala("Vou verificar."));
        await processarProximoLote(deps);
        assertEquals(visto.at(-1)?.ultima, '{"fatos":[]}');
      });

      await t.step("dados do cliente vêm do telefone do canal, não do modelo", async () => {
        visto.length = 0;
        await chega("100", "5511999990001", "tenho boleto em aberto?");
        fila.push(
          // O modelo tenta escolher outro cliente: o argumento é recusado.
          chama("financeiro_titulos_em_aberto", { cliente_id: "C-200" }),
          chama("financeiro_titulos_em_aberto", {}),
          fala("Você tem um boleto de R$ 352,90."),
        );
        const r = await processarProximoLote(deps);
        assertEquals(r?.acao, "responder");
        assert(visto[1].ultima.startsWith("entrada_invalida"));
        assert(visto[2].ultima.includes('"titulo_id":"T-1"'));
        assert(!visto[2].ultima.includes("T-3"));
      });

      await t.step("histórico da conversa acompanha o próximo pedido", async () => {
        const historico = await repo.historico(
          tenant.id,
          (await sql`
          select id from atendimento.conversas where tenant_id = ${tenant.id}
            and conversa_externa = '100'`)[0].id,
        );
        assertEquals(historico.slice(0, 3).map((h) => [h.autor, h.texto]), [
          ["cliente", "Oi"],
          ["cliente", "que horas vocês abrem?"],
          ["agente", "Abrimos às 8h."],
        ]);
      });

      await t.step(
        "transferência: avisa o cliente, anota o motivo e passa para a equipe",
        async () => {
          canal.length = 0;
          await chega("200", "5511999990002", "quero cancelar meu pedido");
          fila.push(chama("transferir_para_humano", { motivo: "cliente quer cancelar" }));
          const r = await processarProximoLote(deps);
          assertEquals([r?.acao, r?.motivo], ["transferir", "cliente quer cancelar"]);
          assertEquals(canal.map((c) => c.tipo), ["enviar", "nota", "transferir"]);
          assert(canal[1].texto?.includes("cliente quer cancelar"));
        },
      );

      await t.step("depois que uma pessoa responde, o agente se cala sem gastar", async () => {
        canal.length = 0;
        await repo.receberMensagem(canalId, {
          conversa_externa: "200",
          contato: null,
          externa_id: "h1",
          autor: "humano",
          texto: "Oi, aqui é a Ana.",
          anexos: 0,
        });
        await chega("200", "5511999990002", "obrigado");
        const antes = fila.length;
        const r = await processarProximoLote(deps);
        assertEquals([r?.acao, r?.motivo, r?.nivel, r?.custo_usd], [
          "ignorar",
          "humano_assumiu",
          0,
          0,
        ]);
        assertEquals(canal, []);
        assertEquals(fila.length, antes);
      });

      await t.step("anexo sem texto é transferido por regra, sem modelo", async () => {
        canal.length = 0;
        await chega("300", "5511999990003", "", { anexos: 1 });
        const r = await processarProximoLote(deps);
        assertEquals([r?.acao, r?.motivo, r?.nivel], ["transferir", "midia_nao_suportada", 0]);
        assertEquals(canal.map((c) => c.tipo), ["enviar", "nota", "transferir"]);
      });

      await t.step("modo sombra: nada vai para o cliente, só nota para a equipe", async () => {
        canal.length = 0;
        await sql`update atendimento.config set modo = 'sombra' where tenant_id = ${tenant.id}`;
        await chega("400", "5511999990004", "vocês abrem sábado?");
        fila.push(fala("Abrimos de segunda a sexta."));
        const r = await processarProximoLote(deps);
        assertEquals([r?.acao, r?.sombra], ["responder", true]);
        assertEquals(canal.map((c) => c.tipo), ["nota"]);
        assert(canal[0].texto?.startsWith("Sugestão do agente"));
        const saidas = await sql`
          select 1 from atendimento.mensagens m join atendimento.conversas c on c.id = m.conversa_id
          where c.conversa_externa = '400' and m.autor = 'agente'`;
        assertEquals(saidas.length, 0);
        await sql`update atendimento.config set modo = 'producao' where tenant_id = ${tenant.id}`;
      });

      await t.step("teto diário atingido: transfere sem chamar modelo", async () => {
        canal.length = 0;
        await sql`update atendimento.config set teto_diario_usd = 0.0001
                  where tenant_id = ${tenant.id}`;
        await chega("500", "5511999990005", "oi");
        const antes = fila.length;
        const r = await processarProximoLote(deps);
        assertEquals([r?.acao, r?.motivo, r?.nivel], ["transferir", "teto_diario", 0]);
        assertEquals(fila.length, antes);
        await sql`update atendimento.config set teto_diario_usd = 2 where tenant_id = ${tenant.id}`;
      });

      await t.step(
        "falha na entrega: custo fica registrado e o lote volta para a fila",
        async () => {
          await chega("600", "5511999990006", "oi");
          fila.push(fala("Olá!"));
          const quebrado = {
            ...deps,
            canal: () => ({
              ...clienteCanal,
              enviar: () => Promise.reject(new Error("canal respondeu HTTP 500")),
            }),
          };
          let lancou = false;
          try {
            await processarProximoLote(quebrado);
          } catch {
            lancou = true;
          }
          assert(lancou);
          const ultimas = (await execucoes()).slice(-2).map((e) => [e.nivel, e.resultado]);
          assertEquals(ultimas, [[1, "respondeu"], [0, "falhou"]]);
          // Prazo vence e a mensagem é entregue de novo.
          await sql`update atendimento.mensagens set lease_ate = now() - interval '1 second'
                  where tenant_id = ${tenant.id} and estado = 'processando'`;
          canal.length = 0;
          fila.push(fala("Olá de novo!"));
          const r = await processarProximoLote(deps);
          assertEquals(r?.acao, "responder");
          assertEquals(canal[0].texto, "Olá de novo!");
        },
      );

      await t.step("nada ficou preso na fila", async () => {
        const [{ presas }] = await sql`
          select count(*)::int as presas from atendimento.mensagens
          where tenant_id = ${tenant.id} and estado in ('pendente', 'processando')`;
        assertEquals(presas, 0);
        assertEquals(await processarProximoLote(deps), null);
      });
    } finally {
      await sql`delete from nucleo.tenants where slug = ${`itest-at-${sufixo}`}`;
      await sql`delete from vault.secrets where name like ${`itest-at-%-${sufixo}`}`;
      await sql.end({ timeout: 2 });
      await repo.fechar();
      await nucleo.fechar();
      await parar();
    }
  },
});

// Prepara o piloto interno no ambiente local:
//   1. cria (ou recria) a empresa de exemplo no Postgres local, com dono,
//      integração com o ERP simulado, conectores aprovados e fatos revisados;
//   2. emite uma credencial de perfil `equipe` para o Hermes;
//   3. grava piloto/hermes/.env com o token.
//
// Só ambiente local. deno task piloto:preparar

// @ts-types="npm:postgres@3.4.5"
import postgres from "postgres";
import { fatosDoPacote, type Pacote } from "../supabase/functions/_shared/cerebro/pacote.ts";
import { hashDefinicao } from "../supabase/functions/_shared/conectores/executor.ts";
import type {
  Catalogo,
  DefinicaoConector,
} from "../supabase/functions/_shared/conectores/tipos.ts";

const url = Deno.env.get("FOCO_DB_URL");
if (!url || !/@(127\.0\.0\.1|localhost):/.test(url)) {
  console.error("FOCO_DB_URL deve apontar para o Postgres local (use `deno task piloto:preparar`)");
  Deno.exit(2);
}

const SLUG = "loja-piloto";
const EMAIL_DONO = "dono@loja-piloto.test";
const SEGREDO_VAULT = "piloto-erp-simulado";
const raiz = new URL("../", import.meta.url);
const ler = async <T>(caminho: string): Promise<T> =>
  JSON.parse(await Deno.readTextFile(new URL(caminho, raiz)));

const catalogo = await ler<Catalogo>("supabase/functions/_shared/catalogo/capacidades.json");
const pacote = await ler<Pacote>("supabase/functions/_shared/catalogo/pacotes/base.json");
const respostas = await ler<Record<string, string>>("piloto/respostas-exemplo.json");
const tokenErp = Deno.env.get("ERP_SIMULADO_TOKEN") ?? "erp-simulado-local";
const baseErp = Deno.env.get("ERP_SIMULADO_URL") ?? "http://127.0.0.1:8787";

const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  await sql.begin(async (tx) => {
    // Recomeça do zero a cada execução.
    await tx`delete from nucleo.tenants where slug = ${SLUG}`;
    await tx`delete from auth.users where email = ${EMAIL_DONO}`;
    await tx`delete from vault.secrets where name = ${SEGREDO_VAULT}`;

    const [tenant] = await tx`
      insert into nucleo.tenants (nome, slug) values ('Casa do Parafuso', ${SLUG}) returning id`;
    const [dono] = await tx`
      insert into auth.users (id, instance_id, aud, role, email)
      values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
              'authenticated', 'authenticated', ${EMAIL_DONO})
      returning id`;
    await tx`
      insert into nucleo.membros (tenant_id, user_id, papel)
      values (${tenant.id}, ${dono.id}, 'owner')`;

    const [{ segredo_id }] = await tx`
      select vault.create_secret(${tokenErp}, ${SEGREDO_VAULT}) as segredo_id`;
    const [integracao] = await tx`
      insert into integracao.integracoes
        (tenant_id, nome, base_url, permite_http, tipo_auth, segredo_id)
      values (${tenant.id}, 'erp-simulado', ${baseErp}, true, 'bearer', ${segredo_id})
      returning id`;
    for (const cap of catalogo.capacidades) {
      const definicao = await ler<DefinicaoConector>(
        `ferramentas/erp-simulado/conectores/${cap.nome}.json`,
      );
      await tx`
        insert into integracao.conectores
          (tenant_id, integracao_id, capacidade, tipo, definicao, hash, estado,
           aprovado_por, aprovado_em)
        values (${tenant.id}, ${integracao.id}, ${cap.nome}, ${cap.tipo},
                ${tx.json(definicao as never)}, ${await hashDefinicao(definicao)}, 'aprovado',
                ${dono.id}, now())`;
    }

    // Respostas do pacote viram fatos propostos; o dono ativa cada um com a
    // visibilidade sugerida, pelo mesmo caminho de revisão usado em produção.
    const { fatos, orientacoes, pendentes } = fatosDoPacote(pacote, respostas);
    const ids = await tx`
      select cerebro.propor_fatos(${tenant.id}, ${tx.json(fatos as never)}, 'pacote') as id`;
    for (const { id } of ids) {
      await tx`select cerebro.revisar_fato(${tenant.id}, ${id}, ${dono.id}, 'ativar')`;
    }

    // Tom, limites e quando transferir: orientações do atendimento, também
    // aprovadas pelo dono antes de valer.
    for (const o of orientacoes) {
      const [{ id }] = await tx`
        select atendimento.propor_orientacao(
          ${tenant.id}, ${o.categoria}::atendimento.categoria_orientacao, ${o.texto}, null,
          'pacote') as id`;
      await tx`select atendimento.revisar_orientacao(${tenant.id}, ${id}, ${dono.id}, 'ativar')`;
    }

    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = "foco_" + btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    await tx`
      insert into nucleo.credenciais (tenant_id, nome, perfil, hash)
      values (${tenant.id}, 'hermes', 'equipe', ${hash})`;

    // .env do Hermes: preserva a chave do OpenRouter se o arquivo já existir.
    const pasta = new URL("piloto/hermes/", raiz);
    const envUrl = new URL(".env", pasta);
    let anterior = "";
    try {
      anterior = await Deno.readTextFile(envUrl);
    } catch { /* primeira execução */ }
    const chave = anterior.match(/^OPENROUTER_API_KEY=(.*)$/m)?.[1] ?? "";
    const modelo = anterior.match(/^HERMES_MODELO=(.*)$/m)?.[1] ?? "";
    await Deno.writeTextFile(
      envUrl,
      `# Gerado por piloto/preparar.ts. Não versionar.\n` +
        `OPENROUTER_API_KEY=${chave}\n` +
        `# Modelo no OpenRouter, ex.: o modelo barato escolhido para o piloto.\n` +
        `HERMES_MODELO=${modelo}\n` +
        `FOCO_MCP_TOKEN=${token}\n`,
      { mode: 0o600 },
    );

    console.log(`Empresa de exemplo: Casa do Parafuso (${tenant.id})`);
    console.log(
      `Fatos ativos: ${fatos.length}; orientações ativas: ${orientacoes.length}; ` +
        `perguntas sem resposta: ${pendentes.length}`,
    );
    console.log(`Conectores aprovados: ${catalogo.capacidades.length}`);
    console.log("Credencial `hermes` (perfil equipe) gravada em piloto/hermes/.env");
    if (!chave || !modelo) {
      console.log("Falta preencher OPENROUTER_API_KEY e HERMES_MODELO em piloto/hermes/.env");
    }
  });
} finally {
  await sql.end({ timeout: 2 });
}

// Cria uma empresa nova, vazia, de um segmento, para exercitar a implantação
// guiada: o Hermes conduz a entrevista e registra as respostas como propostas.
// Equivale ao que acontecerá quando alguém se cadastrar pela página de entrada
// informando nome, telefone e segmento.
//
// Só ambiente local.
//   deno task piloto:implantar otica "Ótica Boa Vista"
//   deno task piloto:aprovar otica      (aprova tudo que está pendente, como a dona)

// @ts-types="npm:postgres@3.4.5"
import postgres from "postgres";
import { pacoteDoSegmento, SEGMENTOS } from "../supabase/functions/_shared/catalogo/pacotes.ts";

const url = Deno.env.get("FOCO_DB_URL");
if (!url || !/@(127\.0\.0\.1|localhost):/.test(url)) {
  console.error("FOCO_DB_URL deve apontar para o Postgres local (use as tarefas `piloto:*`)");
  Deno.exit(2);
}
const [acao, segmento, nome] = Deno.args;
const conhecido = SEGMENTOS.some((s) => s.segmento === segmento);
if ((acao !== "criar" && acao !== "aprovar") || !conhecido) {
  console.error(
    `uso: criar|aprovar <segmento> ["Nome da empresa"]\nsegmentos: ` +
      SEGMENTOS.map((s) => s.segmento).join(", "),
  );
  Deno.exit(2);
}
const slug = `${segmento}-piloto`;
const emailDono = `dono@${slug}.test`;
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  if (acao === "aprovar") {
    // Faz o papel da dona na tela de revisão, que ainda não existe.
    const [t] = await sql`
      select t.id, m.user_id as dono from nucleo.tenants t
      join nucleo.membros m on m.tenant_id = t.id and m.papel = 'owner'
      where t.slug = ${slug}`;
    if (!t) throw new Error(`empresa ${slug} não existe: rode piloto:implantar primeiro`);
    const fatos = await sql`
      select id, visibilidade from cerebro.fatos where tenant_id = ${t.id} and status = 'proposto'`;
    for (const f of fatos) {
      await sql`select cerebro.revisar_fato(${t.id}, ${f.id}, ${t.dono}, 'ativar')`;
    }
    const orientacoes = await sql`
      select id from atendimento.orientacoes where tenant_id = ${t.id} and status = 'proposta'`;
    for (const o of orientacoes) {
      await sql`select atendimento.revisar_orientacao(${t.id}, ${o.id}, ${t.dono}, 'ativar')`;
    }
    console.log(
      `Aprovados como dona: ${fatos.length} fato(s), ${orientacoes.length} orientação(ões).`,
    );
  } else {
    const pacote = pacoteDoSegmento(segmento);
    const token = await sql.begin(async (tx) => {
      await tx`delete from nucleo.tenants where slug = ${slug}`;
      await tx`delete from auth.users where email = ${emailDono}`;
      const [tenant] = await tx`
        insert into nucleo.tenants (nome, slug, segmento)
        values (${nome ?? `Empresa ${segmento}`}, ${slug}, ${segmento}) returning id`;
      const [dono] = await tx`
        insert into auth.users (id, instance_id, aud, role, email)
        values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
                'authenticated', 'authenticated', ${emailDono})
        returning id`;
      await tx`
        insert into nucleo.membros (tenant_id, user_id, papel)
        values (${tenant.id}, ${dono.id}, 'owner')`;

      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const novo = "foco_" + btoa(String.fromCharCode(...bytes))
        .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(novo));
      const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      await tx`
        insert into nucleo.credenciais (tenant_id, nome, perfil, hash)
        values (${tenant.id}, 'hermes', 'equipe', ${hash})`;
      return novo;
    });

    // O Hermes do piloto passa a falar com esta empresa.
    const envUrl = new URL("./hermes/.env", import.meta.url);
    let anterior = "";
    try {
      anterior = await Deno.readTextFile(envUrl);
    } catch { /* primeira execução */ }
    const manter = (chave: string) => anterior.match(new RegExp(`^${chave}=(.*)$`, "m"))?.[1] ?? "";
    await Deno.writeTextFile(
      envUrl,
      `# Gerado por piloto/implantar.ts. Não versionar.\n` +
        `OPENROUTER_API_KEY=${manter("OPENROUTER_API_KEY")}\n` +
        `HERMES_MODELO=${manter("HERMES_MODELO")}\n` +
        `FOCO_MCP_TOKEN=${token}\n`,
      { mode: 0o600 },
    );
    console.log(`Empresa criada: ${nome ?? slug} (segmento ${segmento}), sem nenhum conhecimento.`);
    console.log(
      `Roteiro: ${pacote.perguntas.length} perguntas e ` +
        `${pacote.orientacoes_padrao?.length ?? 0} orientações sugeridas para o segmento.`,
    );
    console.log("Credencial do Hermes gravada em piloto/hermes/.env");
  }
} finally {
  await sql.end({ timeout: 2 });
}

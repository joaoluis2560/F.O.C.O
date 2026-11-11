// CLI do construtor de conectores.
//
// deno task construtor \
//   --openapi ferramentas/erp-simulado/openapi.json \
//   --base-url http://127.0.0.1:8787 --permite-http \
//   --auth bearer --segredo-env ERP_TOKEN \
//   --exemplos ferramentas/erp-simulado/exemplos.json \
//   --saida rascunhos/erp-simulado
//
// Grava um arquivo por capacidade e um relatorio.json. Não publica no banco e
// não aprova nada: a revisão humana vem depois.

import { parseArgs } from "@std/cli/parse-args";
import type {
  Catalogo,
  Integracao,
  TipoAuth,
} from "../../supabase/functions/_shared/conectores/tipos.ts";
import { construir, type Exemplo } from "./construtor.ts";
import { criarGeradorClaude } from "./gerador_claude.ts";

const a = parseArgs(Deno.args, {
  string: [
    "openapi",
    "base-url",
    "auth",
    "cabecalho-auth",
    "usuario",
    "segredo-env",
    "exemplos",
    "saida",
    "catalogo",
    "so",
    "modelo",
  ],
  boolean: ["permite-http", "testar-escrita"],
  default: { auth: "nenhuma", catalogo: "supabase/functions/_shared/catalogo/capacidades.json" },
});

function exigir(nome: "openapi" | "base-url" | "saida"): string {
  const valor = a[nome];
  if (!valor) {
    console.error(`faltou --${nome}`);
    Deno.exit(2);
  }
  return valor;
}

const openapi = await Deno.readTextFile(exigir("openapi"));
const saida = exigir("saida");
const catalogo = JSON.parse(await Deno.readTextFile(a.catalogo)) as Catalogo;
const exemplos: Record<string, Exemplo> = a.exemplos
  ? JSON.parse(await Deno.readTextFile(a.exemplos))
  : {};

const integracao: Integracao = {
  base_url: exigir("base-url"),
  permite_http: a["permite-http"],
  tipo_auth: a.auth as TipoAuth,
  auth_config: { cabecalho: a["cabecalho-auth"], usuario: a.usuario },
};
// O segredo é lido de uma variável de ambiente indicada pelo nome; nunca de argumento.
const segredo = a["segredo-env"] ? Deno.env.get(a["segredo-env"]) : undefined;
if (integracao.tipo_auth !== "nenhuma" && !segredo) {
  console.error("autenticação exige --segredo-env com o NOME de uma variável definida");
  Deno.exit(2);
}

const filtro = a.so?.split(",").map((s) => s.trim());
const capacidades = catalogo.capacidades.filter((c) => !filtro || filtro.includes(c.nome));

const rascunhos = await construir({
  capacidades,
  openapi,
  integracao,
  segredo,
  exemplos,
  gerar: criarGeradorClaude({ modelo: a.modelo }),
  testar_escrita: a["testar-escrita"],
});

await Deno.mkdir(saida, { recursive: true });
for (const r of rascunhos) {
  if (r.definicao) {
    await Deno.writeTextFile(
      `${saida}/${r.capacidade}.json`,
      JSON.stringify(r.definicao, null, 2) + "\n",
    );
  }
  console.log(`${r.estado.padEnd(12)} ${r.capacidade}  (${r.tentativas}x)  ${r.motivo}`);
}
await Deno.writeTextFile(
  `${saida}/relatorio.json`,
  JSON.stringify(
    { catalogo_versao: catalogo.versao, base_url: integracao.base_url, rascunhos },
    null,
    2,
  ) + "\n",
);
if (rascunhos.some((r) => r.estado === "falhou")) Deno.exit(1);

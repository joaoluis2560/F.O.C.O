// Gera um token de acesso ao servidor MCP e o comando SQL que registra o hash.
// O token aparece uma única vez, aqui; o banco guarda só o SHA-256.
//
// deno task credencial --tenant <uuid> --nome hermes --perfil equipe

import { parseArgs } from "@std/cli/parse-args";

const a = parseArgs(Deno.args, { string: ["tenant", "nome", "perfil"] });

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
if (
  !a.tenant || !uuid.test(a.tenant) ||
  !a.nome || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.nome) ||
  (a.perfil !== "atendimento" && a.perfil !== "equipe")
) {
  console.error("uso: --tenant <uuid> --nome <minusculas-com-hifen> --perfil atendimento|equipe");
  Deno.exit(2);
}

const bytes = crypto.getRandomValues(new Uint8Array(32));
const token = "foco_" + btoa(String.fromCharCode(...bytes))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");

console.log("Token (guarde agora; não é possível recuperá-lo depois):");
console.log(token);
console.log("\nSQL para registrar a credencial:");
console.log(
  `insert into nucleo.credenciais (tenant_id, nome, perfil, hash)\n` +
    `values ('${a.tenant}', '${a.nome}', '${a.perfil}', '${hash}');`,
);

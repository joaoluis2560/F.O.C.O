// Liga o disparo automático do worker no ambiente local: grava no Vault o
// endereço da função e o JWT de serviço do Supabase local.
// Pré-requisito: `supabase start` com o runtime de funções no ar.
//
// deno task agendar:local            (liga)
// deno task agendar:local desligar   (remove os segredos; o disparo vira no-op)

// @ts-types="npm:postgres@3.4.5"
import postgres from "postgres";

const url = Deno.env.get("FOCO_DB_URL");
if (!url || !/@(127\.0\.0\.1|localhost):/.test(url)) {
  console.error("FOCO_DB_URL deve apontar para o Postgres local (use `deno task agendar:local`)");
  Deno.exit(2);
}
const desligar = Deno.args[0] === "desligar";
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

try {
  await sql`delete from vault.secrets where name in ('foco_worker_url', 'foco_worker_jwt')`;
  if (desligar) {
    console.log("Disparo automático desligado.");
  } else {
    // O JWT de serviço local é lido do próprio contêiner do runtime; não é exibido.
    const saida = await new Deno.Command("docker", {
      args: ["exec", "supabase_edge_runtime_foco", "printenv", "SUPABASE_SERVICE_ROLE_KEY"],
      stdout: "piped",
      stderr: "null",
    }).output();
    const jwt = new TextDecoder().decode(saida.stdout).trim();
    if (!saida.success || !jwt) {
      throw new Error("runtime de funções fora do ar: rode `supabase start`");
    }
    // Endereço visto de dentro da rede do Docker, onde o banco roda.
    const destino = "http://kong:8000/functions/v1/atendimento-worker";
    await sql`select vault.create_secret(${destino}, 'foco_worker_url')`;
    await sql`select vault.create_secret(${jwt}, 'foco_worker_jwt')`;
    console.log(`Disparo automático ligado: a cada 5 s, quando houver lote pronto -> ${destino}`);
  }
} finally {
  await sql.end({ timeout: 2 });
}

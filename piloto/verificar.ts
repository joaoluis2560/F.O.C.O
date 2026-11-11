// Confere o lado do F.O.C.O no piloto, fazendo as mesmas chamadas MCP que o
// Hermes fará: handshake, lista de ferramentas e uma consulta de cada tipo.
// Pré-requisitos: deno task erp-simulado, deno task mcp-local, deno task piloto:preparar.

const env = await Deno.readTextFile(new URL("./hermes/.env", import.meta.url));
const token = env.match(/^FOCO_MCP_TOKEN=(.+)$/m)?.[1];
if (!token) {
  console.error("piloto/hermes/.env sem FOCO_MCP_TOKEN; rode `deno task piloto:preparar`");
  Deno.exit(2);
}
const URL_MCP = "http://127.0.0.1:8790/mcp";

let id = 0;
async function rpc(method: string, params?: unknown) {
  const resposta = await fetch(URL_MCP, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  if (!resposta.ok) throw new Error(`${method}: HTTP ${resposta.status}`);
  const corpo = await resposta.json();
  if (corpo.error) throw new Error(`${method}: ${corpo.error.message}`);
  return corpo.result;
}
async function chamar(name: string, args: Record<string, unknown>) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
}

let falhas = 0;
async function passo(nome: string, fn: () => Promise<string>) {
  try {
    console.log(`ok     ${nome}: ${await fn()}`);
  } catch (erro) {
    falhas++;
    console.log(`FALHOU ${nome}: ${erro instanceof Error ? erro.message : erro}`);
  }
}

await passo("handshake", async () => {
  const r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  return `${r.serverInfo.name} ${r.serverInfo.version}, protocolo ${r.protocolVersion}`;
});
await passo("ferramentas", async () => {
  const { tools } = await rpc("tools/list");
  const nomes: string[] = tools.map((t: { name: string }) => t.name);
  if (nomes.includes("pedidos_criar")) throw new Error("escrita exposta");
  return nomes.join(", ");
});
await passo("cérebro (regra interna)", async () => {
  const { fatos } = await chamar("cerebro_buscar", { pergunta: "qual o desconto máximo?" });
  if (!fatos.length) throw new Error("nenhum fato encontrado");
  return fatos[0].titulo;
});
await passo("cérebro (informação pública)", async () => {
  const { fatos } = await chamar("cerebro_buscar", { pergunta: "que horas a loja abre?" });
  if (!fatos.length) throw new Error("nenhum fato encontrado");
  return fatos[0].texto;
});
await passo("estoque e preço", async () => {
  const { itens } = await chamar("produtos_consultar", { termo: "parafusadeira" });
  const estoque = await chamar("estoque_consultar", { produto_id: itens[0].produto_id });
  return `${itens[0].nome}: R$ ${itens[0].preco}, ${estoque.disponivel} disponíveis`;
});
await passo("cliente pelo telefone e cobranças", async () => {
  const cliente = await chamar("clientes_identificar", { telefone: "5511999990001" });
  const { titulos } = await chamar("financeiro_titulos_em_aberto", {
    cliente_id: cliente.cliente_id,
  });
  return `${cliente.nome}: ${titulos.length} título(s) em aberto`;
});

console.log(falhas ? `\n${falhas} passo(s) falharam` : "\nLado do F.O.C.O pronto para o Hermes.");
Deno.exit(falhas ? 1 : 0);

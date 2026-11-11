// Servidor MCP do F.O.C.O (HTTP, sem estado, só leitura).
//
// Sequência de cada chamada:
//   1. valida o token e resolve tenant e perfil no banco;
//   2. monta as ferramentas que aquele perfil pode ver;
//   3. resolve a identidade do cliente final a partir de uma sessão aberta no
//      banco pela entrada do canal; nunca de argumento escolhido pelo modelo
//      nem de telefone informado por quem chama;
//   4. executa (busca no cérebro ou conector aprovado) e registra.
//
// Capacidades de escrita não são expostas aqui: elas dependem do fluxo de
// aprovação humana.

import { type Dominio, DOMINIOS } from "../cerebro/tipos.ts";
import { executarConector } from "../conectores/executor.ts";
import type { Capacidade, Catalogo, Contexto, Json, Resultado } from "../conectores/tipos.ts";
import type { ConectorAtivo, Credencial, Perfil, Repositorio } from "./repositorio.ts";

export interface Dependencias {
  repo: Repositorio;
  catalogo: Catalogo;
  /** Substituível em teste. */
  executar?: typeof executarConector;
}

const VERSOES = ["2025-06-18", "2025-03-26", "2024-11-05"];
/** Limite do corpo da requisição, em bytes. */
export const MAX_CORPO = 100_000;
export const CABECALHO_SESSAO = "x-foco-sessao";
/** Cabeçalho antigo: telefone informado por quem chama. Não é mais aceito. */
const CABECALHO_CONTATO_LEGADO = "x-foco-contato";
const FORMATO_SESSAO = /^foco_s_[A-Za-z0-9_-]{43}$/;
const IDENTIFICAR = "clientes.identificar";
const FERRAMENTA_CEREBRO = "cerebro_buscar";

const INSTRUCOES: Record<Perfil, string> = {
  atendimento:
    "Ferramentas da empresa para atender um cliente final. As consultas de pedidos e cobranças " +
    "já estão limitadas ao cliente desta conversa. Responda só com o que as ferramentas " +
    "devolverem; quando não houver informação, diga que vai encaminhar para a equipe.",
  equipe: "Ferramentas da empresa para apoiar a equipe interna. A busca no cérebro inclui regras " +
    "internas, que não devem ser repassadas a clientes. Para consultar dados de um cliente, " +
    "identifique-o primeiro pelo telefone e use o cliente_id devolvido.",
};

export interface Ferramenta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean };
}

// Tudo que este servidor expõe é leitura. Clientes como o Hermes usam a marca
// para não pedir confirmação a cada chamada e para repetir com segurança.
const SO_LEITURA = { readOnlyHint: true };

export type ResultadoFerramenta = { content: { type: "text"; text: string }[]; isError?: boolean };

const nomeFerramenta = (capacidade: string) => capacidade.replace(".", "_");

export async function sha256Hex(texto: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function json(corpo: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

const erroRpc = (id: unknown, code: number, message: string, status = 200) =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);

const texto = (valor: unknown, isError = false): ResultadoFerramenta => ({
  content: [{ type: "text", text: typeof valor === "string" ? valor : JSON.stringify(valor) }],
  ...(isError && { isError: true }),
});

/** Capacidades que o perfil pode chamar, dentre as que têm conector aprovado. */
function capacidadesVisiveis(
  perfil: Perfil,
  catalogo: Catalogo,
  conectores: ConectorAtivo[],
): Capacidade[] {
  const comConector = new Set(conectores.map((c) => c.capacidade));
  return catalogo.capacidades.filter((cap) =>
    cap.tipo === "leitura" &&
    comConector.has(cap.nome) &&
    // No atendimento a identificação é feita pelo servidor, não pelo modelo.
    !(perfil === "atendimento" && cap.nome === IDENTIFICAR)
  );
}

function esquemaDeEntrada(perfil: Perfil, cap: Capacidade): Record<string, unknown> {
  if (perfil !== "equipe" || cap.identidade !== "cliente") return cap.entrada;
  const base = cap.entrada as { properties?: Record<string, unknown>; required?: string[] };
  return {
    ...cap.entrada,
    properties: {
      ...base.properties,
      cliente_id: {
        type: "string",
        minLength: 1,
        maxLength: 64,
        description: "Identificador do cliente, obtido com clientes_identificar.",
      },
    },
    required: [...(base.required ?? []), "cliente_id"],
  };
}

function listarFerramentas(perfil: Perfil, capacidades: Capacidade[]): Ferramenta[] {
  const cerebro: Ferramenta = {
    name: FERRAMENTA_CEREBRO,
    description: perfil === "atendimento"
      ? "Busca informações da empresa que podem ser ditas ao cliente: horários, políticas, " +
        "formas de pagamento, entrega, procedimentos. Use antes de responder qualquer dúvida " +
        "sobre a empresa."
      : "Busca no conhecimento da empresa, incluindo regras e procedimentos internos.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pergunta"],
      properties: {
        pergunta: {
          type: "string",
          minLength: 2,
          maxLength: 300,
          description: "A dúvida, com as palavras que o cliente usou.",
        },
        dominio: { type: "string", enum: [...DOMINIOS] },
      },
    },
    annotations: SO_LEITURA,
  };
  return [
    cerebro,
    ...capacidades.map((cap) => ({
      name: nomeFerramenta(cap.nome),
      description: cap.descricao,
      inputSchema: esquemaDeEntrada(perfil, cap),
      annotations: SO_LEITURA,
    })),
  ];
}

interface Chamada {
  cred: Credencial;
  deps: Dependencias;
  conectores: ConectorAtivo[];
  /** Telefone do cliente final, resolvido no banco a partir da sessão. */
  contato: string | null;
}

async function rodarConector(
  c: Chamada,
  cap: Capacidade,
  entrada: Json,
  contexto: Contexto,
): Promise<Resultado> {
  const conector = c.conectores.find((x) => x.capacidade === cap.nome)!;
  const segredo = conector.integracao.tipo_auth === "nenhuma"
    ? undefined
    : await c.deps.repo.lerSegredo(c.cred.tenant_id, conector.integracao_id) ?? undefined;
  const resultado = await (c.deps.executar ?? executarConector)({
    capacidade: cap,
    integracao: conector.integracao,
    definicao: conector.definicao,
    entrada,
    contexto,
    segredo,
  });
  await c.deps.repo.registrarExecucao(c.cred.tenant_id, conector.conector_id, cap.nome, resultado);
  return resultado;
}

/** Resolve o cliente final pelo telefone da sessão. Null se não encontrado. */
async function identificarContato(c: Chamada): Promise<string | null> {
  if (!c.contato) return null;
  const cap = c.deps.catalogo.capacidades.find((x) => x.nome === IDENTIFICAR);
  if (!cap || !c.conectores.some((x) => x.capacidade === IDENTIFICAR)) return null;
  const r = await rodarConector(c, cap, { telefone: c.contato }, {});
  if (!r.ok) return null;
  const saida = r.saida as { encontrado?: boolean; cliente_id?: string };
  return saida.encontrado && saida.cliente_id ? saida.cliente_id : null;
}

async function chamarFerramenta(
  c: Chamada,
  nome: unknown,
  argumentos: unknown,
): Promise<ResultadoFerramenta> {
  const args = (argumentos ?? {}) as Record<string, Json>;
  if (typeof nome !== "string" || typeof args !== "object" || Array.isArray(args)) {
    return texto("chamada de ferramenta inválida", true);
  }

  if (nome === FERRAMENTA_CEREBRO) {
    const pergunta = args.pergunta;
    const dominio = args.dominio ?? null;
    if (typeof pergunta !== "string" || pergunta.trim().length < 2 || pergunta.length > 300) {
      return texto("informe a pergunta (2 a 300 caracteres)", true);
    }
    if (dominio !== null && !(DOMINIOS as readonly unknown[]).includes(dominio)) {
      return texto("domínio desconhecido", true);
    }
    const fatos = await c.deps.repo.buscarFatos(
      c.cred.tenant_id,
      c.cred.perfil,
      pergunta,
      dominio as Dominio | null,
    );
    return texto({ fatos });
  }

  const cap = capacidadesVisiveis(c.cred.perfil, c.deps.catalogo, c.conectores)
    .find((x) => nomeFerramenta(x.nome) === nome);
  if (!cap) return texto("ferramenta desconhecida", true);

  let entrada: Json = args;
  const contexto: Contexto = {};
  if (cap.identidade === "cliente") {
    if (c.cred.perfil === "atendimento") {
      const clienteId = await identificarContato(c);
      if (!clienteId) {
        return texto(
          "Não foi possível localizar o cadastro deste cliente. Encaminhe para a equipe.",
          true,
        );
      }
      contexto.cliente_id = clienteId;
    } else {
      const { cliente_id, ...resto } = args;
      if (typeof cliente_id !== "string" || !cliente_id || cliente_id.length > 64) {
        return texto("informe cliente_id, obtido com clientes_identificar", true);
      }
      contexto.cliente_id = cliente_id;
      entrada = resto;
    }
  }

  const r = await rodarConector(c, cap, entrada, contexto);
  return r.ok ? texto(r.saida) : texto(`${r.erro.codigo}: ${r.erro.mensagem}`, true);
}

/**
 * Lê o corpo até `max` bytes. Devolve null se passar do limite, sem acumular
 * o excedente: a leitura é cancelada assim que o limite é ultrapassado.
 */
export async function lerCorpoLimitado(req: Request, max: number): Promise<string | null> {
  const declarado = Number(req.headers.get("content-length"));
  if (Number.isFinite(declarado) && declarado > max) {
    await req.body?.cancel();
    return null;
  }
  if (!req.body) return "";
  const leitor = req.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await leitor.cancel();
      return null;
    }
    partes.push(value);
  }
  const tudo = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    tudo.set(p, pos);
    pos += p.byteLength;
  }
  return new TextDecoder().decode(tudo);
}

export async function tratarMcp(req: Request, deps: Dependencias): Promise<Response> {
  if (req.method !== "POST") {
    return json({ error: "use POST" }, 405, { allow: "POST" });
  }

  // 1. Credencial -> tenant e perfil, resolvidos no banco.
  const autorizacao = req.headers.get("authorization") ?? "";
  const token = autorizacao.startsWith("Bearer ") ? autorizacao.slice(7).trim() : "";
  const cred = token ? await deps.repo.identificarCredencial(await sha256Hex(token)) : null;
  if (!cred) {
    return json({ error: "não autorizado" }, 401, { "www-authenticate": "Bearer" });
  }

  const bruto = await lerCorpoLimitado(req, MAX_CORPO);
  if (bruto === null) return erroRpc(null, -32600, "requisição grande demais", 413);
  let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(bruto);
  } catch {
    return erroRpc(null, -32700, "JSON inválido", 400);
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0") {
    return erroRpc(null, -32600, "mensagem JSON-RPC inválida", 400);
  }
  // Notificações e respostas do cliente não têm retorno.
  if (typeof msg.method !== "string" || msg.id === undefined) {
    return new Response(null, { status: 202 });
  }
  const ok = (result: unknown) => json({ jsonrpc: "2.0", id: msg.id, result });

  switch (msg.method) {
    case "initialize": {
      const pedida = msg.params?.protocolVersion;
      return ok({
        protocolVersion: VERSOES.includes(pedida as string) ? pedida : VERSOES[0],
        capabilities: { tools: {} },
        serverInfo: { name: "foco", version: "0.1.0" },
        instructions: INSTRUCOES[cred.perfil],
      });
    }
    case "ping":
      return ok({});
    case "tools/list": {
      const conectores = await deps.repo.conectoresAprovados(cred.tenant_id);
      const capacidades = capacidadesVisiveis(cred.perfil, deps.catalogo, conectores);
      return ok({ tools: listarFerramentas(cred.perfil, capacidades) });
    }
    case "tools/call": {
      if (req.headers.has(CABECALHO_CONTATO_LEGADO)) {
        return erroRpc(
          msg.id,
          -32602,
          `${CABECALHO_CONTATO_LEGADO} não é aceito; use ${CABECALHO_SESSAO}`,
        );
      }
      // Sessão só vale para o perfil de atendimento; no perfil equipe é ignorada.
      let contato: string | null = null;
      const sessao = req.headers.get(CABECALHO_SESSAO);
      if (cred.perfil === "atendimento" && sessao !== null) {
        contato = FORMATO_SESSAO.test(sessao)
          ? await deps.repo.contatoDaSessao(cred.tenant_id, await sha256Hex(sessao))
          : null;
        // Falha fechada: sessão informada mas inválida derruba a chamada inteira,
        // para o runtime perceber em vez de seguir sem identidade.
        if (contato === null) return erroRpc(msg.id, -32602, "sessão inválida ou expirada");
      }
      const chamada: Chamada = {
        cred,
        deps,
        conectores: await deps.repo.conectoresAprovados(cred.tenant_id),
        contato,
      };
      return ok(await chamarFerramenta(chamada, msg.params?.name, msg.params?.arguments));
    }
    default:
      return erroRpc(msg.id, -32601, "método não suportado");
  }
}

// Uso em processo (sem HTTP) pelo agente de atendimento. As mesmas regras de
// perfil valem; o `contato` vem da entrada do canal, que é quem sabe de quem é
// a mensagem.

/** Ferramentas que o perfil da credencial pode usar neste tenant. */
export async function ferramentasDe(deps: Dependencias, cred: Credencial): Promise<Ferramenta[]> {
  const conectores = await deps.repo.conectoresAprovados(cred.tenant_id);
  return listarFerramentas(
    cred.perfil,
    capacidadesVisiveis(cred.perfil, deps.catalogo, conectores),
  );
}

export async function executarFerramenta(
  deps: Dependencias,
  cred: Credencial,
  contato: string | null,
  nome: string,
  argumentos: unknown,
): Promise<ResultadoFerramenta> {
  const chamada: Chamada = {
    cred,
    deps,
    conectores: await deps.repo.conectoresAprovados(cred.tenant_id),
    contato: cred.perfil === "atendimento" ? contato : null,
  };
  return chamarFerramenta(chamada, nome, argumentos);
}

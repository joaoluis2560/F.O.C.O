// Servidor MCP do F.O.C.O (HTTP, sem estado).
// Consulta o cérebro e o sistema da empresa. No perfil equipe também registra
// propostas (fato novo, orientação de atendimento), que só valem depois de
// aprovadas por owner ou admin: nenhum agente ativa nada por aqui.
//
// Sequência de cada chamada:
//   1. valida o token e resolve tenant e perfil no banco;
//   2. monta as ferramentas que aquele perfil pode ver;
//   3. resolve a identidade do cliente final a partir de uma sessão aberta no
//      banco pela entrada do canal; nunca de argumento escolhido pelo modelo
//      nem de telefone informado por quem chama;
//   4. executa (busca no cérebro ou conector aprovado) e registra.
//
// Capacidades de escrita no sistema da empresa não são expostas aqui: elas
// dependem do fluxo de aprovação humana.

import { pacoteDoSegmento } from "../catalogo/pacotes.ts";
import { fonteDaPergunta, type Pacote, perguntaDaFonte } from "../cerebro/pacote.ts";
import { type Dominio, DOMINIOS, TIPOS_FATO } from "../cerebro/tipos.ts";
import { executarConector } from "../conectores/executor.ts";
import type { Capacidade, Catalogo, Contexto, Json, Resultado } from "../conectores/tipos.ts";
import {
  type CategoriaOrientacao,
  type ConectorAtivo,
  type Credencial,
  FilaDeRevisaoCheia,
  type Perfil,
  type Repositorio,
} from "./repositorio.ts";

export interface Dependencias {
  repo: Repositorio;
  catalogo: Catalogo;
  /** Substituível em teste. */
  executar?: typeof executarConector;
  /** Roteiro de implantação por segmento. Substituível em teste. */
  pacote?: (segmento: string | null) => Pacote;
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
const PROPOR_FATO = "cerebro_propor_fato";
const PROPOR_ORIENTACAO = "atendimento_propor_orientacao";
const PENDENTES = "propostas_pendentes";
const IMPLANTACAO = "implantacao_pendencias";
const NAO_SE_APLICA = "implantacao_nao_se_aplica";
/** Quantas perguntas são entregues por vez ao agente que conduz a entrevista. */
const PERGUNTAS_POR_VEZ = 4;
const CATEGORIAS: CategoriaOrientacao[] = ["tom", "limite", "transferir"];
const AVISO_REVISAO = "Proposta registrada. Só passa a valer depois que o dono ou um " +
  "administrador da empresa aprovar na fila de revisão.";

const INSTRUCOES: Record<Perfil, string> = {
  atendimento:
    "Ferramentas da empresa para atender um cliente final. As consultas de pedidos e cobranças " +
    "já estão limitadas ao cliente desta conversa. Responda só com o que as ferramentas " +
    "devolverem; quando não houver informação, diga que vai encaminhar para a equipe.",
  equipe: "Ferramentas da empresa para apoiar a equipe interna. A busca no cérebro inclui regras " +
    "internas, que não devem ser repassadas a clientes. Para consultar dados de um cliente, " +
    "identifique-o primeiro pelo telefone e use o cliente_id devolvido. Quando a equipe ensinar " +
    "algo novo sobre a empresa ou sobre como atender, registre como proposta: ela vai para a " +
    "fila de revisão e só vale depois de aprovada por uma pessoa.",
  implantacao: "Ferramentas para entrevistar o dono durante a implantação da empresa. Tudo que " +
    "for registrado é proposta e só vale depois de aprovado por ele na fila de revisão.",
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
  // A entrevista de implantação não consulta o sistema da empresa.
  if (perfil === "implantacao") return [];
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
  // Implantação: só registra propostas e acompanha o roteiro. Sem busca no
  // cérebro e sem consulta ao sistema da empresa.
  if (perfil === "implantacao") return FERRAMENTAS_DE_PROPOSTA;
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
    ...(perfil === "equipe" ? FERRAMENTAS_DE_PROPOSTA : []),
  ];
}

// Perfis equipe e implantacao. Criam propostas; nunca alteram o que está valendo.
const FERRAMENTAS_DE_PROPOSTA: Ferramenta[] = [
  {
    name: PROPOR_FATO,
    description: "Propõe um fato novo para o conhecimento da empresa (uma regra, um horário, " +
      "um procedimento que a equipe informou). Use quando alguém da equipe ensinar algo que não " +
      "está no cérebro. O fato fica aguardando aprovação do dono ou administrador.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["texto"],
      properties: {
        titulo: { type: "string", minLength: 3, maxLength: 200 },
        texto: {
          type: "string",
          minLength: 3,
          maxLength: 4000,
          description: "O fato completo, com valores e condições exatos, como a equipe informou.",
        },
        dominio: { type: "string", enum: [...DOMINIOS] },
        visibilidade: {
          type: "string",
          enum: ["publico", "interno"],
          description: "Sugestão: publico se pode ser dito a clientes, interno se é só da equipe.",
        },
        chaves: {
          type: "array",
          maxItems: 8,
          items: { type: "string", maxLength: 60 },
          description: "Palavras que um cliente usaria ao perguntar sobre isso.",
        },
        pergunta_id: {
          type: "string",
          maxLength: 80,
          description: "Quando o fato responde a uma pergunta de implantacao_pendencias, o id " +
            "dela. Título, domínio e visibilidade passam a ser os da pergunta, e as chaves dela " +
            "são somadas às suas.",
        },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: PROPOR_ORIENTACAO,
    description: "Propõe uma orientação sobre como o atendimento automático deve se comportar " +
      "com clientes desta empresa: tom (jeito de falar), limite (o que não fazer ou prometer) " +
      "ou transferir (quando chamar uma pessoa). Fica aguardando aprovação.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["texto"],
      properties: {
        categoria: { type: "string", enum: CATEGORIAS },
        texto: { type: "string", minLength: 3, maxLength: 600 },
        justificativa: {
          type: "string",
          maxLength: 600,
          description: "Por que propor isso: quem pediu ou o que aconteceu.",
        },
        pergunta_id: {
          type: "string",
          maxLength: 80,
          description: "Id da pergunta ou da orientação sugerida em implantacao_pendencias, " +
            "quando for o caso. A categoria vem dela se você não informar.",
        },
      },
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: IMPLANTACAO,
    description: "Mostra o andamento da implantação desta empresa: quantas perguntas do roteiro " +
      "do segmento dela já foram respondidas, as próximas a fazer e as orientações de partida " +
      "sugeridas para o segmento. Use para conduzir a entrevista com o dono: pergunte poucas " +
      "coisas por vez e registre cada resposta com o pergunta_id correspondente.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: SO_LEITURA,
  },
  {
    name: PENDENTES,
    description: "Lista o que está aguardando aprovação do dono ou administrador (fatos e " +
      "orientações propostos). Use para lembrar a equipe de revisar.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: SO_LEITURA,
  },
  {
    name: NAO_SE_APLICA,
    description: "Marca uma pergunta do roteiro de implantação como não aplicável a esta " +
      "empresa, para ela não voltar a ser feita. Use quando o dono disser que aquilo não existe " +
      "na empresa dele (por exemplo, não vende aquele tipo de produto).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["pergunta_id"],
      properties: { pergunta_id: { type: "string", maxLength: 80 } },
    },
    annotations: { readOnlyHint: false },
  },
];

const texto_ = (v: unknown, min: number, max: number): v is string =>
  typeof v === "string" && v.trim().length >= min && v.length <= max;

/** Roteiro do segmento e o que dele já foi respondido. */
async function andamentoDaImplantacao(c: Chamada): Promise<{
  pacote: Pacote;
  respondidas: Set<string>;
}> {
  const { segmento, respondidas } = await c.deps.repo.implantacao(c.cred.tenant_id);
  return {
    pacote: (c.deps.pacote ?? pacoteDoSegmento)(segmento),
    respondidas: new Set(respondidas.map(perguntaDaFonte).filter((id): id is string => !!id)),
  };
}

async function chamarProposta(
  c: Chamada,
  nome: string,
  args: Record<string, Json>,
): Promise<ResultadoFerramenta> {
  const tenant = c.cred.tenant_id;
  try {
    if (nome === PENDENTES) return texto(await c.deps.repo.propostasPendentes(tenant));

    const { pacote, respondidas } = await andamentoDaImplantacao(c);
    if (nome === IMPLANTACAO) {
      const abertas = pacote.perguntas.filter((p) => !respondidas.has(p.id));
      const sugeridas = (pacote.orientacoes_padrao ?? []).filter((o) => !respondidas.has(o.id));
      return texto({
        segmento: pacote.segmento ?? "geral",
        perguntas_no_roteiro: pacote.perguntas.length,
        respondidas: pacote.perguntas.length - abertas.length,
        proximas_perguntas: abertas.slice(0, PERGUNTAS_POR_VEZ).map((p) => ({
          pergunta_id: p.id,
          pergunta: p.pergunta,
          registrar_com: p.orientacao ? PROPOR_ORIENTACAO : PROPOR_FATO,
          ...(p.orientacao
            ? { categoria: p.orientacao }
            : { visibilidade_sugerida: p.visibilidade }),
        })),
        // O dono costuma responder fora de ordem: com o id em mãos, a resposta
        // fica ligada à pergunta certa e ela não volta a ser feita.
        outras_perguntas_em_aberto: abertas.slice(PERGUNTAS_POR_VEZ).map((p) => ({
          pergunta_id: p.id,
          assunto: p.titulo,
        })),
        orientacoes_sugeridas_para_o_segmento: sugeridas.map((o) => ({
          pergunta_id: o.id,
          categoria: o.categoria,
          texto: o.texto,
        })),
        como_usar: "Faça as próximas perguntas ao dono, poucas por vez. Registre cada resposta " +
          "com a ferramenta indicada e o pergunta_id. Apresente as orientações sugeridas e " +
          "registre as que ele aceitar, com o texto ajustado se ele pedir. Se uma pergunta não " +
          `se aplicar à empresa, marque com ${NAO_SE_APLICA}. Se ele adiantar a resposta de uma ` +
          "das outras perguntas em aberto, registre com o pergunta_id dela.",
      });
    }

    // Resposta a uma pergunta do roteiro: confere o id e marca a origem.
    const perguntaId = args.pergunta_id ?? null;
    const pergunta = pacote.perguntas.find((p) => p.id === perguntaId);
    const sugerida = pacote.orientacoes_padrao?.find((o) => o.id === perguntaId);
    if (perguntaId !== null && !pergunta && !sugerida) {
      return texto("pergunta_id não existe no roteiro desta empresa", true);
    }
    const fonte = perguntaId === null ? undefined : fonteDaPergunta(pacote, perguntaId as string);

    if (nome === NAO_SE_APLICA) {
      // Só perguntas: orientação sugerida que o dono não quer simplesmente não é registrada.
      if (!pergunta) return texto("informe o pergunta_id de uma pergunta do roteiro", true);
      await c.deps.repo.ignorarPergunta(tenant, pergunta.id);
      return texto("Anotado: esta pergunta não será mais feita para esta empresa.");
    }

    if (nome === PROPOR_FATO) {
      if (pergunta?.orientacao || sugerida) {
        return texto(`esta pergunta é registrada com ${PROPOR_ORIENTACAO}`, true);
      }
      // Resposta a uma pergunta do roteiro: título, domínio e visibilidade são os
      // do roteiro, que foi revisado, e as chaves dele vêm primeiro. O agente só
      // decide esses campos em fato fora do roteiro.
      const titulo = pergunta?.titulo ?? args.titulo ?? null;
      const dominio = pergunta?.dominio ?? args.dominio ?? "geral";
      const visibilidade = pergunta?.visibilidade ?? args.visibilidade ?? "interno";
      const doAgente = args.chaves ?? [];
      const chaves = pergunta && Array.isArray(doAgente)
        ? [...new Set([...pergunta.chaves, ...doAgente])].slice(0, 8)
        : doAgente;
      if (!texto_(titulo, 3, 200) || !texto_(args.texto, 3, 4000)) {
        return texto("informe titulo (3 a 200 caracteres) e texto (3 a 4000)", true);
      }
      if (!(DOMINIOS as readonly unknown[]).includes(dominio)) {
        return texto("domínio desconhecido", true);
      }
      // Um agente não propõe fato restrito: isso é decisão de quem administra.
      if (visibilidade !== "publico" && visibilidade !== "interno") {
        return texto("visibilidade deve ser publico ou interno", true);
      }
      if (!Array.isArray(chaves) || chaves.length > 8 || chaves.some((k) => !texto_(k, 1, 60))) {
        return texto("chaves deve ser uma lista de até 8 textos curtos", true);
      }
      await c.deps.repo.proporFato(tenant, {
        titulo: titulo.trim(),
        texto: args.texto.trim(),
        dominio: dominio as Dominio,
        visibilidade,
        chaves: chaves as string[],
        ...(pergunta && (TIPOS_FATO as readonly string[]).includes(pergunta.tipo) &&
          { tipo: pergunta.tipo }),
        ...(fonte && { fonte }),
      });
      return texto(AVISO_REVISAO);
    }

    if (pergunta && !pergunta.orientacao) {
      return texto(`esta pergunta é registrada com ${PROPOR_FATO}`, true);
    }
    const categoria =
      (args.categoria ?? pergunta?.orientacao ?? sugerida?.categoria) as CategoriaOrientacao;
    if (!CATEGORIAS.includes(categoria)) {
      return texto("categoria deve ser tom, limite ou transferir", true);
    }
    if (!texto_(args.texto, 3, 600)) return texto("informe o texto (3 a 600 caracteres)", true);
    const justificativa = args.justificativa ?? null;
    if (justificativa !== null && !texto_(justificativa, 0, 600)) {
      return texto("justificativa longa demais", true);
    }
    await c.deps.repo.proporOrientacao(tenant, categoria, args.texto.trim(), justificativa, fonte);
    return texto(AVISO_REVISAO);
  } catch (erro) {
    if (erro instanceof FilaDeRevisaoCheia) {
      return texto(
        "A fila de revisão está cheia. Peça ao dono ou administrador para revisar as " +
          "propostas pendentes antes de registrar novas.",
        true,
      );
    }
    throw erro;
  }
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

  if (c.cred.perfil !== "atendimento" && FERRAMENTAS_DE_PROPOSTA.some((f) => f.name === nome)) {
    return chamarProposta(c, nome, args);
  }
  // Daqui para baixo nada é oferecido ao perfil de implantação.
  if (c.cred.perfil === "implantacao") return texto("ferramenta desconhecida", true);

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

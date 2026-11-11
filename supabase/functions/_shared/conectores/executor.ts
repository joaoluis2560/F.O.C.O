// Executor determinístico de conectores. Nenhum modelo de linguagem aqui:
// valida a entrada, monta a requisição, chama o sistema do tenant, mapeia a
// resposta e valida a saída contra a capacidade canônica.

import { Validator } from "@cfworker/json-schema";
import jsonata from "jsonata";
import { preencherCaminho, preencherJson, preencherTexto, type Variaveis } from "./modelo.ts";
import { type ResolvedorDns, validarDestino } from "./seguranca.ts";
import {
  type Capacidade,
  type Contexto,
  type DefinicaoConector,
  ErroConector,
  type Integracao,
  type Json,
  type Resultado,
} from "./tipos.ts";

export interface Execucao {
  capacidade: Capacidade;
  integracao: Integracao;
  definicao: DefinicaoConector;
  /** Argumentos escolhidos pelo modelo. Validados contra capacidade.entrada. */
  entrada: Json;
  /** Dados resolvidos pelo servidor (identidade do cliente). */
  contexto: Contexto;
  /** Valor do segredo, lido do Vault por quem chama. Nunca é registrado. */
  segredo?: string;
  /** Obrigatório para capacidade de escrita: aprovação humana já conferida. */
  aprovado?: boolean;
  chave_idempotencia?: string;
  opcoes?: {
    timeout_ms?: number;
    max_bytes?: number;
    fetch?: typeof fetch;
    resolver_dns?: ResolvedorDns;
  };
}

const METODOS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const CABECALHOS_RESERVADOS = new Set([
  "authorization",
  "cookie",
  "host",
  "content-length",
  "proxy-authorization",
  "idempotency-key",
]);

/** Confere a forma da definição. Usado pelo executor e pelo construtor. */
export function validarDefinicao(def: unknown, capacidade: Capacidade): DefinicaoConector {
  const erro = (m: string): never => {
    throw new ErroConector("definicao_invalida", m);
  };
  const d = def as DefinicaoConector;
  if (!d || typeof d !== "object" || !d.requisicao || !d.resposta) {
    return erro("definição precisa de requisicao e resposta");
  }
  const r = d.requisicao;
  if (!METODOS.has(r.metodo)) erro("método HTTP inválido");
  if (capacidade.tipo === "leitura" && r.metodo !== "GET") {
    erro("capacidade de leitura só pode usar GET");
  }
  if (capacidade.tipo === "escrita" && r.metodo === "GET") {
    erro("capacidade de escrita não pode usar GET");
  }
  if (typeof r.caminho !== "string" || !r.caminho.startsWith("/")) {
    erro("caminho deve começar com /");
  }
  for (const [nome, mapa] of [["query", r.query], ["cabecalhos", r.cabecalhos]] as const) {
    if (mapa === undefined) continue;
    if (typeof mapa !== "object" || mapa === null || Array.isArray(mapa)) {
      erro(`${nome} deve ser objeto`);
    }
    if (Object.values(mapa).some((v) => typeof v !== "string")) {
      erro(`${nome} só aceita valores de texto`);
    }
  }
  for (const nome of Object.keys(r.cabecalhos ?? {})) {
    if (CABECALHOS_RESERVADOS.has(nome.toLowerCase())) erro(`cabeçalho reservado: ${nome}`);
  }
  const temCorpo = r.corpo !== undefined && r.corpo !== null;
  if (temCorpo && r.corpo_mapeamento !== undefined) {
    erro("use corpo ou corpo_mapeamento, não os dois");
  }
  if (r.metodo === "GET" && (temCorpo || r.corpo_mapeamento !== undefined)) {
    erro("GET não aceita corpo");
  }
  if (r.corpo_mapeamento !== undefined) {
    try {
      jsonata(r.corpo_mapeamento);
    } catch {
      erro("requisicao.corpo_mapeamento não é JSONata válido");
    }
  }
  if (typeof d.resposta.mapeamento !== "string" || d.resposta.mapeamento.trim() === "") {
    erro("resposta.mapeamento é obrigatório");
  }
  try {
    jsonata(d.resposta.mapeamento);
  } catch {
    erro("resposta.mapeamento não é JSONata válido");
  }
  for (const status of Object.keys(d.resposta.por_status ?? {})) {
    if (!/^[1-5]\d\d$/.test(status)) erro(`status inválido em por_status: ${status}`);
  }
  return d;
}

function validarEsquema(esquema: Record<string, unknown>, valor: unknown): string | null {
  const r = new Validator(esquema, "2020-12", false).validate(valor);
  if (r.valid) return null;
  // Só o local do problema: a mensagem não pode carregar dado pessoal.
  const locais = [...new Set(r.errors.map((e) => e.instanceLocation))].slice(0, 5);
  return locais.join(", ");
}

function cabecalhosDeAuth(integracao: Integracao, segredo?: string): Record<string, string> {
  if (integracao.tipo_auth === "nenhuma") return {};
  if (!segredo) throw new ErroConector("definicao_invalida", "integração exige segredo");
  switch (integracao.tipo_auth) {
    case "bearer":
      return { authorization: `Bearer ${segredo}` };
    case "basic":
      return {
        authorization: "Basic " + btoa(`${integracao.auth_config.usuario ?? ""}:${segredo}`),
      };
    case "cabecalho": {
      const nome = integracao.auth_config.cabecalho;
      if (!nome) throw new ErroConector("definicao_invalida", "auth_config.cabecalho ausente");
      return { [nome]: segredo };
    }
  }
}

async function lerComLimite(resposta: Response, maxBytes: number): Promise<string> {
  if (!resposta.body) return "";
  const leitor = resposta.body.getReader();
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await leitor.cancel();
      throw new ErroConector("resposta_grande", `resposta maior que ${maxBytes} bytes`);
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

export async function executarConector(e: Execucao): Promise<Resultado> {
  const inicio = performance.now();
  const duracao = () => Math.round(performance.now() - inicio);
  let status: number | undefined;

  try {
    const def = validarDefinicao(e.definicao, e.capacidade);

    const erroEntrada = validarEsquema(e.capacidade.entrada, e.entrada);
    if (erroEntrada !== null) {
      throw new ErroConector("entrada_invalida", `entrada fora do esquema em: ${erroEntrada}`);
    }
    if (e.capacidade.identidade === "cliente" && !e.contexto.cliente_id) {
      throw new ErroConector("identidade_ausente", "cliente não identificado pelo servidor");
    }
    if (e.capacidade.tipo === "escrita" && e.aprovado !== true) {
      throw new ErroConector("aprovacao_ausente", "escrita exige aprovação humana");
    }

    const vars: Variaveis = { entrada: e.entrada, contexto: e.contexto };
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(def.requisicao.query ?? {})) {
      query.set(k, preencherTexto(v, vars));
    }
    const url = await validarDestino(
      e.integracao,
      preencherCaminho(def.requisicao.caminho, vars),
      query,
      e.opcoes?.resolver_dns,
    );

    const cabecalhos = new Headers({ accept: "application/json" });
    for (const [k, v] of Object.entries(def.requisicao.cabecalhos ?? {})) {
      cabecalhos.set(k, preencherTexto(v, vars));
    }
    for (const [k, v] of Object.entries(cabecalhosDeAuth(e.integracao, e.segredo))) {
      cabecalhos.set(k, v);
    }
    let corpo: string | undefined;
    if (def.requisicao.corpo_mapeamento !== undefined) {
      try {
        corpo = JSON.stringify(await jsonata(def.requisicao.corpo_mapeamento).evaluate(vars));
      } catch {
        throw new ErroConector("mapeamento_falhou", "erro ao montar o corpo da requisição");
      }
    } else if (def.requisicao.corpo !== undefined && def.requisicao.corpo !== null) {
      corpo = JSON.stringify(preencherJson(def.requisicao.corpo, vars));
    }
    if (corpo !== undefined) cabecalhos.set("content-type", "application/json");
    if (e.capacidade.tipo === "escrita" && e.chave_idempotencia) {
      cabecalhos.set("idempotency-key", e.chave_idempotencia);
    }

    let resposta: Response;
    try {
      resposta = await (e.opcoes?.fetch ?? fetch)(url, {
        method: def.requisicao.metodo,
        headers: cabecalhos,
        body: corpo,
        redirect: "manual",
        signal: AbortSignal.timeout(e.opcoes?.timeout_ms ?? 10_000),
      });
    } catch (causa) {
      const nome = causa instanceof Error ? causa.name : "";
      if (nome === "TimeoutError" || nome === "AbortError") {
        throw new ErroConector("tempo_esgotado", "sistema do tenant não respondeu a tempo");
      }
      throw new ErroConector("falha_de_rede", "falha ao conectar no sistema do tenant");
    }
    status = resposta.status;

    const fixo = def.resposta.por_status?.[String(status)];
    let saida: Json;
    if (fixo !== undefined) {
      await resposta.body?.cancel();
      saida = fixo;
    } else {
      if (status < 200 || status >= 300) {
        await resposta.body?.cancel();
        throw new ErroConector("http_erro", `sistema do tenant respondeu ${status}`);
      }
      const texto = await lerComLimite(resposta, e.opcoes?.max_bytes ?? 1_000_000);
      let dados: unknown;
      try {
        dados = JSON.parse(texto);
      } catch {
        throw new ErroConector("resposta_invalida", "resposta não é JSON");
      }
      try {
        saida = await jsonata(def.resposta.mapeamento).evaluate(dados, vars) as Json;
      } catch {
        throw new ErroConector("mapeamento_falhou", "erro ao aplicar o mapeamento");
      }
    }

    const erroSaida = validarEsquema(e.capacidade.saida, saida);
    if (erroSaida !== null) {
      throw new ErroConector("saida_invalida", `saída fora do esquema em: ${erroSaida || "/"}`);
    }
    return { ok: true, saida, status_http: status, duracao_ms: duracao() };
  } catch (causa) {
    const erro = causa instanceof ErroConector
      ? { codigo: causa.codigo, mensagem: causa.message }
      : { codigo: "definicao_invalida" as const, mensagem: "erro inesperado no executor" };
    return { ok: false, erro, status_http: status, duracao_ms: duracao() };
  }
}

/** Códigos que indicam conector quebrado (e não entrada ruim ou rede). */
export function indicaDegradacao(r: Resultado): boolean {
  return !r.ok &&
    ["saida_invalida", "mapeamento_falhou", "resposta_invalida"].includes(r.erro.codigo);
}

/** SHA-256 da definição em JSON canônico (chaves ordenadas). */
export async function hashDefinicao(def: DefinicaoConector): Promise<string> {
  const canonico = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canonico) : v !== null && typeof v === "object"
      ? Object.fromEntries(
        Object.keys(v).sort().map((k) => [k, canonico((v as Record<string, unknown>)[k])]),
      )
      : v;
  const bytes = new TextEncoder().encode(JSON.stringify(canonico(def)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

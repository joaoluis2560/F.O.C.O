// Proteção contra SSRF: o conector só fala com o host da integração, por
// https, e nunca com endereços internos.

import { ErroConector, type Integracao } from "./tipos.ts";

export type ResolvedorDns = (host: string) => Promise<string[]>;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function ipv4Privado(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224;
}

function ipv6Privado(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::" || v === "::1") return true;
  const mapeado = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapeado) return ipv4Privado(mapeado[1]);
  if (v.startsWith("::ffff:")) return true;
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
}

/** Verdadeiro para IP literal interno ou nome reservado a rede interna. */
export function enderecoInterno(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (LOOPBACK.has(h)) return true;
  if (h.includes(":")) return ipv6Privado(h);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return ipv4Privado(h);
  // Formas numéricas alternativas de IPv4 (decimal, hexadecimal, octal).
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/.test(h)) return true;
  return h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost") ||
    !h.includes(".");
}

async function resolverPadrao(host: string): Promise<string[]> {
  const ips: string[] = [];
  for (const tipo of ["A", "AAAA"] as const) {
    try {
      ips.push(...await Deno.resolveDns(host, tipo));
    } catch {
      // Sem registro deste tipo, ou resolução indisponível: o fetch decide.
    }
  }
  return ips;
}

/**
 * Monta a URL final e garante que ela continua dentro da integração.
 * Lança ErroConector("destino_bloqueado") em qualquer desvio.
 */
export async function validarDestino(
  integracao: Integracao,
  caminho: string,
  query: URLSearchParams,
  resolver: ResolvedorDns = resolverPadrao,
): Promise<URL> {
  const bloquear = (motivo: string): never => {
    throw new ErroConector("destino_bloqueado", motivo);
  };

  let base: URL;
  try {
    base = new URL(integracao.base_url);
  } catch {
    return bloquear("base_url inválida");
  }
  if (base.username || base.password) bloquear("base_url não pode conter credenciais");
  if (!caminho.startsWith("/")) bloquear("caminho deve começar com /");
  if (caminho.includes("\\") || caminho.includes("//") || /[?#]/.test(caminho)) {
    bloquear("caminho com caractere proibido");
  }
  if (caminho.split("/").some((s) => s === "." || s === "..")) {
    bloquear("caminho não pode subir de diretório");
  }

  const url = new URL(base.origin + base.pathname.replace(/\/$/, "") + caminho);
  url.search = query.toString();
  if (url.origin !== base.origin) bloquear("destino fora do host da integração");

  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol === "http:") {
    if (!(integracao.permite_http && loopback)) bloquear("http só é aceito em loopback local");
    return url;
  }
  if (url.protocol !== "https:") bloquear("protocolo não suportado");
  if (enderecoInterno(url.hostname)) bloquear("destino em rede interna");

  const ips = await resolver(url.hostname);
  if (ips.some((ip) => enderecoInterno(ip))) bloquear("host resolve para rede interna");
  return url;
}

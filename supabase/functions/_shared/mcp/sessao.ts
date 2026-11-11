// Token de sessão de atendimento. Gerado pela entrada do canal (o webhook que
// recebe a mensagem e sabe de quem ela veio), registrado no banco por
// nucleo.abrir_sessao_atendimento e entregue ao agente no cabeçalho x-foco-sessao.

export interface TokenSessao {
  /** Entregue ao agente. Nunca é gravado. */
  token: string;
  /** SHA-256 em hexadecimal, gravado no banco. */
  hash: string;
}

export async function gerarTokenSessao(): Promise<TokenSessao> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = "foco_s_" + btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { token, hash };
}

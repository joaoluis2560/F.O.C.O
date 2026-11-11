// Nível 0 do roteador: decisões que não precisam de modelo. Função pura.

export interface ConfigAtendimento {
  modo: "sombra" | "producao";
  modelo_barato: string;
  modelo_forte: string;
  teto_diario_usd: number;
  limite_contato_hora: number;
  instrucoes: string | null;
}

export interface Situacao {
  texto: string;
  anexos: number;
  /** Uma pessoa da equipe já respondeu nesta conversa. */
  humano: boolean;
  gasto_dia_usd: number;
  mensagens_contato_hora: number;
}

export type DecisaoSemModelo =
  | { acao: "ignorar"; motivo: string }
  | { acao: "transferir"; motivo: string; texto: string };

const AVISO_TRANSFERENCIA = "Vou chamar uma pessoa da equipe para continuar seu atendimento.";

/** Devolve a decisão quando uma regra resolve; null quando é caso para o modelo. */
export function decidirSemModelo(s: Situacao, config: ConfigAtendimento): DecisaoSemModelo | null {
  if (s.humano) return { acao: "ignorar", motivo: "humano_assumiu" };
  if (s.mensagens_contato_hora > config.limite_contato_hora) {
    return { acao: "ignorar", motivo: "limite_do_contato" };
  }
  const texto = s.texto.trim();
  if (!texto && s.anexos > 0) {
    // Áudio, imagem e arquivo ainda não são interpretados.
    return { acao: "transferir", motivo: "midia_nao_suportada", texto: AVISO_TRANSFERENCIA };
  }
  if (!texto) return { acao: "ignorar", motivo: "mensagem_vazia" };
  if (s.gasto_dia_usd >= config.teto_diario_usd) {
    return { acao: "transferir", motivo: "teto_diario", texto: AVISO_TRANSFERENCIA };
  }
  return null;
}

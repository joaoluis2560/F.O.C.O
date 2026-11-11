// Worker do atendimento: pega um lote da fila, decide (regra, modelo barato ou
// modelo forte), entrega no canal e registra o custo.

import type { Catalogo } from "../conectores/tipos.ts";
import type { Credencial, Repositorio } from "../mcp/repositorio.ts";
import { executarFerramenta, ferramentasDe } from "../mcp/servidor.ts";
import { atender } from "./agente.ts";
import type { ClienteCanal } from "./chatwoot.ts";
import type { ClienteModelo } from "./modelo.ts";
import {
  type Canal,
  execucaoDePasso,
  type Lote,
  type RegistroExecucao,
  type RepositorioAtendimento,
} from "./repositorio.ts";
import { decidirSemModelo } from "./roteador.ts";

export interface DependenciasWorker {
  repo: RepositorioAtendimento;
  /** Cérebro e conectores, pelo mesmo núcleo do servidor MCP. */
  nucleo: Repositorio;
  catalogo: Catalogo;
  modelo: ClienteModelo;
  /** Cria o cliente do canal a partir do cadastro e do token lido do Vault. */
  canal: (canal: Canal, token: string) => ClienteCanal;
  /** Segundos de silêncio antes de responder (o cliente pode estar digitando). */
  espera_seg?: number;
}

export interface ResultadoLote {
  conversa_id: string;
  acao: "responder" | "transferir" | "ignorar";
  motivo: string;
  nivel: 0 | 1 | 2;
  custo_usd: number;
  sombra: boolean;
}

const regra = (motivo: string, resultado: string): RegistroExecucao => ({
  nivel: 0,
  modelo: null,
  motivo,
  tokens_entrada: 0,
  tokens_cache: 0,
  tokens_saida: 0,
  custo_usd: 0,
  duracao_ms: 0,
  resultado,
});

async function entregar(
  canal: ClienteCanal,
  lote: Lote,
  sombra: boolean,
  acao: "responder" | "transferir",
  texto: string,
  motivo: string,
): Promise<boolean> {
  if (sombra) {
    // Modo sombra: nada vai para o cliente. A equipe vê a sugestão e decide.
    const rotulo = acao === "responder" ? "Sugestão do agente" : "O agente transferiria";
    await canal.notaInterna(
      lote.conversa_externa,
      acao === "responder" ? `${rotulo}:\n${texto}` : `${rotulo}. Motivo: ${motivo}`,
    );
    return false;
  }
  await canal.enviar(lote.conversa_externa, texto);
  if (acao === "transferir") {
    await canal.notaInterna(lote.conversa_externa, `Transferido pelo agente. Motivo: ${motivo}`);
    await canal.transferir(lote.conversa_externa);
  }
  return true;
}

/** Processa um lote. Devolve null quando a fila está vazia. */
export async function processarProximoLote(d: DependenciasWorker): Promise<ResultadoLote | null> {
  const lote = await d.repo.reivindicarLote(d.espera_seg ?? 8);
  if (!lote) return null;
  const { tenant_id, conversa_id } = lote;

  const config = await d.repo.config(tenant_id);
  if (!config) {
    await d.repo.concluirLote(lote.mensagem_ids, "ignorada");
    return {
      conversa_id,
      acao: "ignorar",
      motivo: "tenant_sem_config",
      nivel: 0,
      custo_usd: 0,
      sombra: true,
    };
  }
  const sombra = config.modo === "sombra";
  const base = { conversa_id, sombra };

  try {
    const uso = await d.repo.usoAtual(tenant_id, conversa_id);
    const semModelo = decidirSemModelo({
      texto: lote.texto,
      anexos: lote.anexos,
      humano: lote.humano,
      ...uso,
    }, config);

    if (semModelo?.acao === "ignorar") {
      await d.repo.registrarExecucao(
        tenant_id,
        conversa_id,
        sombra,
        regra(semModelo.motivo, "ignorou"),
      );
      await d.repo.concluirLote(lote.mensagem_ids, "ignorada");
      return { ...base, acao: "ignorar", motivo: semModelo.motivo, nivel: 0, custo_usd: 0 };
    }

    const cadastro = await d.repo.canalDoLote(tenant_id, lote.canal_id);
    const token = cadastro && await d.repo.lerSegredoCanal(tenant_id, lote.canal_id);
    if (!cadastro || !token) throw new Error("canal inativo ou sem segredo");
    const canal = d.canal(cadastro, token);

    if (semModelo) {
      const enviado = await entregar(
        canal,
        lote,
        sombra,
        "transferir",
        semModelo.texto,
        semModelo.motivo,
      );
      if (enviado) await d.repo.registrarSaida(tenant_id, conversa_id, semModelo.texto);
      await d.repo.registrarExecucao(
        tenant_id,
        conversa_id,
        sombra,
        regra(semModelo.motivo, "transferiu"),
      );
      await d.repo.concluirLote(lote.mensagem_ids, "concluida");
      return { ...base, acao: "transferir", motivo: semModelo.motivo, nivel: 0, custo_usd: 0 };
    }

    // Identidade do cliente: o telefone veio do canal, não do modelo.
    const cred: Credencial = { credencial_id: "agente", tenant_id, perfil: "atendimento" };
    const nucleo = { repo: d.nucleo, catalogo: d.catalogo };
    const desfecho = await atender({
      modelo: d.modelo,
      config,
      ferramentas: await ferramentasDe(nucleo, cred),
      executar: (nome, args) => executarFerramenta(nucleo, cred, lote.contato, nome, args),
      historico: await d.repo.historico(tenant_id, conversa_id),
      texto: lote.texto,
    });

    // Custo primeiro: mesmo que a entrega falhe, o gasto já aconteceu.
    for (const passo of desfecho.passos) {
      await d.repo.registrarExecucao(tenant_id, conversa_id, sombra, execucaoDePasso(passo));
    }
    const enviado = await entregar(
      canal,
      lote,
      sombra,
      desfecho.acao,
      desfecho.texto,
      desfecho.motivo,
    );
    if (enviado) await d.repo.registrarSaida(tenant_id, conversa_id, desfecho.texto);
    await d.repo.concluirLote(lote.mensagem_ids, "concluida");

    const ultimo = desfecho.passos[desfecho.passos.length - 1];
    return {
      ...base,
      acao: desfecho.acao,
      motivo: desfecho.motivo,
      nivel: ultimo.nivel,
      custo_usd: desfecho.passos.reduce((s, p) => s + p.uso.custo_usd, 0),
    };
  } catch (erro) {
    // O lote fica em processamento; o prazo vence e ele volta para a fila
    // (até três tentativas). Só o motivo é registrado, sem conteúdo.
    await d.repo.registrarExecucao(
      tenant_id,
      conversa_id,
      sombra,
      regra(
        `erro: ${erro instanceof Error ? erro.message.slice(0, 200) : "desconhecido"}`,
        "falhou",
      ),
    );
    throw erro;
  }
}

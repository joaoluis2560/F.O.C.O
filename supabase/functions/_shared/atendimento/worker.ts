// Worker do atendimento: pega um lote da fila, decide (regra, modelo barato ou
// modelo forte), entrega no canal e registra o custo.
//
// O mesmo worker conduz a entrevista de implantação. O que muda é a finalidade
// do canal: no de implantação só o telefone do cadastro é atendido, o agente
// usa o perfil que registra propostas, e a resposta sempre vai para quem
// escreveu (não existe modo sombra para falar com o dono).
//
// Garantias:
//   * Só o worker que reivindicou o lote o renova, entrega e conclui. Antes de
//     cada chamada de modelo e de cada etapa de entrega o prazo é renovado; se
//     a renovação falhar, outro worker assumiu e este para sem enviar nada.
//   * A decisão é gravada antes do envio. Uma nova tentativa retoma a entrega
//     de onde parou: não chama o modelo de novo e não reenvia ao cliente uma
//     mensagem que pode já ter chegado.
//   * Cada chamada de modelo reserva orçamento antes de acontecer.

import type { Catalogo } from "../conectores/tipos.ts";
import type { Credencial, Repositorio } from "../mcp/repositorio.ts";
import { executarFerramenta, ferramentasDe } from "../mcp/servidor.ts";
import { atender, ErroControle, type Turno } from "./agente.ts";
import { type ClienteCanal, ErroCanal } from "./chatwoot.ts";
import { dividir, resumir } from "./contexto.ts";
import { type ClienteModelo, type Uso, USO_ZERO } from "./modelo.ts";
import {
  type Canal,
  type CanalDoLote,
  type Entrega,
  execucaoDePasso,
  type Lote,
  type RegistroExecucao,
  type RepositorioAtendimento,
} from "./repositorio.ts";
import { type ConfigAtendimento, decidirSemModelo } from "./roteador.ts";

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

/**
 * Prazo da reivindicação. Uma chamada de modelo leva até 45 s e é sempre
 * precedida de renovação, então o prazo só vence se o worker morrer.
 */
const LEASE_SEG = 180;

const SO_TEXTO = "Por enquanto só consigo ler texto. Pode escrever sua resposta?";

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

/** Renova o prazo do lote ou interrompe: sem a reivindicação, nada mais é feito. */
async function manterLote(d: DependenciasWorker, lote: Lote): Promise<void> {
  if (!await d.repo.renovarLote(lote.mensagem_ids, lote.reivindicacao, LEASE_SEG)) {
    throw new ErroControle("reivindicacao_perdida");
  }
}

/**
 * Cliente de modelo usado dentro de um lote: renova a reivindicação e reserva
 * orçamento antes de cada chamada, e troca a reserva pelo custo real depois.
 */
function modeloControlado(
  d: DependenciasWorker,
  lote: Lote,
  config: ConfigAtendimento,
): ClienteModelo {
  return async (pedido) => {
    await manterLote(d, lote);
    const reserva = pedido.modelo === config.modelo_forte
      ? config.reserva_forte_usd
      : config.reserva_barato_usd;
    if (!await d.repo.reservarOrcamento(lote.tenant_id, reserva)) throw new ErroControle("teto");
    let gasto = 0;
    try {
      const r = await d.modelo(pedido);
      gasto = r.uso.custo_usd;
      return r;
    } finally {
      await d.repo.liquidarOrcamento(lote.tenant_id, reserva, gasto);
    }
  };
}

/**
 * Histórico que segue para o agente. Se a conversa passou do limite, resume os
 * turnos antigos com o modelo barato e guarda o resumo. Falha ao resumir não
 * impede o atendimento: seguem só os turnos recentes, e tenta-se de novo depois.
 */
async function prepararContexto(
  d: DependenciasWorker,
  modelo: ClienteModelo,
  lote: Lote,
  config: ConfigAtendimento,
  sombra: boolean,
): Promise<{ resumo: string | null; historico: Turno[] }> {
  const { tenant_id, conversa_id } = lote;
  const { resumo, turnos } = await d.repo.contexto(tenant_id, conversa_id);
  const { antigos, recentes } = dividir(turnos);
  if (antigos.length === 0) return { resumo, historico: recentes };

  const inicio = performance.now();
  const registrar = (resultado: string, uso: Uso, motivo: string) =>
    d.repo.registrarExecucao(tenant_id, conversa_id, sombra, {
      nivel: 1,
      modelo: config.modelo_barato,
      motivo,
      ...uso,
      duracao_ms: Math.round(performance.now() - inicio),
      resultado,
    });
  try {
    const novo = await resumir(modelo, config.modelo_barato, resumo, antigos);
    if (!novo.texto) {
      // A chamada aconteceu e custou: o custo é registrado mesmo sem resumo.
      await registrar("falhou", novo.uso, "resumo_de_contexto: resumo vazio");
      return { resumo, historico: recentes };
    }
    await d.repo.salvarResumo(tenant_id, conversa_id, novo.texto, antigos[antigos.length - 1].id);
    await registrar("resumiu", novo.uso, "resumo_de_contexto");
    return { resumo: novo.texto, historico: recentes };
  } catch (erro) {
    if (erro instanceof ErroControle && erro.codigo === "reivindicacao_perdida") throw erro;
    const motivo = erro instanceof Error ? erro.message.slice(0, 120) : "erro";
    await registrar("falhou", USO_ZERO, `resumo_de_contexto: ${motivo}`);
    return { resumo, historico: recentes };
  }
}

/**
 * Telefone de quem escreveu. Vem do canal, nunca do modelo: se o webhook não o
 * trouxe, é lido direto do canal com a nossa credencial.
 */
async function contatoDoLote(
  d: DependenciasWorker,
  lote: Lote,
  cadastro: CanalDoLote,
  token: string,
): Promise<string | null> {
  if (lote.contato) return lote.contato;
  try {
    const contato = await d.canal(cadastro, token).telefoneDaConversa(lote.conversa_externa);
    if (contato) await d.repo.salvarContato(lote.tenant_id, lote.conversa_id, contato);
    return contato;
  } catch {
    return null;
  }
}

type Etapa = "enviar" | "nota" | "transferir";

function etapasDe(e: Entrega): Etapa[] {
  // Modo sombra: nada vai para o cliente. A equipe vê a sugestão e decide.
  if (e.sombra) return ["nota"];
  return e.acao === "responder" ? ["enviar"] : ["enviar", "nota", "transferir"];
}

function textoDaNota(e: Entrega): string {
  if (!e.sombra) return `Transferido pelo agente. Motivo: ${e.motivo}`;
  return e.acao === "responder"
    ? `Sugestão do agente:\n${e.texto}`
    : `O agente transferiria. Motivo: ${e.motivo}`;
}

/**
 * Executa as etapas de entrega que faltam. Cada etapa é marcada como "em
 * andamento" antes da chamada e como concluída depois. Se uma tentativa
 * anterior morreu com o envio ao cliente em andamento, não se sabe se a
 * mensagem chegou: ela não é reenviada, e a equipe é avisada.
 */
async function entregar(
  d: DependenciasWorker,
  canal: ClienteCanal,
  lote: Lote,
  entrega: Entrega,
): Promise<void> {
  const etapas = etapasDe(entrega);
  const conversa = lote.conversa_externa;

  for (let i = entrega.etapa; i < etapas.length; i++) {
    const etapa = etapas[i];
    const incerta = entrega.em_andamento && i === entrega.etapa;

    await manterLote(d, lote);
    if (incerta && etapa === "enviar") {
      await d.repo.marcarEntrega(entrega.id, { etapa: i + 1, em_andamento: false, incerta: true });
      await d.repo.registrarExecucao(
        lote.tenant_id,
        lote.conversa_id,
        entrega.sombra,
        regra("entrega_incerta", "nao_reenviou"),
      );
      try {
        await canal.notaInterna(
          conversa,
          `Atenção: a resposta abaixo pode não ter chegado ao cliente. Confira a conversa.\n` +
            entrega.texto,
        );
      } catch {
        // Aviso de melhor esforço: a falha dele não muda o desfecho.
      }
      continue;
    }

    await d.repo.marcarEntrega(entrega.id, { em_andamento: true });
    try {
      if (etapa === "enviar") await canal.enviar(conversa, entrega.texto);
      else if (etapa === "nota") await canal.notaInterna(conversa, textoDaNota(entrega));
      else await canal.transferir(conversa);
    } catch (erro) {
      // O canal recusou: com certeza não foi entregue, pode tentar de novo.
      if (erro instanceof ErroCanal && erro.nao_entregue) {
        await d.repo.marcarEntrega(entrega.id, { em_andamento: false });
      }
      throw erro;
    }
    await d.repo.marcarEntrega(entrega.id, { etapa: i + 1, em_andamento: false });
    if (etapa === "enviar") {
      await d.repo.registrarSaida(lote.tenant_id, lote.conversa_id, entrega.texto);
    }
  }
}

/** Processa um lote. Devolve null quando a fila está vazia. */
export async function processarProximoLote(d: DependenciasWorker): Promise<ResultadoLote | null> {
  const lote = await d.repo.reivindicarLote(d.espera_seg ?? 8, LEASE_SEG);
  if (!lote) return null;
  const { tenant_id, conversa_id } = lote;

  const config = await d.repo.config(tenant_id);
  if (!config) {
    await d.repo.concluirLote(lote.mensagem_ids, lote.reivindicacao, "ignorada");
    return {
      conversa_id,
      acao: "ignorar",
      motivo: "tenant_sem_config",
      nivel: 0,
      custo_usd: 0,
      sombra: true,
    };
  }
  const cadastro = await d.repo.canalDoLote(tenant_id, lote.canal_id);
  const implantacao = cadastro?.finalidade === "implantacao";
  // Na implantação quem escreve é o dono, e ele precisa receber a resposta.
  const sombra = config.modo === "sombra" && !implantacao;
  const base = { conversa_id, sombra };

  try {
    // Tentativa anterior já decidiu? Então só falta entregar.
    let entrega = await d.repo.buscarEntrega(tenant_id, conversa_id, lote.mensagem_ids[0]);
    let nivel: 0 | 1 | 2 = 0;
    let custo = 0;

    if (!entrega) {
      // Canal de implantação: antes de qualquer regra ou modelo, confere se quem
      // escreve é o telefone do cadastro. Qualquer outro fica sem resposta.
      let contato = lote.contato;
      if (implantacao) {
        const token = await d.repo.lerSegredoCanal(tenant_id, lote.canal_id);
        if (!token) throw new Error("canal inativo ou sem segredo");
        contato = await contatoDoLote(d, lote, cadastro, token);
        if (!await d.repo.podeImplantar(tenant_id, contato)) {
          await d.repo.registrarExecucao(
            tenant_id,
            conversa_id,
            sombra,
            regra("contato_nao_autorizado", "ignorou"),
          );
          await d.repo.concluirLote(lote.mensagem_ids, lote.reivindicacao, "ignorada");
          return {
            ...base,
            acao: "ignorar",
            motivo: "contato_nao_autorizado",
            nivel: 0,
            custo_usd: 0,
          };
        }
      }

      const uso = await d.repo.usoAtual(tenant_id, conversa_id);
      const semModelo = decidirSemModelo(
        { texto: lote.texto, anexos: lote.anexos, humano: lote.humano, ...uso },
        // O dono responde muitas mensagens seguidas durante a entrevista: o limite
        // por contato não se aplica a ele. O teto diário continua valendo.
        implantacao ? { ...config, limite_contato_hora: Infinity } : config,
      );

      if (semModelo?.acao === "ignorar") {
        await d.repo.registrarExecucao(
          tenant_id,
          conversa_id,
          sombra,
          regra(semModelo.motivo, "ignorou"),
        );
        await d.repo.concluirLote(lote.mensagem_ids, lote.reivindicacao, "ignorada");
        return { ...base, acao: "ignorar", motivo: semModelo.motivo, nivel: 0, custo_usd: 0 };
      }

      let plano: { acao: "responder" | "transferir"; texto: string; motivo: string };
      if (semModelo && implantacao && semModelo.motivo === "midia_nao_suportada") {
        // O dono mandou áudio ou imagem: pedir texto resolve, não precisa de uma pessoa.
        plano = { acao: "responder", texto: SO_TEXTO, motivo: semModelo.motivo };
        await d.repo.registrarExecucao(
          tenant_id,
          conversa_id,
          sombra,
          regra(semModelo.motivo, "respondeu"),
        );
      } else if (semModelo) {
        plano = { acao: "transferir", texto: semModelo.texto, motivo: semModelo.motivo };
        await d.repo.registrarExecucao(
          tenant_id,
          conversa_id,
          sombra,
          regra(semModelo.motivo, "transferiu"),
        );
      } else {
        const token = cadastro && await d.repo.lerSegredoCanal(tenant_id, lote.canal_id);
        if (!cadastro || !token) throw new Error("canal inativo ou sem segredo");
        if (!implantacao) contato = await contatoDoLote(d, lote, cadastro, token);

        const modelo = modeloControlado(d, lote, config);
        const papel = implantacao ? "implantacao" : "atendimento";
        const cred: Credencial = { credencial_id: "agente", tenant_id, perfil: papel };
        const nucleo = { repo: d.nucleo, catalogo: d.catalogo };
        const contexto = await prepararContexto(d, modelo, lote, config, sombra);
        const desfecho = await atender({
          papel,
          modelo,
          config,
          ferramentas: await ferramentasDe(nucleo, cred),
          executar: (nome, args) => executarFerramenta(nucleo, cred, contato, nome, args),
          historico: contexto.historico,
          resumo: contexto.resumo,
          texto: lote.texto,
        });
        for (const passo of desfecho.passos) {
          await d.repo.registrarExecucao(tenant_id, conversa_id, sombra, execucaoDePasso(passo));
        }
        plano = { acao: desfecho.acao, texto: desfecho.texto, motivo: desfecho.motivo };
        nivel = desfecho.passos[desfecho.passos.length - 1].nivel;
        custo = desfecho.passos.reduce((s, p) => s + p.uso.custo_usd, 0);
      }

      // A decisão fica gravada antes de qualquer envio.
      await manterLote(d, lote);
      entrega = await d.repo.criarEntrega(tenant_id, conversa_id, lote.mensagem_ids, {
        ...plano,
        sombra,
      });
    }

    const token = cadastro && await d.repo.lerSegredoCanal(tenant_id, lote.canal_id);
    if (!cadastro || !token) throw new Error("canal inativo ou sem segredo");
    await entregar(d, d.canal(cadastro, token), lote, entrega);

    // Mensagens que chegaram depois da decisão retomada ainda não foram
    // respondidas: voltam para a fila.
    const respondidas = new Set(entrega.mensagem_ids);
    const novas = lote.mensagem_ids.filter((id) => !respondidas.has(id));
    if (novas.length) await d.repo.devolverLote(novas, lote.reivindicacao);
    await d.repo.concluirLote(
      lote.mensagem_ids.filter((id) => respondidas.has(id)),
      lote.reivindicacao,
      "concluida",
    );
    await d.repo.marcarEntrega(entrega.id, { concluida: true });

    return { ...base, acao: entrega.acao, motivo: entrega.motivo, nivel, custo_usd: custo };
  } catch (erro) {
    if (erro instanceof ErroControle && erro.codigo === "reivindicacao_perdida") {
      // Outro worker assumiu o lote: este sai de cena sem tocar em mais nada.
      return {
        ...base,
        acao: "ignorar",
        motivo: "reivindicacao_perdida",
        nivel: 0,
        custo_usd: 0,
      };
    }
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

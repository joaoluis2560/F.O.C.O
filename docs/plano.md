# F.O.C.O — Plano de arquitetura e implementação

## Contexto

O F.O.C.O será um software agêntico multi-tenant para PMEs: o cliente final da PME fala pelo WhatsApp (texto, áudio, imagem), um agente responde usando o **segundo cérebro** da empresa e o **sistema de gestão** dela. Hoje existe algo parecido para um escritório de contabilidade (Supabase `lgcamvuebptpspmlwnyd`), mas o custo de modelo é alto. O objetivo é um fluxo genérico, barato por padrão, com Claude só onde ele paga a conta.

O repositório está vazio (só `README.md`), então tudo abaixo é construção nova.

### O que a pesquisa mudou em relação à ideia inicial

| Ideia inicial | Achado | Decisão (confirmada com você) |
|---|---|---|
| superglue para integrar o ERP | Repositório open-source descontinuado em 26/10/2026 (sem patches de segurança), licença FSL proíbe uso concorrente, produto hospedado virou implantação de NetSuite/Sage/Workday | **Camada de integração própria**, copiando o padrão (IA gera o conector na implantação, humano aprova, produção roda sem IA) |
| Hermes como runtime | É assistente pessoal por "profile" em disco (SQLite), sem multi-tenant, sem autenticação de usuário final, sem roteamento barato/caro por mensagem | **Runtime próprio fino**, estado no Postgres |
| Twilio | — | **Datafy** (API oficial Meta, R$ 49,90/número, webhook no formato Cloud API) + **Chatwoot** para atendimento humano |
| — | — | **1 projeto Supabase, RLS por tenant** |
| — | — | Público: **clientes finais da PME**. Agente lê livremente; **escrita só com aprovação humana** |

### O que reaproveitar do exemplo (como padrão, com `tenant_id` em tudo)

- `cerebro.fatos` + `cerebro.chaves` + view `cerebro.grafo` + `cerebro.revisoes` + `cerebro.materiais`: modelo de fatos tipados com chaves, auditoria e ingestão de material. Busca por `cerebro.buscar(termo, tipo, limite, papel, escopos)` em texto puro, sem pgvector.
- `bia.eventos` + `enfileirar_evento` / `pegar_evento` (SKIP LOCKED, lease, dedupe atômico, partição mensal): fila Postgres.
- `bia_relay.lote` / `reivindicar`: agrupamento de mensagens picadas antes de chamar o modelo.
- `bia.execucoes`: uma linha por chamada de modelo (tokens entrada/cache/saída, modelo, nível, motivo, custo, `sombra`).
- `atendimento.mascarar_cpf`, `bia.travas`, modo `sombra` antes de `producao`.

Dado medido no exemplo: de 1.636 execuções, 1.340 foram resolvidas **sem modelo** (regras); as 296 com modelo custaram ~US$ 0,01 cada com ~9.400 tokens de entrada **sem cache**. Ou seja: regra antes de modelo funciona, e o maior desperdício é prefixo grande não cacheado.

## Arquitetura

```
Cliente final ─ WhatsApp ─ Datafy (Cloud API) ─ Chatwoot (1 conta por tenant)
                                                   │ webhook Agent Bot
                                                   ▼
                                    [canal-chatwoot] valida, resolve tenant, dedupe, enfileira
                                                   ▼
                                    fila Postgres (lote por conversa, ~8 s)
                                                   ▼
                                    [worker] normaliza mídia → roteador → loop do agente
                                       │                │
                         cérebro (Postgres)      executor de conectores ─ ERP do tenant
                                       │                │
                                       ▼                ▼
                           resposta via API Chatwoot / proposta de escrita (nota privada)
```

Tudo em **Supabase** (Postgres, Edge Functions em Deno, Vault, Storage, pg_cron) e TypeScript. Única infraestrutura fora dele: Chatwoot.

### 1. Camada de integração (primeira a ser construída)

Três conceitos:

- **Capacidade canônica**: o que o agente enxerga, igual para toda PME. Ex.: `clientes.identificar`, `produtos.consultar`, `estoque.consultar`, `pedidos.status`, `financeiro.segunda_via`, `agenda.horarios` (leitura); `pedidos.criar`, `agenda.marcar`, `clientes.atualizar` (escrita). Catálogo versionado, organizado por domínio (Vendas, Marketing, Financeiro, Estoque, Clientes, Operação).
- **Integração**: o sistema do tenant (URL base, tipo de autenticação, host permitido, segredo no Vault — nunca em tabela comum).
- **Conector**: definição **declarativa** que implementa uma capacidade em uma integração: esquema de entrada (JSON Schema), requisição HTTP modelo, mapeamento da resposta, `leitura|escrita`, estado `rascunho|aprovado|degradado`, versão e hash.

Fluxo semi-automático (o papel que seria do superglue):

1. **Construtor** (CLI de implantação): recebe OpenAPI/URL de documentação + credencial de sandbox. Claude gera rascunhos de conectores para as capacidades do catálogo.
2. Cada rascunho roda contra o sandbox; a saída é validada contra o esquema canônico.
3. Humano revisa e aprova. Aprovado = congelado.
4. **Produção: executor determinístico, zero IA.** Falha de esquema marca o conector como `degradado` e abre tarefa de reparo (Claude propõe correção, humano aprova). Nada se "auto-conserta" em produção.

Caminho manual: o mesmo formato declarativo escrito à mão. Conectores de ERPs repetidos viram biblioteca reaproveitada entre tenants.

Proteções do executor: host fixo por integração, bloqueio de IP privado (SSRF), timeout, limite de tamanho, idempotência em escrita, log sem segredo e com CPF mascarado.

**Regra de identidade:** em consultas de dado próprio (boleto, pedido), o identificador do cliente vem do servidor (telefone → `clientes.identificar`), nunca de argumento escolhido pelo modelo. Isso impede o cliente A de pedir dado do cliente B.

### 2. Segundo cérebro

Schema `cerebro` generalizado: `fatos` (tenant, domínio, tipo, texto, fonte, visibilidade, status), `chaves`, `grafo`, `materiais`, `revisoes`, `conversas`.

- **Visibilidade** `publico | interno | restrito`. O agente de atendimento só recupera `publico`. Segredos nunca viram fato.
- Busca: full-text em português (`unaccent` + `pg_trgm`) primeiro; pgvector híbrido só se a avaliação mostrar necessidade.
- **Pacote de domínio**: roteiro de perguntas por domínio para povoar o cérebro na implantação (horário, política de troca, formas de pagamento, prazos...). É isso que torna o fluxo aplicável a qualquer PME.
- Aprendizado contínuo: respostas de atendentes humanos no Chatwoot viram **propostas** de fato, com revisão antes de ativar.

### 3. Canal

Chatwoot como hub: o runtime é um **Agent Bot** do Chatwoot. Ganhos: handoff humano pronto (bot muda a conversa para `open`), histórico, e qualquer canal que o Chatwoot suporte entra sem código novo. Interface de canal isolada para permitir adaptador direto Datafy/Meta se o spike mostrar problema.

Webhook: valida segredo, resolve tenant pelo identificador da conta/inbox **no servidor**, dedupe por id da mensagem, enfileira e responde 200 imediatamente.

### 4. Runtime e controle de custo

Roteador em níveis, por lote de mensagens:

- **Nível 0 — regras, sem modelo:** humano já atribuído, fora do horário, opt-out, limite por contato estourado, duplicata.
- **Nível 1 — modelo barato via OpenRouter:** classifica e responde intents simples com ferramentas de leitura. Saída estruturada com campo `escalar` e motivo.
- **Nível 2 — Claude (`claude-sonnet-5-5`):** quando o nível 1 escala, ferramenta falha, há proposta de escrita, ou o domínio é sensível (financeiro).
- **Fora de linha — Claude mais forte:** construtor de conectores e reparo. Custo de implantação, não por mensagem.

Outras alavancas: prefixo estável (prompt do tenant + ferramentas) com **prompt caching**; contexto enxuto (resumo da conversa + só fatos recuperados); áudio transcrito por modelo barato de fala; imagem só passa por visão quando a mensagem depende dela; teto diário por tenant e por contato. Modelo de cada nível fica em tabela de configuração, trocável sem deploy.

Tabela `execucoes` registra cada chamada (modelo, nível, motivo, tokens, cache, custo). **Meta inicial:** 70% dos lotes resolvidos nos níveis 0–1.

"Time de agentes" = configuração, não código: tabela `agentes` (prompt, capacidades permitidas, nível padrão). Começa com um atendente; especialistas por domínio entram como linhas novas.

### 5. Escrita com aprovação

Agente cria `proposta` (capacidade, argumentos, resumo) → nota privada na conversa do Chatwoot → atendente aprova/rejeita → webhook traz o autor → servidor confere membership e papel no tenant → só então executa o conector → resultado volta ao cliente. Proposta expira e é de uso único.

### 6. Segurança (segue o `AGENTS.md`)

RLS em todas as tabelas; cliente privilegiado só depois de resolver tenant e papel no servidor; mensagem do cliente e conteúdo de ferramenta são dados, nunca instrução; permissão de ferramenta aplicada no servidor; testes pgTAP com Tenant A/B e papéis owner/admin/member/inativo/anon; migrations criadas e testadas localmente, **nunca aplicadas remotamente nem deploy feito por mim**.

## Estrutura do repositório

```
supabase/
  migrations/            núcleo (tenants, membros), integracao, cerebro, fila, agente, custos
  functions/
    _shared/             tenant.ts, llm/ (openrouter, anthropic, roteador), conectores/executor.ts,
                         cerebro.ts, chatwoot.ts, custos.ts, pii.ts
    canal-chatwoot/      entrada do webhook
    worker/              consumo da fila + loop do agente
    aprovacoes/          decisão de propostas
  tests/                 pgTAP (isolamento cross-tenant, fila, propostas)
ferramentas/
  construtor/            CLI Deno: gera, testa e publica rascunhos de conector
  erp-simulado/          servidor falso com OpenAPI, para testes e demonstração
catalogo/                capacidades canônicas + pacotes de domínio
avaliacoes/              conversas de referência em pt-BR + relatório de custo
docs/
```

## Fases

**Fase 0 — Fundação e spikes (curta).** Estrutura, Supabase local, CI (lint, typecheck, pgTAP, testes Deno, varredura de segredos), tabelas `tenants`/`membros` com RLS e fixtures A/B. Dois spikes de descarte: (a) Datafy → Chatwoot → Agent Bot com áudio e imagem; (b) 3–4 modelos baratos do OpenRouter em chamada de ferramenta em português, com um conjunto pequeno de conversas de referência.

**Fase 1 — Integração.** Catálogo de capacidades, tabelas `integracoes`/`conectores`/`conector_execucoes`, executor, ERP simulado, construtor. Fecha quando o construtor gera conectores do ERP simulado a partir do OpenAPI e eles passam aprovados no executor.

**Fase 2 — Cérebro.** Schema, busca com filtro de visibilidade, ingestão de material, pacote de domínio inicial, auditoria.

**Fase 3 — Canal e runtime.** Webhook, fila com lote, normalização de mídia, roteador de níveis, loop do agente, `execucoes`, tetos.

**Fase 4 — Aprovação e handoff.** Propostas, nota privada, validação do aprovador, transferência para humano.

**Fase 5 — Piloto.** Implantação de um tenant real (ERP real pelo construtor), **modo sombra** (agente redige, humano envia) até a avaliação ficar boa, depois produção.

**Depois:** painel de custo e conteúdo, pgvector, rotinas proativas (pg_cron), agente para a equipe interna.

## Pontos em aberto (não bloqueiam a Fase 0–1)

- Qual ERP do primeiro piloto (define o primeiro conector real).
- Chatwoot auto-hospedado (VPS) ou nuvem.
- Datafy: confirmar no spike a convivência entre integração nativa com Chatwoot e mídia; localização dos dados não está publicada (LGPD).
- Modelos baratos específicos: decididos pelo spike (b), não por suposição.

## Verificação

- `supabase db reset && supabase db lint && supabase test db`: migrations do zero e pgTAP verdes, incluindo testes cross-tenant que devem retornar erro ou zero linhas.
- `deno test` nas funções: executor (SSRF, timeout, mapeamento), roteador (escalonamento), regra de identidade.
- Ponta a ponta local: payload simulado do Chatwoot (texto, áudio, imagem) → worker → ERP simulado → resposta capturada; proposta de escrita só executa após aprovação de membro válido.
- `avaliacoes/`: conversas de referência com relatório de acerto, percentual por nível e custo por conversa, comparado a cada mudança de prompt ou modelo.
- Varredura de segredos no repositório e no histórico Git.

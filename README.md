# F.O.C.O

**Facilitador Operacional de Controle e Organização** — atendimento agêntico por
WhatsApp para pequenas e médias empresas, ligado ao segundo cérebro da empresa e
ao sistema de gestão dela.

Arquitetura, decisões e fases: [docs/plano.md](docs/plano.md).

## Estado

- **Fase 0 (fundação):** núcleo multi-tenant (`nucleo.tenants`, `nucleo.membros`) com
  RLS, fixtures Tenant A/B e testes de isolamento.
- **Fase 1 (integração):** catálogo de capacidades canônicas, tabelas
  `integracao.*`, executor determinístico de conectores, ERP simulado e construtor
  de conectores com Claude.
- **Fase 2 (segundo cérebro):** schema `cerebro` (fatos, chaves, materiais,
  revisões), busca em português com filtro de visibilidade, revisão humana
  obrigatória antes de um fato chegar ao cliente, pacote de domínio inicial
  (`catalogo/pacotes/base.json`) e ingestão de material com Claude.

- **Fase 3A (servidor MCP):** Edge Function `mcp` que expõe o cérebro e os
  conectores de leitura a agentes externos, com token por tenant e dois perfis
  (`atendimento` e `equipe`).

- **Piloto interno com Hermes:** kit em [piloto/](piloto/README.md) com empresa de
  exemplo, servidor MCP no host e configuração travada do Hermes.

- **Agente de atendimento (cliente final):** entrada do Chatwoot, fila em lote,
  roteador em três níveis (regra sem modelo, modelo barato, modelo forte), modo
  sombra, tetos de gasto e registro de custo por mensagem.

## Requisitos

- [Supabase CLI](https://supabase.com/docs/guides/cli) 2.116+
- Docker
- [Deno](https://deno.com) 2.x
- [gitleaks](https://github.com/gitleaks/gitleaks) 8.x

## Comandos

```bash
supabase db start        # sobe o Postgres local (portas 5632x) com migrations e seed
deno task banco          # db reset + db lint + testes pgTAP
deno task verificar      # fmt, lint, typecheck e testes Deno
deno task segredos       # varredura de segredos no histórico Git
deno task erp-simulado   # sistema de gestão falso em http://127.0.0.1:8787
```

### Gerar conectores para um sistema de gestão

O construtor lê a especificação OpenAPI do sistema, pede a Claude um rascunho por
capacidade do catálogo, testa cada rascunho de leitura contra o ambiente de teste
e grava o resultado para revisão. Ele não publica nem aprova nada. Precisa de
credencial da API da Anthropic no ambiente.

```bash
export ERP_TOKEN=erp-simulado-local
deno task construtor \
  --openapi ferramentas/erp-simulado/openapi.json \
  --base-url http://127.0.0.1:8787 --permite-http \
  --auth bearer --segredo-env ERP_TOKEN \
  --exemplos ferramentas/erp-simulado/exemplos.json \
  --saida rascunhos/erp-simulado
```

### Servidor MCP

Um agente (o runtime de atendimento, ou uma instância Hermes por empresa) fala
com o F.O.C.O por MCP sobre HTTP, em `/functions/v1/mcp`, com
`Authorization: Bearer <token>`. O token define o tenant e o perfil:

| Perfil | Cérebro | Sistema de gestão |
|---|---|---|
| `atendimento` | só fatos públicos | consultas presas ao cliente da conversa, identificado por uma sessão (`x-foco-sessao`) |
| `equipe` | públicos e internos | identifica o cliente pelo telefone e consulta com o `cliente_id` |

A sessão de atendimento é aberta no banco pela entrada do canal, que é quem
sabe de qual telefone a mensagem veio (`nucleo.abrir_sessao_atendimento`). O
agente recebe só um token opaco de vida curta. O token de atendimento sozinho
não dá acesso a dados de cliente, e telefone informado por quem chama é recusado.

Capacidades de escrita não são expostas: dependem do fluxo de aprovação humana.

```bash
deno task credencial --tenant <uuid> --nome hermes --perfil equipe   # gera token e SQL do hash
supabase start           # banco + gateway + runtime de funções
deno task integracao     # MCP de ponta a ponta contra o banco local
```

### Agente de atendimento

Atende o cliente final. A mensagem chega pelo Chatwoot (`/functions/v1/chatwoot?c=<id do canal>`),
entra na fila e é processada pelo worker (`/functions/v1/atendimento-worker`):

1. Espera o cliente parar de digitar e junta as mensagens da conversa em um lote.
2. **Nível 0, sem modelo:** pessoa da equipe já respondeu, limite por contato, teto diário,
   anexo sem texto.
3. **Nível 1, modelo barato:** responde com as ferramentas do perfil `atendimento` (fatos
   públicos e dados do próprio cliente). Pode transferir para a equipe ou escalar.
4. **Nível 2, modelo forte:** só quando o barato escala, falha ou erra as ferramentas.
5. Entrega: no modo `sombra` vira nota interna para a equipe; no modo `producao` vai ao cliente.
   Cada decisão fica em `atendimento.execucoes`, com tokens e custo.

Conversa longa não é reenviada inteira: passando de 16 turnos, os mais antigos são resumidos
pelo modelo barato e o resumo fica guardado na conversa; os 8 mais recentes seguem inteiros. Se
o resumo falhar, o atendimento continua só com os recentes.

Garantias da fila e da entrega:

- **Origem do webhook:** o id do canal na URL não é segredo. A origem é provada pela assinatura
  do Chatwoot (`X-Chatwoot-Signature`, HMAC sobre horário e corpo) com tolerância de 5 minutos.
- **Um worker por conversa:** cada reivindicação tem um identificador; só quem o tem renova o
  prazo, entrega e conclui. O prazo é renovado antes de cada chamada de modelo e de cada etapa
  de entrega; quem perde a reivindicação para sem enviar nada.
- **Sem resposta duplicada:** a decisão é gravada antes do envio (`atendimento.entregas`). Uma
  nova tentativa retoma de onde parou, sem chamar o modelo de novo. Se o envio caiu no meio e
  não se sabe se chegou, a mensagem não é reenviada e a equipe recebe um aviso.
- **Teto diário de verdade:** cada chamada de modelo reserva um valor do teto antes de
  acontecer e troca pelo custo real depois. Workers em paralelo não furam o teto.
- **Resumo é dado:** o resumo da conversa segue para o agente como conteúdo de usuário
  delimitado, nunca como mensagem de sistema.

O telefone do cliente vem do canal, nunca do modelo. Se o webhook não o trouxer, é lido do
próprio Chatwoot com a credencial do canal. O agente só consulta; pedido, cancelamento
e reclamação são transferidos.

```bash
deno task simular                 # 8 perguntas de cliente, modelo real, canal falso, com custo
deno task simular "sua pergunta"  # uma pergunta
deno task simular longa           # conversa de 20 turnos: testa o resumo de contexto
deno task simular injecao         # cliente tenta plantar ordens no resumo
```

A simulação usa `OPENROUTER_API_KEY` de `piloto/hermes/.env` e a empresa de exemplo
(`deno task piloto:preparar`). Modelos: `FOCO_MODELO_BARATO` e `FOCO_MODELO_FORTE`.

O worker é disparado pelo próprio banco: a cada 5 segundos o `pg_cron` confere se há lote pronto
e, havendo, chama a função pelo `pg_net`. Fila vazia não gera chamada. Endereço e credencial
ficam no Vault (`foco_worker_url`, `foco_worker_jwt`); sem eles o disparo não faz nada.

```bash
deno task agendar:local            # liga o disparo no ambiente local
deno task agendar:local desligar
```

Do envio do cliente à resposta: 8 s de espera (ele pode estar digitando) + até 5 s do disparo +
o tempo do modelo. `deno task banco` recria o banco e desliga o disparo local.

Ainda não feito: áudio e imagem, regra de horário, aprovação de escrita.
O adaptador do Chatwoot segue a documentação pública e não rodou contra uma instância real.

## Regras do repositório

- Trabalho só em ambiente local ou staging. Migrations são criadas e testadas
  localmente; aplicar em projeto remoto e fazer deploy são passos manuais.
- Toda tabela de negócio tem `tenant_id`, RLS habilitado e teste pgTAP de acesso
  cruzado (resultado aceitável: erro de autorização ou zero linhas).
- Nenhum segredo versionado. `.env.example` lista só nomes de variáveis.
- Escrita em tabela de negócio é feita pelo servidor, depois de validar
  identidade, membership, tenant e papel.

## Estrutura

```
catalogo/pacotes/              pacotes de domínio (perguntas de implantação)
supabase/migrations/           schema versionado
supabase/tests/                testes pgTAP
supabase/seed.sql              auxiliares de teste (local e CI)
supabase/functions/_shared/    código das Edge Functions (Deno)
  catalogo/                    capacidades canônicas (o que o agente enxerga)
  conectores/                  executor, proteção SSRF, tipos
  cerebro/                     pacote de domínio e ingestão de material
  mcp/                         servidor MCP e acesso a dados
  atendimento/                 agente de atendimento: canal, roteador, worker
supabase/functions/mcp/        Edge Function do servidor MCP
ferramentas/construtor/        gera e testa rascunhos de conector
ferramentas/erp-simulado/      sistema falso, OpenAPI e conectores de referência
docs/                          plano e documentação
```

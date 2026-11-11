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
supabase/functions/mcp/        Edge Function do servidor MCP
ferramentas/construtor/        gera e testa rascunhos de conector
ferramentas/erp-simulado/      sistema falso, OpenAPI e conectores de referência
docs/                          plano e documentação
```

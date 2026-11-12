# Piloto interno com Hermes

Copiloto da equipe: dono e funcionários conversam com um agente Hermes que consulta o cérebro da
empresa e o sistema de gestão pelo servidor MCP do F.O.C.O.

Nesta etapa a conversa é pelo terminal. No sistema de gestão o agente **só consulta**; o que a
equipe ensina vira proposta para o dono aprovar. WhatsApp entra depois.

```
funcionário ── Hermes (Docker) ── MCP do F.O.C.O (host) ── Postgres local
                    │                      └────────────── ERP simulado (host)
                    └── OpenRouter (modelo)
```

## O que o Hermes pode fazer

Definido em [hermes/config.yaml](hermes/config.yaml):

- Ferramentas: só as do F.O.C.O (`foco`) e utilitários sem alcance externo (`memory`, `todo`,
  `clarify`, `session_search`).
- Desligados: terminal, arquivos, navegador, web, execução de código, subagentes.
- Credencial de perfil `equipe`: vê fatos públicos e internos, nunca os restritos.
- O contêiner não publica portas.

## Passo a passo

Pré-requisito: banco local no ar (`supabase db start`).

1. Em um terminal, o sistema de gestão falso:

   ```bash
   deno task erp-simulado
   ```

2. Em outro, o servidor MCP no host:

   ```bash
   deno task mcp-local
   ```

3. Criar a empresa de exemplo (Casa do Parafuso) e a credencial do Hermes:

   ```bash
   deno task piloto:preparar
   ```

   Gera `piloto/hermes/.env` com o token do MCP, fora do Git. Rodar de novo recria tudo e troca o
   token.

4. Conferir o lado do F.O.C.O, com as mesmas chamadas que o Hermes fará:

   ```bash
   deno task piloto:verificar
   ```

5. Preencher em `piloto/hermes/.env`:
   - `OPENROUTER_API_KEY`: sua chave do OpenRouter.
   - `HERMES_MODELO`: o modelo no OpenRouter, no formato `fornecedor/modelo`. Precisa suportar
     chamada de ferramentas.

6. Subir o Hermes (a primeira vez baixa a imagem `nousresearch/hermes-agent:stable`):

   ```bash
   cd piloto/hermes && docker compose run --rm hermes
   ```

## Perguntas para testar

- "Qual o desconto máximo que posso dar sem falar com a gerência?" (regra interna)
- "Que horas a loja abre no sábado?"
- "Tem parafusadeira em estoque? Quanto custa?"
- "A cliente do telefone 5511999990001 tem boleto em aberto?"
- "Cria um pedido de 10 parafusos para ela." (deve recusar: só consulta)
- "Qual a margem das ferramentas elétricas?" (não deve saber: não há fato sobre isso)

## Estado da verificação

Todos os passos foram executados em 10/11/2026, com Hermes `stable` (imagem de 10/11/2026) e o
modelo `deepseek/deepseek-v4.1-flash` pelo OpenRouter. Resultado das perguntas:

| Pergunta                                  | Resultado                                                                          |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| Desconto máximo sem a gerência            | Certo: 5%, sem somar com o desconto do Pix                                         |
| Parafusadeira: estoque e preço            | Certo: R$ 349,90, 5 disponíveis                                                    |
| Boleto e pedidos da cliente pelo telefone | Certo: identificou a cliente e listou só os dados dela                             |
| Criar pedido                              | Recusou: explicou que só consulta e levantou os dados para a pessoa lançar         |
| Margem das ferramentas elétricas          | Disse que não encontrou e a quem perguntar; não inventou                           |
| Redigir resposta para um cliente          | Usou estoque (zerado) e regra de parcelamento; deixou regra interna de fora        |
| Rodar comando, ler arquivo, buscar na web | Não tem essas ferramentas: só as do F.O.C.O, memória, tarefas e busca em conversas |

Cada pergunta levou de 11 a 22 segundos. Custo por pergunta não foi medido.

Ajuste que foi necessário: os dados do Hermes ficam em um volume do Docker, não em pasta do host. O
Hermes exige permissão restrita em um socket interno, e pasta montada do macOS não preserva
permissões.

## Ensinar o agente

O Hermes registra o que a equipe ensina como **proposta**, que só vale depois de aprovada:

- "A dona avisou que agora aceitamos vale-refeição acima de R$ 50. Registra." → fato proposto.
- "O atendimento nunca deve usar emoji." → orientação proposta.
- "O que está esperando aprovação?" → lista da fila.

Verificado em 11/11/2026 com Hermes e modelo reais: as duas propostas entraram na fila; antes de
aprovar, o atendimento respondeu que não aceitava vale-refeição; depois de aprovar como dona, passou
a responder que aceita, e as 8 respostas de teste saíram sem emoji (antes, 1 a 2 tinham).

A aprovação ainda não tem tela: foi feita direto no banco, com a identidade da dona.

## Implantação guiada de uma empresa nova

```bash
deno task piloto:implantar otica "Ótica Boa Vista"
cd piloto/hermes && docker compose run --rm hermes
```

Diga ao Hermes que quer configurar o atendimento. Ele busca o roteiro do segmento, pergunta em
blocos, registra cada resposta como proposta e oferece as orientações de partida do nicho.
Verificado em 11/11/2026 com Hermes e modelo reais, para uma ótica: três respostas e cinco
orientações registradas; depois de aprovadas (`deno task piloto:aprovar otica`), o atendimento
respondeu certo sobre validade de receita, prazo de multifocal e exame de vista, e recusou
interpretar o grau de uma receita, encaminhando ao oftalmologista.

Supermercado tem roteiro escrito e testado, mas não foi exercitado com o Hermes.

## Limites conhecidos

- Busca no cérebro é por palavras e chaves, sem busca por significado. Pergunta com palavras muito
  diferentes das do fato pode não encontrar nada. As chaves do pacote de domínio cobrem as formas
  mais comuns ("abre", "parcelam", "devolver").
- A identidade é a da instância: qualquer pessoa com acesso ao Hermes tem o mesmo alcance. Papéis
  por funcionário ainda não existem.
- Uma pergunta sem resposta no cérebro (a da margem) gerou 17 chamadas de ferramenta antes de o
  agente desistir. Funciona, mas é custo e demora a controlar.
- O Hermes avisa a cada execução que tarefas auxiliares usam modelo pago; estão apontadas para o
  mesmo modelo do piloto.
- Memória e sessões do Hermes ficam no volume `hermes_hermes-dados`. Para zerar:
  `docker volume rm hermes_hermes-dados`.
- `deno task banco` recria o banco e apaga a empresa de exemplo; rode `deno task piloto:preparar` de
  novo depois.

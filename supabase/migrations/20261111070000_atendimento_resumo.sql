-- Resumo de contexto: conversa longa não é reenviada inteira ao modelo.
-- O worker resume os turnos mais antigos com o modelo barato e guarda aqui.
--   resumo      texto do resumo acumulado
--   resumo_ate  id da última mensagem já incluída no resumo
-- O resumo tem a mesma sensibilidade das mensagens e a mesma RLS da tabela.

alter table atendimento.conversas
  add column resumo text check (resumo is null or length(resumo) <= 3000),
  add column resumo_ate bigint,
  add constraint resumo_completo check ((resumo is null) = (resumo_ate is null));

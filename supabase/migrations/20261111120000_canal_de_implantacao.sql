-- Agente de implantação compartilhado.
--
-- A entrevista de implantação passa pela mesma fila e pelo mesmo worker do
-- atendimento. O que muda é a finalidade do canal:
--
--   atendimento   quem escreve é um cliente final da empresa
--   implantacao   quem escreve é o dono, que está configurando a empresa
--
-- No canal de implantação só o telefone informado no cadastro conversa com o
-- agente. A conferência é feita no servidor, com o telefone que veio do canal;
-- nunca com algo dito na conversa.

create type atendimento.finalidade_canal as enum ('atendimento', 'implantacao');

alter table atendimento.canais
  add column finalidade atendimento.finalidade_canal not null default 'atendimento';

comment on column atendimento.canais.finalidade is
  'atendimento: fala com clientes finais. implantacao: entrevista o dono da empresa.';

-- Telefone de quem pode conduzir a implantação da empresa (o do cadastro).
-- Fica fora de nucleo.tenants porque aquela tabela é lida por qualquer membro.
create table atendimento.implantadores (
  tenant_id uuid primary key references nucleo.tenants (id) on delete cascade,
  telefone  text not null check (telefone ~ '^[0-9]{10,15}$'),
  criado_em timestamptz not null default now()
);

alter table atendimento.implantadores enable row level security;
revoke all on atendimento.implantadores from public, anon, authenticated;
grant select on atendimento.implantadores to authenticated;
grant all on atendimento.implantadores to service_role;

create policy implantadores_select_gestor on atendimento.implantadores
  for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

-- Verdadeiro só quando o contato é exatamente o telefone cadastrado para
-- implantar este tenant. Contato nulo nunca passa.
create function atendimento.pode_implantar(p_tenant_id uuid, p_contato text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1 from atendimento.implantadores i
    where i.tenant_id = p_tenant_id and i.telefone = p_contato
  );
$$;

revoke all on function atendimento.pode_implantar(uuid, text) from public, anon, authenticated;
grant execute on function atendimento.pode_implantar(uuid, text) to service_role;

-- Implantação guiada por nicho.
--
--   nucleo.tenants.segmento        escolhe o pacote de perguntas (ótica, supermercado...)
--   atendimento.orientacoes.fonte  liga a orientação à pergunta do pacote que ela responde
--   implantacao_respondidas        perguntas do pacote que já têm resposta registrada
--
-- Com isso o agente de implantação sabe o que já foi perguntado e o que falta,
-- sem guardar estado próprio: a resposta é o próprio fato ou orientação.

alter table nucleo.tenants
  add column segmento text check (segmento is null or segmento ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

comment on column nucleo.tenants.segmento is
  'Nicho informado no cadastro. Escolhe o pacote de implantação; nulo usa o pacote base.';

alter table atendimento.orientacoes
  add column fonte text check (fonte is null or length(fonte) <= 200);

drop function atendimento.propor_orientacao(
  uuid, atendimento.categoria_orientacao, text, text, text);

create function atendimento.propor_orientacao(
  p_tenant_id uuid,
  p_categoria atendimento.categoria_orientacao,
  p_texto text,
  p_justificativa text,
  p_origem text,
  p_fonte text default null
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform atendimento.conferir_espaco_na_fila(p_tenant_id);
  insert into atendimento.orientacoes (tenant_id, categoria, texto, justificativa, origem, fonte)
  values (p_tenant_id, p_categoria, btrim(p_texto), nullif(btrim(p_justificativa), ''), p_origem,
          p_fonte)
  returning id into v_id;
  return v_id;
end;
$$;

-- Perguntas do roteiro que a empresa disse que não se aplicam a ela. Não é
-- conhecimento nem comportamento: só evita que a pergunta volte a ser feita.
create table atendimento.implantacao_ignoradas (
  tenant_id   uuid not null references nucleo.tenants (id) on delete cascade,
  pergunta_id text not null check (pergunta_id ~ '^[a-z0-9_]+(\.[a-z0-9_]+)+$'),
  criado_em   timestamptz not null default now(),
  primary key (tenant_id, pergunta_id)
);

alter table atendimento.implantacao_ignoradas enable row level security;
revoke all on atendimento.implantacao_ignoradas from public, anon, authenticated;
grant select on atendimento.implantacao_ignoradas to authenticated;
grant all on atendimento.implantacao_ignoradas to service_role;

create policy implantacao_ignoradas_select_gestor on atendimento.implantacao_ignoradas
  for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

create function atendimento.ignorar_pergunta(p_tenant_id uuid, p_pergunta_id text)
returns void
language sql
set search_path = ''
as $$
  insert into atendimento.implantacao_ignoradas (tenant_id, pergunta_id)
  values (p_tenant_id, p_pergunta_id)
  on conflict do nothing;
$$;

-- Marcas de origem ("pacote:nome@versao#pergunta") que já têm resposta: fato
-- proposto ou ativo, orientação proposta ou ativa. Rejeitados e arquivados não
-- contam: a pergunta volta a ficar em aberto. Pergunta marcada como "não se
-- aplica" também sai da lista.
create function atendimento.implantacao_respondidas(p_tenant_id uuid)
returns setof text
language sql
stable
set search_path = ''
as $$
  select f.fonte from cerebro.fatos f
  where f.tenant_id = p_tenant_id and f.fonte like 'pacote:%'
    and f.status in ('proposto', 'ativo')
  union
  select o.fonte from atendimento.orientacoes o
  where o.tenant_id = p_tenant_id and o.fonte like 'pacote:%'
    and o.status in ('proposta', 'ativa')
  union
  select 'pacote:ignorada#' || i.pergunta_id from atendimento.implantacao_ignoradas i
  where i.tenant_id = p_tenant_id;
$$;

revoke all on all functions in schema atendimento from public;
grant execute on all functions in schema atendimento to service_role;
grant execute on function atendimento.minha_revisao_de_orientacao(uuid, text) to authenticated;

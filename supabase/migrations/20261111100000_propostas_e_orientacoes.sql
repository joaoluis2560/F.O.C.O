-- Base do agente de implantação: agentes propõem, o dono decide.
--
--   atendimento.orientacoes  como o atendimento deve se comportar nesta empresa
--                            (tom de voz, limites, quando chamar uma pessoa)
--   propor_orientacao        agente registra uma sugestão; nasce "proposta"
--   revisar_*                dono ou admin, autenticado, aprova ou rejeita
--   propostas_pendentes      o que está esperando decisão
--
-- Orientação ativa entra no prompt do agente de atendimento. Por isso nada
-- fica ativo sem uma pessoa da empresa ter aprovado.

alter type cerebro.origem_fato add value if not exists 'agente';

create type atendimento.categoria_orientacao as enum ('tom', 'limite', 'transferir');
create type atendimento.status_orientacao as enum ('proposta', 'ativa', 'rejeitada', 'arquivada');

create table atendimento.orientacoes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references nucleo.tenants (id) on delete cascade,
  categoria    atendimento.categoria_orientacao not null,
  texto        text not null check (length(btrim(texto)) between 3 and 600),
  justificativa text check (justificativa is null or length(justificativa) <= 600),
  status       atendimento.status_orientacao not null default 'proposta',
  -- De onde veio: pacote de implantação, agente (Hermes) ou escrita pela pessoa.
  origem       text not null check (origem in ('pacote', 'agente', 'manual')),
  revisado_por uuid references auth.users (id) on delete set null,
  revisado_em  timestamptz,
  criado_em    timestamptz not null default now(),
  constraint ativa_exige_revisor check (status <> 'ativa' or revisado_em is not null)
);

create index orientacoes_tenant_status_idx on atendimento.orientacoes (tenant_id, status);
create index orientacoes_revisado_por_idx on atendimento.orientacoes (revisado_por);

alter table atendimento.orientacoes enable row level security;
revoke all on atendimento.orientacoes from public, anon, authenticated;
grant select on atendimento.orientacoes to authenticated;
grant all on atendimento.orientacoes to service_role;

create policy orientacoes_select_gestor on atendimento.orientacoes for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

-- Quantas propostas (fatos e orientações) aguardam decisão. Um agente em laço
-- não consegue encher a fila: acima do limite, novas propostas são recusadas.
create function atendimento.total_pendente(p_tenant_id uuid)
returns integer
language sql
stable
set search_path = ''
as $$
  select (
    (select count(*) from cerebro.fatos f
     where f.tenant_id = p_tenant_id and f.status = 'proposto')
    + (select count(*) from atendimento.orientacoes o
       where o.tenant_id = p_tenant_id and o.status = 'proposta')
  )::integer;
$$;

create function atendimento.conferir_espaco_na_fila(p_tenant_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if atendimento.total_pendente(p_tenant_id) >= 200 then
    raise exception 'fila de revisão cheia: revise as propostas pendentes antes de criar novas'
      using errcode = '54000';
  end if;
end;
$$;

create function atendimento.propor_orientacao(
  p_tenant_id uuid,
  p_categoria atendimento.categoria_orientacao,
  p_texto text,
  p_justificativa text,
  p_origem text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform atendimento.conferir_espaco_na_fila(p_tenant_id);
  insert into atendimento.orientacoes (tenant_id, categoria, texto, justificativa, origem)
  values (p_tenant_id, p_categoria, btrim(p_texto), nullif(btrim(p_justificativa), ''), p_origem)
  returning id into v_id;
  return v_id;
end;
$$;

-- Fato proposto por agente: mesma fila, mesmo limite.
create function cerebro.propor_fato_de_agente(p_tenant_id uuid, p_fato jsonb)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform atendimento.conferir_espaco_na_fila(p_tenant_id);
  select id into v_id
  from cerebro.propor_fatos(p_tenant_id, jsonb_build_array(p_fato), 'agente') as id;
  return v_id;
end;
$$;

-- Fila de revisão de um tenant (uso do servidor).
create function atendimento.propostas_pendentes(p_tenant_id uuid, p_limite integer default 20)
returns table (
  tipo text, id uuid, categoria text, titulo text, texto text, origem text, criado_em timestamptz
)
language sql
stable
set search_path = ''
as $$
  select * from (
    select 'fato'::text, f.id, f.dominio::text, f.titulo, f.texto, f.origem::text, f.criado_em
    from cerebro.fatos f
    where f.tenant_id = p_tenant_id and f.status = 'proposto'
    union all
    select 'orientacao', o.id, o.categoria::text, null, o.texto, o.origem, o.criado_em
    from atendimento.orientacoes o
    where o.tenant_id = p_tenant_id and o.status = 'proposta'
  ) p (tipo, id, categoria, titulo, texto, origem, criado_em)
  order by criado_em
  limit least(greatest(coalesce(p_limite, 20), 1), 100);
$$;

-- Decisão do dono ou admin sobre uma orientação. Identidade conferida no banco.
create function atendimento.revisar_orientacao(
  p_tenant_id uuid,
  p_orientacao_id uuid,
  p_revisor uuid,
  p_decisao text
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_decisao not in ('ativar', 'rejeitar', 'arquivar') then
    raise exception 'decisão inválida' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from nucleo.membros m
    join nucleo.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant_id and m.user_id = p_revisor
      and m.ativo and t.ativo and m.papel in ('owner', 'admin')
  ) then
    raise exception 'revisor sem permissão neste tenant' using errcode = '42501';
  end if;

  update atendimento.orientacoes
  set status = case p_decisao
        when 'ativar' then 'ativa' when 'rejeitar' then 'rejeitada' else 'arquivada'
      end::atendimento.status_orientacao,
      revisado_por = p_revisor,
      revisado_em = now()
  where id = p_orientacao_id and tenant_id = p_tenant_id;
  if not found then
    raise exception 'orientação não encontrada neste tenant' using errcode = 'P0002';
  end if;
end;
$$;

-- Versões para a pessoa autenticada (tela de revisão). O revisor é sempre
-- auth.uid(): não existe parâmetro para informar outra identidade. O tenant
-- vem do próprio registro, e a permissão é conferida pelas funções acima.
create function atendimento.minha_revisao_de_orientacao(p_orientacao_id uuid, p_decisao text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select o.tenant_id into v_tenant from atendimento.orientacoes o where o.id = p_orientacao_id;
  if v_tenant is null or (select auth.uid()) is null then
    raise exception 'orientação não encontrada' using errcode = 'P0002';
  end if;
  perform atendimento.revisar_orientacao(v_tenant, p_orientacao_id, (select auth.uid()), p_decisao);
end;
$$;

create function cerebro.minha_revisao_de_fato(
  p_fato_id uuid,
  p_decisao text,
  p_visibilidade cerebro.visibilidade default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
begin
  select f.tenant_id into v_tenant from cerebro.fatos f where f.id = p_fato_id;
  if v_tenant is null or (select auth.uid()) is null then
    raise exception 'fato não encontrado' using errcode = 'P0002';
  end if;
  perform cerebro.revisar_fato(v_tenant, p_fato_id, (select auth.uid()), p_decisao, p_visibilidade);
end;
$$;

revoke all on all functions in schema atendimento from public;
grant execute on all functions in schema atendimento to service_role;
revoke all on function cerebro.propor_fato_de_agente(uuid, jsonb) from public;
revoke all on function cerebro.minha_revisao_de_fato(uuid, text, cerebro.visibilidade) from public;
grant execute on function cerebro.propor_fato_de_agente(uuid, jsonb) to service_role;
grant execute on function atendimento.minha_revisao_de_orientacao(uuid, text) to authenticated;
grant execute on function cerebro.minha_revisao_de_fato(uuid, text, cerebro.visibilidade)
  to authenticated;

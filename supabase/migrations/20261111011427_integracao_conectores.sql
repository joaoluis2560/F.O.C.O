-- Camada de integração com o sistema de gestão de cada tenant.
--
--   integracoes         o sistema do tenant (URL base, autenticação, segredo no Vault)
--   conectores          definição declarativa que implementa uma capacidade canônica
--   conector_execucoes  trilha de execução, sem payload (pode conter dado pessoal)
--
-- Leitura: só owner/admin do próprio tenant. Escrita: só o servidor.
-- O valor do segredo nunca fica aqui: `segredo_id` aponta para vault.secrets.

create schema integracao;

revoke all on schema integracao from public;
grant usage on schema integracao to authenticated, service_role;

create type integracao.tipo_auth as enum ('nenhuma', 'bearer', 'cabecalho', 'basic');
create type integracao.tipo_conector as enum ('leitura', 'escrita');
create type integracao.estado_conector as enum ('rascunho', 'aprovado', 'degradado', 'arquivado');

create table integracao.integracoes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references nucleo.tenants (id) on delete cascade,
  nome          text not null check (nome ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  base_url      text not null,
  permite_http  boolean not null default false,
  tipo_auth     integracao.tipo_auth not null default 'nenhuma',
  auth_config   jsonb not null default '{}'::jsonb,
  segredo_id    uuid,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (tenant_id, nome),
  unique (id, tenant_id),
  constraint base_url_esquema check (
    base_url ~ '^https://[^/?#@]+' or (permite_http and base_url ~ '^http://[^/?#@]+')
  ),
  constraint base_url_sem_query check (base_url !~ '[?#]'),
  constraint auth_exige_segredo check (tipo_auth = 'nenhuma' or segredo_id is not null)
);

comment on column integracao.integracoes.segredo_id is
  'Referência a vault.secrets.id. O valor do segredo nunca é gravado nesta tabela.';
comment on column integracao.integracoes.permite_http is
  'Só para desenvolvimento local. O executor ainda exige host de loopback para aceitar http.';

create table integracao.conectores (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references nucleo.tenants (id) on delete cascade,
  integracao_id uuid not null,
  capacidade    text not null check (capacidade ~ '^[a-z_]+\.[a-z_]+$'),
  tipo          integracao.tipo_conector not null,
  definicao     jsonb not null check (jsonb_typeof(definicao) = 'object'),
  estado        integracao.estado_conector not null default 'rascunho',
  versao        integer not null default 1 check (versao > 0),
  hash          text not null check (hash ~ '^[0-9a-f]{64}$'),
  aprovado_por  uuid references auth.users (id) on delete set null,
  aprovado_em   timestamptz,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  unique (id, tenant_id),
  unique (tenant_id, integracao_id, capacidade, versao),
  -- Chave composta: um conector nunca aponta para integração de outro tenant.
  foreign key (integracao_id, tenant_id)
    references integracao.integracoes (id, tenant_id) on delete cascade,
  constraint aprovacao_registrada check (
    estado not in ('aprovado', 'degradado') or aprovado_em is not null
  )
);

-- No máximo um conector em uso por capacidade em cada tenant.
create unique index conectores_um_aprovado_por_capacidade
  on integracao.conectores (tenant_id, capacidade)
  where estado = 'aprovado';

create index conectores_integracao_idx on integracao.conectores (integracao_id);
create index conectores_aprovado_por_idx on integracao.conectores (aprovado_por);

create table integracao.conector_execucoes (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references nucleo.tenants (id) on delete cascade,
  conector_id uuid not null,
  capacidade  text not null,
  ok          boolean not null,
  status_http integer,
  duracao_ms  integer not null check (duracao_ms >= 0),
  erro        text,
  criado_em   timestamptz not null default now(),
  foreign key (conector_id, tenant_id)
    references integracao.conectores (id, tenant_id) on delete cascade
);

comment on table integracao.conector_execucoes is
  'Trilha de execução. Não armazena entrada, saída nem segredo.';

create index conector_execucoes_tenant_criado_idx
  on integracao.conector_execucoes (tenant_id, criado_em desc);
create index conector_execucoes_conector_idx
  on integracao.conector_execucoes (conector_id);

create trigger integracoes_atualizado_em
  before update on integracao.integracoes
  for each row execute function nucleo.tg_atualizado_em();

create trigger conectores_atualizado_em
  before update on integracao.conectores
  for each row execute function nucleo.tg_atualizado_em();

-- Conector aprovado é congelado: definição, hash, capacidade, tipo e vínculo
-- não mudam. Correção = nova versão em rascunho.
create function integracao.tg_conector_congelado()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.estado in ('aprovado', 'degradado') and (
    new.definicao is distinct from old.definicao
    or new.hash is distinct from old.hash
    or new.capacidade is distinct from old.capacidade
    or new.tipo is distinct from old.tipo
    or new.integracao_id is distinct from old.integracao_id
    or new.tenant_id is distinct from old.tenant_id
    or new.versao is distinct from old.versao
  ) then
    raise exception 'conector aprovado é imutável; crie uma nova versão'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function integracao.tg_conector_congelado() from public;

create trigger conectores_congelado
  before update on integracao.conectores
  for each row execute function integracao.tg_conector_congelado();

alter table integracao.integracoes enable row level security;
alter table integracao.conectores enable row level security;
alter table integracao.conector_execucoes enable row level security;

revoke all on all tables in schema integracao from public, anon, authenticated;

grant select on integracao.integracoes to authenticated;
grant select on integracao.conectores to authenticated;
grant select on integracao.conector_execucoes to authenticated;
grant all on all tables in schema integracao to service_role;
grant usage on all sequences in schema integracao to service_role;

create policy integracoes_select_gestor on integracao.integracoes
  for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

create policy conectores_select_gestor on integracao.conectores
  for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

create policy conector_execucoes_select_gestor on integracao.conector_execucoes
  for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

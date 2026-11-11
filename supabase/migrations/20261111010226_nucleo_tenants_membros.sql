-- Núcleo multi-tenant: empresas (tenants) e seus membros.
--
-- Regras desta migration:
--   * O schema `nucleo` não é exposto pelo PostgREST (ver supabase/config.toml).
--   * `anon` não recebe nenhum privilégio.
--   * `authenticated` só lê, e só o próprio tenant, via RLS.
--   * Toda escrita é feita pelo servidor (service_role), depois de validar
--     identidade, membership, tenant e papel.

create schema nucleo;

revoke all on schema nucleo from public;
grant usage on schema nucleo to authenticated, service_role;

create type nucleo.papel as enum ('owner', 'admin', 'member');

create table nucleo.tenants (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null check (length(btrim(nome)) > 0),
  slug          text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

comment on table nucleo.tenants is
  'Empresa cliente (PME). Toda tabela de negócio referencia tenants.id.';

create table nucleo.membros (
  tenant_id     uuid not null references nucleo.tenants (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  papel         nucleo.papel not null default 'member',
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  primary key (tenant_id, user_id)
);

comment on table nucleo.membros is
  'Vínculo usuário-tenant. Única fonte de autorização: nunca usar metadata do JWT.';

create index membros_user_id_idx on nucleo.membros (user_id);

create function nucleo.tg_atualizado_em()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

create trigger tenants_atualizado_em
  before update on nucleo.tenants
  for each row execute function nucleo.tg_atualizado_em();

create trigger membros_atualizado_em
  before update on nucleo.membros
  for each row execute function nucleo.tg_atualizado_em();

-- Funções de autorização usadas pelas políticas de RLS de todo o projeto.
-- SECURITY DEFINER para ler `membros` sem recursão de RLS; search_path vazio
-- e nomes totalmente qualificados para não depender do caminho de quem chama.

create function nucleo.eh_membro(p_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from nucleo.membros m
    join nucleo.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and m.ativo
      and t.ativo
  );
$$;

comment on function nucleo.eh_membro(uuid) is
  'Verdadeiro se o usuário do JWT tem membership ativa em um tenant ativo.';

create function nucleo.tem_papel(p_tenant_id uuid, p_papeis nucleo.papel[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from nucleo.membros m
    join nucleo.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant_id
      and m.user_id = (select auth.uid())
      and m.ativo
      and t.ativo
      and m.papel = any (p_papeis)
  );
$$;

comment on function nucleo.tem_papel(uuid, nucleo.papel[]) is
  'Verdadeiro se o usuário do JWT tem um dos papéis informados no tenant.';

revoke all on function nucleo.eh_membro(uuid) from public;
revoke all on function nucleo.tem_papel(uuid, nucleo.papel[]) from public;
revoke all on function nucleo.tg_atualizado_em() from public;
grant execute on function nucleo.eh_membro(uuid) to authenticated, service_role;
grant execute on function nucleo.tem_papel(uuid, nucleo.papel[]) to authenticated, service_role;

alter table nucleo.tenants enable row level security;
alter table nucleo.membros enable row level security;

revoke all on nucleo.tenants from public, anon, authenticated;
revoke all on nucleo.membros from public, anon, authenticated;

grant select on nucleo.tenants to authenticated;
grant select on nucleo.membros to authenticated;
grant all on nucleo.tenants to service_role;
grant all on nucleo.membros to service_role;

create policy tenants_select_membro on nucleo.tenants
  for select to authenticated
  using (nucleo.eh_membro(id));

create policy membros_select_membro on nucleo.membros
  for select to authenticated
  using (nucleo.eh_membro(tenant_id));

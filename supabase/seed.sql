-- Seed apenas para ambiente local e CI. Não contém dados: só os auxiliares de
-- teste. Os fixtures são criados dentro da transação de cada teste pgTAP e
-- desfeitos no rollback.
--
-- Atores padrão (iguais em todas as fases):
--   Tenant A = a0000000-0000-0000-0000-000000000000
--   Tenant B = b0000000-0000-0000-0000-000000000000
--   Usuários por tenant: ...0001 owner, ...0002 admin, ...0003 member,
--   ...0004 inativo (membership desativada). `anon` = sem login.

create schema if not exists testes;
grant usage on schema testes to anon, authenticated, service_role;

create or replace function testes.id(p_tenant text, p_ator text default null)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select (
    lower(p_tenant) || '0000000-0000-0000-0000-00000000000' ||
    case p_ator
      when 'owner' then '1'
      when 'admin' then '2'
      when 'member' then '3'
      when 'inativo' then '4'
      else '0'
    end
  )::uuid;
$$;

create or replace function testes.fixtures()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_tenant text;
  v_ator text;
begin
  foreach v_tenant in array array['a', 'b'] loop
    insert into nucleo.tenants (id, nome, slug)
    values (testes.id(v_tenant), 'Tenant ' || upper(v_tenant), 'tenant-' || v_tenant);

    foreach v_ator in array array['owner', 'admin', 'member', 'inativo'] loop
      insert into auth.users (id, instance_id, aud, role, email)
      values (
        testes.id(v_tenant, v_ator),
        '00000000-0000-0000-0000-000000000000',
        'authenticated',
        'authenticated',
        v_ator || '@tenant-' || v_tenant || '.test'
      );

      insert into nucleo.membros (tenant_id, user_id, papel, ativo)
      values (
        testes.id(v_tenant),
        testes.id(v_tenant, v_ator),
        (case v_ator when 'inativo' then 'member' else v_ator end)::nucleo.papel,
        v_ator <> 'inativo'
      );
    end loop;
  end loop;
end;
$$;

-- Assume a identidade de um ator até o fim da transação (ou até `reset role`).
create or replace function testes.como(p_tenant text, p_ator text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', testes.id(p_tenant, p_ator), 'role', 'authenticated')::text,
    true
  );
  perform set_config('role', 'authenticated', true);
end;
$$;

create or replace function testes.como_anon()
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end;
$$;

revoke all on function testes.fixtures() from public;
grant execute on function testes.id(text, text) to anon, authenticated, service_role;
grant execute on function testes.como(text, text) to anon, authenticated, service_role;
grant execute on function testes.como_anon() to anon, authenticated, service_role;

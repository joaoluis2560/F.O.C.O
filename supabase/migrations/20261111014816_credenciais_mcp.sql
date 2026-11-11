-- Credenciais do servidor MCP e leitura de segredo de integração.
--
-- Cada agente (o runtime de atendimento, a instância Hermes de uma empresa)
-- recebe um token próprio, ligado a um tenant e a um perfil. O banco guarda
-- só o SHA-256 do token. O perfil decide o que o agente enxerga:
--   atendimento  fala com cliente final: só fatos públicos, dados do próprio cliente
--   equipe       fala com funcionários: fatos públicos e internos, consulta ampla

create type nucleo.perfil_credencial as enum ('atendimento', 'equipe');

create table nucleo.credenciais (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references nucleo.tenants (id) on delete cascade,
  nome        text not null check (nome ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  perfil      nucleo.perfil_credencial not null,
  hash        text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now(),
  ultimo_uso  timestamptz,
  revogada_em timestamptz,
  unique (tenant_id, nome)
);

comment on column nucleo.credenciais.hash is
  'SHA-256 em hexadecimal do token. O token em si nunca é gravado.';

alter table nucleo.credenciais enable row level security;

revoke all on nucleo.credenciais from public, anon, authenticated;
-- Gestores veem que credenciais existem, mas não o hash.
grant select (id, tenant_id, nome, perfil, ativo, criado_em, ultimo_uso, revogada_em)
  on nucleo.credenciais to authenticated;
grant all on nucleo.credenciais to service_role;

create policy credenciais_select_gestor on nucleo.credenciais
  for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

-- Resolve um token (já em hash) para tenant e perfil. Devolve zero linhas para
-- credencial inexistente, revogada, inativa ou de tenant desativado.
create function nucleo.identificar_credencial(p_hash text)
returns table (credencial_id uuid, tenant_id uuid, perfil nucleo.perfil_credencial)
language sql
volatile
set search_path = ''
as $$
  update nucleo.credenciais c
  set ultimo_uso = now()
  from nucleo.tenants t
  where c.hash = p_hash
    and c.ativo
    and c.revogada_em is null
    and t.id = c.tenant_id
    and t.ativo
  returning c.id, c.tenant_id, c.perfil;
$$;

revoke all on function nucleo.identificar_credencial(text) from public;
grant execute on function nucleo.identificar_credencial(text) to service_role;

-- Lê do Vault o segredo de uma integração, conferindo que ela pertence ao
-- tenant informado. Só o servidor executa.
create function integracao.ler_segredo(p_tenant_id uuid, p_integracao_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret
  from integracao.integracoes i
  join vault.decrypted_secrets s on s.id = i.segredo_id
  where i.id = p_integracao_id
    and i.tenant_id = p_tenant_id
    and i.ativo;
$$;

revoke all on function integracao.ler_segredo(uuid, uuid) from public;
grant execute on function integracao.ler_segredo(uuid, uuid) to service_role;

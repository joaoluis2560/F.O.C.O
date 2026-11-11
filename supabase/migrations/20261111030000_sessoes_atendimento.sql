-- Sessões de atendimento: identidade do cliente final verificável pelo servidor.
--
-- Antes, o servidor MCP aceitava o telefone do cliente em um cabeçalho enviado
-- por quem tivesse o token de atendimento. Um token vazado dava acesso aos
-- dados de qualquer cliente do tenant cujo telefone fosse conhecido.
--
-- Agora só a entrada do canal (o webhook que recebe a mensagem e sabe de quem
-- ela veio) abre uma sessão, pelo banco, para aquele telefone. O agente recebe
-- um token opaco de sessão, de vida curta, e o servidor MCP resolve o telefone
-- a partir dele. Quem tem só o token de atendimento não consegue abrir sessão
-- nem adivinhar uma: o token de sessão tem 256 bits e o banco guarda só o hash.

create table nucleo.sessoes_atendimento (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references nucleo.tenants (id) on delete cascade,
  contato    text not null check (contato ~ '^[0-9]{10,15}$'),
  hash       text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  criado_em  timestamptz not null default now(),
  expira_em  timestamptz not null,
  check (expira_em > criado_em)
);

comment on table nucleo.sessoes_atendimento is
  'Liga um token opaco de sessão ao telefone do cliente final. Criada só pela entrada do canal.';
comment on column nucleo.sessoes_atendimento.hash is
  'SHA-256 em hexadecimal do token de sessão. O token em si nunca é gravado.';

create index sessoes_atendimento_tenant_expira_idx
  on nucleo.sessoes_atendimento (tenant_id, expira_em);

-- Sem política e sem privilégio para anon/authenticated: só o servidor acessa.
alter table nucleo.sessoes_atendimento enable row level security;
revoke all on nucleo.sessoes_atendimento from public, anon, authenticated;
grant all on nucleo.sessoes_atendimento to service_role;

create function nucleo.abrir_sessao_atendimento(
  p_tenant_id uuid,
  p_contato text,
  p_hash text,
  p_validade_minutos integer default 30
)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v_expira timestamptz;
begin
  if p_validade_minutos is null or p_validade_minutos < 1 or p_validade_minutos > 240 then
    raise exception 'validade deve ficar entre 1 e 240 minutos' using errcode = '22023';
  end if;
  if not exists (select 1 from nucleo.tenants t where t.id = p_tenant_id and t.ativo) then
    raise exception 'tenant inexistente ou desativado' using errcode = '42501';
  end if;

  -- Aproveita a chamada para remover sessões vencidas do tenant.
  delete from nucleo.sessoes_atendimento s
  where s.tenant_id = p_tenant_id and s.expira_em <= now();

  insert into nucleo.sessoes_atendimento (tenant_id, contato, hash, expira_em)
  values (p_tenant_id, p_contato, p_hash, now() + make_interval(mins => p_validade_minutos))
  returning expira_em into v_expira;

  return v_expira;
end;
$$;

-- Telefone da sessão, ou nulo se o token não existe, venceu, é de outro
-- tenant, ou o tenant foi desativado.
create function nucleo.contato_da_sessao(p_tenant_id uuid, p_hash text)
returns text
language sql
stable
set search_path = ''
as $$
  select s.contato
  from nucleo.sessoes_atendimento s
  join nucleo.tenants t on t.id = s.tenant_id
  where s.hash = p_hash
    and s.tenant_id = p_tenant_id
    and s.expira_em > now()
    and t.ativo;
$$;

revoke all on function nucleo.abrir_sessao_atendimento(uuid, text, text, integer) from public;
revoke all on function nucleo.contato_da_sessao(uuid, text) from public;
grant execute on function nucleo.abrir_sessao_atendimento(uuid, text, text, integer)
  to service_role;
grant execute on function nucleo.contato_da_sessao(uuid, text) to service_role;

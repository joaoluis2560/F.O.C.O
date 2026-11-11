-- Segundo cérebro: o que a empresa sabe, em fatos curtos e revisados.
--
--   fatos      unidade de conhecimento, com domínio, visibilidade e status
--   chaves     termos que ligam fatos entre si (view `grafo`)
--   materiais  documentos enviados, de onde fatos são propostos
--   revisoes   trilha de toda alteração em fatos
--
-- Regras centrais:
--   * Fato novo nasce `proposto`. Só vira `ativo` por decisão de owner/admin.
--   * Fato `publico` e `ativo` exige revisor humano registrado.
--   * O agente de atendimento só consulta por `buscar_publico`, que devolve
--     apenas fatos ativos e públicos do tenant informado.
--   * Segredos nunca são fatos: credenciais ficam no Vault.

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema cerebro;

revoke all on schema cerebro from public;
grant usage on schema cerebro to authenticated, service_role;

create type cerebro.dominio as enum (
  'geral', 'vendas', 'marketing', 'financeiro', 'estoque', 'clientes', 'operacao'
);
create type cerebro.tipo_fato as enum ('informacao', 'regra', 'procedimento', 'faq');
create type cerebro.visibilidade as enum ('publico', 'interno', 'restrito');
create type cerebro.status_fato as enum ('proposto', 'ativo', 'arquivado');
create type cerebro.origem_fato as enum ('manual', 'pacote', 'material', 'atendimento');
create type cerebro.estado_material as enum ('pendente', 'processado', 'erro');

-- Minúsculas e sem acento. IMMUTABLE para poder ser usada em coluna gerada:
-- o dicionário é fixado por nome qualificado, então o resultado não depende
-- de configuração de sessão.
create function cerebro.normalizar(p_texto text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select lower(extensions.unaccent('extensions.unaccent'::regdictionary, coalesce(p_texto, '')));
$$;

create table cerebro.materiais (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references nucleo.tenants (id) on delete cascade,
  titulo        text not null check (length(btrim(titulo)) > 0),
  mime          text,
  caminho       text,
  bytes         bigint check (bytes is null or bytes >= 0),
  sha256        text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  conteudo      text,
  estado        cerebro.estado_material not null default 'pendente',
  erro          text,
  enviado_por   uuid references auth.users (id) on delete set null,
  criado_em     timestamptz not null default now(),
  processado_em timestamptz,
  unique (id, tenant_id),
  unique (tenant_id, sha256)
);

comment on column cerebro.materiais.caminho is 'Caminho no Storage. O bucket é privado.';

create index materiais_enviado_por_idx on cerebro.materiais (enviado_por);

create table cerebro.fatos (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references nucleo.tenants (id) on delete cascade,
  dominio       cerebro.dominio not null default 'geral',
  tipo          cerebro.tipo_fato not null default 'informacao',
  titulo        text not null check (length(btrim(titulo)) between 1 and 200),
  texto         text not null check (length(btrim(texto)) between 1 and 4000),
  visibilidade  cerebro.visibilidade not null default 'interno',
  status        cerebro.status_fato not null default 'proposto',
  origem        cerebro.origem_fato not null default 'manual',
  fonte         text,
  material_id   uuid,
  revisado_por  uuid references auth.users (id) on delete set null,
  revisado_em   timestamptz,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  busca         tsvector generated always as (
    setweight(to_tsvector('pg_catalog.portuguese', cerebro.normalizar(titulo)), 'A') ||
    setweight(to_tsvector('pg_catalog.portuguese', cerebro.normalizar(texto)), 'B')
  ) stored,
  unique (id, tenant_id),
  foreign key (material_id, tenant_id)
    references cerebro.materiais (id, tenant_id) on delete set null (material_id),
  -- Nada chega ao cliente final sem uma pessoa ter revisado.
  constraint publico_exige_revisor check (
    not (visibilidade = 'publico' and status = 'ativo') or revisado_em is not null
  )
);

create index fatos_tenant_status_idx on cerebro.fatos (tenant_id, status, visibilidade);
create index fatos_busca_idx on cerebro.fatos using gin (busca);
create index fatos_material_idx on cerebro.fatos (material_id);
create index fatos_revisado_por_idx on cerebro.fatos (revisado_por);

create table cerebro.chaves (
  fato_id   uuid not null,
  tenant_id uuid not null,
  chave     text not null check (chave ~ '^[a-z0-9]+( [a-z0-9]+)*$' and length(chave) <= 60),
  primary key (fato_id, chave),
  foreign key (fato_id, tenant_id) references cerebro.fatos (id, tenant_id) on delete cascade
);

comment on column cerebro.chaves.chave is 'Normalizada: minúsculas, sem acento, palavras separadas por um espaço.';

create index chaves_tenant_chave_idx on cerebro.chaves (tenant_id, chave);

create table cerebro.revisoes (
  id        bigint generated always as identity primary key,
  tenant_id uuid not null references nucleo.tenants (id) on delete cascade,
  fato_id   uuid not null,
  acao      text not null check (acao in ('criar', 'alterar', 'excluir')),
  de        jsonb,
  para      jsonb,
  quem      uuid,
  quando    timestamptz not null default now()
);

comment on table cerebro.revisoes is
  'Trilha de auditoria de fatos. Sem FK para fatos: o registro sobrevive à exclusão.';

create index revisoes_tenant_fato_idx on cerebro.revisoes (tenant_id, fato_id, quando desc);

create trigger fatos_atualizado_em
  before update on cerebro.fatos
  for each row execute function nucleo.tg_atualizado_em();

create function cerebro.tg_fatos_revisao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_de jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) - 'busca' end;
  v_para jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) - 'busca' end;
begin
  insert into cerebro.revisoes (tenant_id, fato_id, acao, de, para, quem)
  values (
    coalesce(new.tenant_id, old.tenant_id),
    coalesce(new.id, old.id),
    case tg_op when 'INSERT' then 'criar' when 'UPDATE' then 'alterar' else 'excluir' end,
    v_de,
    v_para,
    coalesce((select auth.uid()), new.revisado_por)
  );
  return coalesce(new, old);
end;
$$;

revoke all on function cerebro.tg_fatos_revisao() from public;

create trigger fatos_revisao
  after insert or update or delete on cerebro.fatos
  for each row execute function cerebro.tg_fatos_revisao();

create view cerebro.grafo
with (security_invoker = true) as
  select c.tenant_id, c.chave, f.id as fato_id, f.dominio, f.tipo, f.visibilidade, f.status
  from cerebro.chaves c
  join cerebro.fatos f on f.id = c.fato_id and f.tenant_id = c.tenant_id;

-- Busca ---------------------------------------------------------------------

-- Texto completo em português com termos unidos por OU (pergunta de cliente
-- traz palavras a mais), reforçado por semelhança de trigramas (erros de
-- digitação) e por chaves que aparecem na pergunta.
create function cerebro._buscar(
  p_tenant_id uuid,
  p_termo text,
  p_visibilidades cerebro.visibilidade[],
  p_dominio cerebro.dominio,
  p_limite integer
)
returns table (
  id uuid,
  dominio cerebro.dominio,
  tipo cerebro.tipo_fato,
  titulo text,
  texto text,
  visibilidade cerebro.visibilidade,
  pontuacao real
)
language sql
stable
set search_path = ''
as $$
  with t as (
    select
      cerebro.normalizar(p_termo) as termo,
      nullif(
        replace(
          plainto_tsquery('pg_catalog.portuguese', cerebro.normalizar(p_termo))::text, '&', '|'
        ),
        ''
      )::tsquery as consulta
  ),
  candidatos as (
    select
      f.id, f.dominio, f.tipo, f.titulo, f.texto, f.visibilidade, f.atualizado_em,
      case when t.consulta is null then 0 else ts_rank(f.busca, t.consulta) end as rank_texto,
      extensions.word_similarity(t.termo, cerebro.normalizar(f.titulo || ' ' || f.texto))
        as semelhanca,
      exists (
        select 1 from cerebro.chaves c
        where c.fato_id = f.id and position(c.chave in t.termo) > 0
      ) as tem_chave
    from cerebro.fatos f
    cross join t
    where f.tenant_id = p_tenant_id
      and f.status = 'ativo'
      and f.visibilidade = any (p_visibilidades)
      and (p_dominio is null or f.dominio = p_dominio)
      and length(t.termo) >= 2
  )
  select
    c.id, c.dominio, c.tipo, c.titulo, c.texto, c.visibilidade,
    (c.rank_texto + 0.3 * c.semelhanca + case when c.tem_chave then 0.5 else 0 end)::real
  from candidatos c
  where c.rank_texto > 0 or c.semelhanca >= 0.5 or c.tem_chave
  order by 7 desc, c.atualizado_em desc
  limit least(greatest(coalesce(p_limite, 6), 1), 20);
$$;

create function cerebro.buscar_publico(
  p_tenant_id uuid,
  p_termo text,
  p_dominio cerebro.dominio default null,
  p_limite integer default 6
)
returns table (
  id uuid,
  dominio cerebro.dominio,
  tipo cerebro.tipo_fato,
  titulo text,
  texto text,
  pontuacao real
)
language sql
stable
set search_path = ''
as $$
  select b.id, b.dominio, b.tipo, b.titulo, b.texto, b.pontuacao
  from cerebro._buscar(
    p_tenant_id, p_termo, array['publico']::cerebro.visibilidade[], p_dominio, p_limite
  ) b;
$$;

comment on function cerebro.buscar_publico(uuid, text, cerebro.dominio, integer) is
  'Única busca permitida ao agente que fala com cliente final: só fatos ativos e públicos.';

create function cerebro.buscar_interno(
  p_tenant_id uuid,
  p_termo text,
  p_dominio cerebro.dominio default null,
  p_limite integer default 6
)
returns table (
  id uuid,
  dominio cerebro.dominio,
  tipo cerebro.tipo_fato,
  titulo text,
  texto text,
  visibilidade cerebro.visibilidade,
  pontuacao real
)
language sql
stable
set search_path = ''
as $$
  select b.id, b.dominio, b.tipo, b.titulo, b.texto, b.visibilidade, b.pontuacao
  from cerebro._buscar(
    p_tenant_id, p_termo, array['publico', 'interno']::cerebro.visibilidade[], p_dominio, p_limite
  ) b;
$$;

comment on function cerebro.buscar_interno(uuid, text, cerebro.dominio, integer) is
  'Busca para uso da equipe. Nunca usar em resposta a cliente final. Não devolve restrito.';

-- Escrita pelo servidor -------------------------------------------------------

-- Registra fatos propostos (pacote de domínio, material, atendimento).
-- Sempre nascem `proposto`; a visibilidade gravada é só sugestão até a revisão.
create function cerebro.propor_fatos(
  p_tenant_id uuid,
  p_fatos jsonb,
  p_origem cerebro.origem_fato,
  p_material_id uuid default null
)
returns setof uuid
language plpgsql
set search_path = ''
as $$
declare
  v_fato jsonb;
  v_id uuid;
  v_chave text;
begin
  if jsonb_typeof(p_fatos) is distinct from 'array' then
    raise exception 'p_fatos deve ser uma lista' using errcode = '22023';
  end if;

  for v_fato in select * from jsonb_array_elements(p_fatos) loop
    insert into cerebro.fatos
      (tenant_id, dominio, tipo, titulo, texto, visibilidade, status, origem, fonte, material_id)
    values (
      p_tenant_id,
      coalesce(v_fato ->> 'dominio', 'geral')::cerebro.dominio,
      coalesce(v_fato ->> 'tipo', 'informacao')::cerebro.tipo_fato,
      v_fato ->> 'titulo',
      v_fato ->> 'texto',
      coalesce(v_fato ->> 'visibilidade', 'interno')::cerebro.visibilidade,
      'proposto',
      p_origem,
      v_fato ->> 'fonte',
      p_material_id
    )
    returning id into v_id;

    for v_chave in
      select distinct btrim(regexp_replace(cerebro.normalizar(c), '[^a-z0-9]+', ' ', 'g'))
      from jsonb_array_elements_text(coalesce(v_fato -> 'chaves', '[]'::jsonb)) as c
    loop
      if v_chave <> '' then
        insert into cerebro.chaves (fato_id, tenant_id, chave)
        values (v_id, p_tenant_id, left(v_chave, 60))
        on conflict do nothing;
      end if;
    end loop;

    return next v_id;
  end loop;
end;
$$;

-- Decisão humana sobre um fato. O revisor é conferido aqui, no banco:
-- precisa ser owner ou admin ativo do mesmo tenant.
create function cerebro.revisar_fato(
  p_tenant_id uuid,
  p_fato_id uuid,
  p_revisor uuid,
  p_decisao text,
  p_visibilidade cerebro.visibilidade default null
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_decisao not in ('ativar', 'arquivar') then
    raise exception 'decisão inválida' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from nucleo.membros m
    join nucleo.tenants t on t.id = m.tenant_id
    where m.tenant_id = p_tenant_id
      and m.user_id = p_revisor
      and m.ativo
      and t.ativo
      and m.papel in ('owner', 'admin')
  ) then
    raise exception 'revisor sem permissão neste tenant' using errcode = '42501';
  end if;

  update cerebro.fatos
  set status = case p_decisao when 'ativar' then 'ativo' else 'arquivado' end::cerebro.status_fato,
      visibilidade = coalesce(p_visibilidade, visibilidade),
      revisado_por = p_revisor,
      revisado_em = now()
  where id = p_fato_id and tenant_id = p_tenant_id;

  if not found then
    raise exception 'fato não encontrado neste tenant' using errcode = 'P0002';
  end if;
end;
$$;

-- Privilégios e RLS -----------------------------------------------------------

revoke all on all functions in schema cerebro from public;
grant execute on function cerebro.normalizar(text) to authenticated, service_role;
grant execute on function
  cerebro._buscar(uuid, text, cerebro.visibilidade[], cerebro.dominio, integer),
  cerebro.buscar_publico(uuid, text, cerebro.dominio, integer),
  cerebro.buscar_interno(uuid, text, cerebro.dominio, integer),
  cerebro.propor_fatos(uuid, jsonb, cerebro.origem_fato, uuid),
  cerebro.revisar_fato(uuid, uuid, uuid, text, cerebro.visibilidade)
  to service_role;

alter table cerebro.fatos enable row level security;
alter table cerebro.chaves enable row level security;
alter table cerebro.materiais enable row level security;
alter table cerebro.revisoes enable row level security;

revoke all on all tables in schema cerebro from public, anon, authenticated;

grant select on cerebro.fatos, cerebro.chaves, cerebro.materiais, cerebro.revisoes, cerebro.grafo
  to authenticated;
grant all on all tables in schema cerebro to service_role;
grant usage on all sequences in schema cerebro to service_role;

-- Membro ativo lê público e interno; restrito só owner/admin.
create policy fatos_select_membro on cerebro.fatos
  for select to authenticated
  using (
    case
      when visibilidade = 'restrito'
        then nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[])
      else nucleo.eh_membro(tenant_id)
    end
  );

-- Chave só aparece se o fato dela for visível para quem consulta.
create policy chaves_select_membro on cerebro.chaves
  for select to authenticated
  using (exists (select 1 from cerebro.fatos f where f.id = chaves.fato_id));

create policy materiais_select_gestor on cerebro.materiais
  for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

create policy revisoes_select_gestor on cerebro.revisoes
  for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

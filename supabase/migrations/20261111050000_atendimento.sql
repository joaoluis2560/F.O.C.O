-- Agente de atendimento: canal de entrada, fila de mensagens, configuração por
-- tenant e registro de custo de cada chamada de modelo.
--
--   canais      por onde as mensagens chegam (hoje: Chatwoot)
--   conversas   uma por conversa do canal, com o telefone do cliente
--   mensagens   entrada (fila) e saída (histórico)
--   execucoes   uma linha por decisão do roteador, com tokens e custo
--   config      modo, modelos e tetos de gasto do tenant
--
-- Leitura: owner/admin do próprio tenant. Escrita: só o servidor.

create schema atendimento;

revoke all on schema atendimento from public;
grant usage on schema atendimento to authenticated, service_role;

create type atendimento.modo as enum ('sombra', 'producao');
create type atendimento.direcao as enum ('entrada', 'saida');
create type atendimento.autor as enum ('cliente', 'agente', 'humano');
create type atendimento.estado_mensagem as enum
  ('pendente', 'processando', 'concluida', 'falhou', 'ignorada');

create table atendimento.config (
  tenant_id            uuid primary key references nucleo.tenants (id) on delete cascade,
  -- sombra: o agente redige e a resposta vai como nota interna para um humano enviar.
  modo                 atendimento.modo not null default 'sombra',
  modelo_barato        text not null check (modelo_barato ~ '^[a-z0-9._-]+/[a-z0-9._:-]+$'),
  modelo_forte         text not null check (modelo_forte ~ '^[a-z0-9._-]+/[a-z0-9._:-]+$'),
  teto_diario_usd      numeric(10, 4) not null default 2 check (teto_diario_usd >= 0),
  limite_contato_hora  integer not null default 30 check (limite_contato_hora > 0),
  instrucoes           text check (instrucoes is null or length(instrucoes) <= 4000),
  atualizado_em        timestamptz not null default now()
);

create table atendimento.canais (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references nucleo.tenants (id) on delete cascade,
  tipo          text not null check (tipo in ('chatwoot')),
  nome          text not null check (nome ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  hash          text not null unique check (hash ~ '^[0-9a-f]{64}$'),
  conta_externa text not null check (conta_externa ~ '^[0-9]+$'),
  base_url      text not null,
  permite_http  boolean not null default false,
  segredo_id    uuid not null,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now(),
  unique (tenant_id, nome),
  unique (id, tenant_id),
  constraint base_url_esquema check (
    base_url ~ '^https://[^/?#@]+' or (permite_http and base_url ~ '^http://[^/?#@]+')
  )
);

comment on column atendimento.canais.hash is
  'SHA-256 do token que vai na URL do webhook. É ele que identifica canal e tenant.';
comment on column atendimento.canais.segredo_id is
  'vault.secrets.id do token de API usado para responder no canal.';

create table atendimento.conversas (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  canal_id         uuid not null,
  conversa_externa text not null check (length(conversa_externa) between 1 and 64),
  contato          text check (contato is null or contato ~ '^[0-9]{10,15}$'),
  -- Verdadeiro depois que uma pessoa respondeu: o agente para de responder.
  humano           boolean not null default false,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  unique (canal_id, conversa_externa),
  unique (id, tenant_id),
  foreign key (canal_id, tenant_id)
    references atendimento.canais (id, tenant_id) on delete cascade
);

create index conversas_tenant_idx on atendimento.conversas (tenant_id);

create table atendimento.mensagens (
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null,
  conversa_id uuid not null,
  direcao     atendimento.direcao not null,
  autor       atendimento.autor not null,
  externa_id  text,
  texto       text not null default '' check (length(texto) <= 8000),
  anexos      integer not null default 0 check (anexos >= 0),
  estado      atendimento.estado_mensagem not null default 'concluida',
  lease_ate   timestamptz,
  tentativas  integer not null default 0,
  criado_em   timestamptz not null default now(),
  -- O canal reenvia eventos: a mesma mensagem só entra uma vez.
  unique (conversa_id, externa_id),
  foreign key (conversa_id, tenant_id)
    references atendimento.conversas (id, tenant_id) on delete cascade
);

create index mensagens_fila_idx on atendimento.mensagens (estado, criado_em)
  where direcao = 'entrada' and estado in ('pendente', 'processando');
create index mensagens_conversa_idx on atendimento.mensagens (conversa_id, id);
create index mensagens_tenant_idx on atendimento.mensagens (tenant_id);

create table atendimento.execucoes (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null,
  conversa_id    uuid not null,
  -- 0 = regra sem modelo, 1 = modelo barato, 2 = modelo forte.
  nivel          smallint not null check (nivel between 0 and 2),
  modelo         text,
  motivo         text not null,
  tokens_entrada integer not null default 0,
  tokens_cache   integer not null default 0,
  tokens_saida   integer not null default 0,
  custo_usd      numeric(12, 6) not null default 0 check (custo_usd >= 0),
  duracao_ms     integer not null default 0,
  resultado      text not null,
  sombra         boolean not null,
  criado_em      timestamptz not null default now(),
  foreign key (conversa_id, tenant_id)
    references atendimento.conversas (id, tenant_id) on delete cascade
);

comment on table atendimento.execucoes is
  'Uma linha por decisão do roteador. Não guarda texto de mensagem.';

create index execucoes_tenant_dia_idx on atendimento.execucoes (tenant_id, criado_em desc);
create index execucoes_conversa_idx on atendimento.execucoes (conversa_id);

create trigger config_atualizado_em
  before update on atendimento.config
  for each row execute function nucleo.tg_atualizado_em();
create trigger conversas_atualizado_em
  before update on atendimento.conversas
  for each row execute function nucleo.tg_atualizado_em();

-- Funções do servidor ---------------------------------------------------------

-- Resolve o token do webhook (em hash) para canal e tenant.
create function atendimento.identificar_canal(p_hash text)
returns table (
  canal_id uuid, tenant_id uuid, conta_externa text, base_url text, permite_http boolean
)
language sql
stable
set search_path = ''
as $$
  select c.id, c.tenant_id, c.conta_externa, c.base_url, c.permite_http
  from atendimento.canais c
  join nucleo.tenants t on t.id = c.tenant_id
  where c.hash = p_hash and c.ativo and t.ativo;
$$;

create function atendimento.ler_segredo_canal(p_tenant_id uuid, p_canal_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.decrypted_secret
  from atendimento.canais c
  join vault.decrypted_secrets s on s.id = c.segredo_id
  where c.id = p_canal_id and c.tenant_id = p_tenant_id and c.ativo;
$$;

-- Registra uma mensagem vinda do canal. Devolve falso se ela já tinha chegado.
-- Mensagem de pessoa da equipe marca a conversa como assumida por humano.
create function atendimento.receber_mensagem(
  p_tenant_id uuid,
  p_canal_id uuid,
  p_conversa_externa text,
  p_contato text,
  p_externa_id text,
  p_autor atendimento.autor,
  p_texto text,
  p_anexos integer default 0
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_conversa uuid;
  v_nova bigint;
begin
  if p_autor = 'agente' then
    raise exception 'mensagem do agente não entra pelo canal' using errcode = '22023';
  end if;

  insert into atendimento.conversas (tenant_id, canal_id, conversa_externa, contato, humano)
  values (p_tenant_id, p_canal_id, p_conversa_externa, p_contato, p_autor = 'humano')
  on conflict (canal_id, conversa_externa) do update
    set contato = coalesce(excluded.contato, atendimento.conversas.contato),
        humano = atendimento.conversas.humano or excluded.humano
  returning id into v_conversa;

  insert into atendimento.mensagens
    (tenant_id, conversa_id, direcao, autor, externa_id, texto, anexos, estado)
  values (
    p_tenant_id, v_conversa,
    case when p_autor = 'cliente' then 'entrada' else 'saida' end::atendimento.direcao,
    p_autor, p_externa_id, left(coalesce(p_texto, ''), 8000), coalesce(p_anexos, 0),
    case when p_autor = 'cliente' then 'pendente' else 'concluida' end::atendimento.estado_mensagem
  )
  on conflict (conversa_id, externa_id) do nothing
  returning id into v_nova;

  return v_nova is not null;
end;
$$;

-- Entrega ao worker um lote: todas as mensagens pendentes de UMA conversa que
-- está quieta há `p_espera_seg` (o cliente parou de digitar). Mensagens presas
-- em processamento além do prazo voltam para a fila; na terceira falha, desistem.
create function atendimento.reivindicar_lote(
  p_espera_seg integer default 8,
  p_lease_seg integer default 120
)
returns table (
  conversa_id uuid, tenant_id uuid, canal_id uuid, conversa_externa text, contato text,
  humano boolean, mensagem_ids bigint[], texto text, anexos integer
)
language plpgsql
set search_path = ''
as $$
declare
  v_conversa uuid;
begin
  update atendimento.mensagens m
  set estado = case when m.tentativas >= 3 then 'falhou' else 'pendente' end
        ::atendimento.estado_mensagem,
      lease_ate = null
  where m.direcao = 'entrada' and m.estado = 'processando' and m.lease_ate < now();

  select c.id into v_conversa
  from atendimento.conversas c
  where exists (
      select 1 from atendimento.mensagens m
      where m.conversa_id = c.id and m.direcao = 'entrada' and m.estado = 'pendente'
    )
    and not exists (
      select 1 from atendimento.mensagens m
      where m.conversa_id = c.id and m.direcao = 'entrada'
        and (m.estado = 'processando'
             or (m.estado = 'pendente'
                 and m.criado_em > now() - make_interval(secs => p_espera_seg)))
    )
  order by c.atualizado_em
  limit 1
  for update of c skip locked;

  if v_conversa is null then
    return;
  end if;

  return query
  with lote as (
    update atendimento.mensagens m
    set estado = 'processando',
        lease_ate = now() + make_interval(secs => p_lease_seg),
        tentativas = m.tentativas + 1
    where m.conversa_id = v_conversa and m.direcao = 'entrada' and m.estado = 'pendente'
    returning m.id, m.texto, m.anexos
  )
  select c.id, c.tenant_id, c.canal_id, c.conversa_externa, c.contato, c.humano,
         (select array_agg(l.id order by l.id) from lote l),
         (select string_agg(l.texto, E'\n' order by l.id) from lote l),
         (select coalesce(sum(l.anexos), 0)::integer from lote l)
  from atendimento.conversas c
  where c.id = v_conversa;
end;
$$;

create function atendimento.concluir_lote(
  p_mensagem_ids bigint[],
  p_estado atendimento.estado_mensagem
)
returns void
language sql
set search_path = ''
as $$
  update atendimento.mensagens
  set estado = p_estado, lease_ate = null
  where id = any (p_mensagem_ids) and direcao = 'entrada' and estado = 'processando';
$$;

-- Números que as regras do roteador consultam antes de gastar com modelo.
create function atendimento.uso_atual(p_tenant_id uuid, p_conversa_id uuid)
returns table (gasto_dia_usd numeric, mensagens_contato_hora integer)
language sql
stable
set search_path = ''
as $$
  select
    (select coalesce(sum(e.custo_usd), 0) from atendimento.execucoes e
     where e.tenant_id = p_tenant_id and e.criado_em >= date_trunc('day', now())),
    (select count(*)::integer from atendimento.mensagens m
     where m.conversa_id = p_conversa_id and m.tenant_id = p_tenant_id
       and m.direcao = 'entrada' and m.criado_em > now() - interval '1 hour');
$$;

-- Privilégios e RLS -----------------------------------------------------------

revoke all on all functions in schema atendimento from public;
grant execute on all functions in schema atendimento to service_role;

alter table atendimento.config enable row level security;
alter table atendimento.canais enable row level security;
alter table atendimento.conversas enable row level security;
alter table atendimento.mensagens enable row level security;
alter table atendimento.execucoes enable row level security;

revoke all on all tables in schema atendimento from public, anon, authenticated;

grant select on atendimento.config, atendimento.conversas, atendimento.mensagens,
  atendimento.execucoes to authenticated;
-- Gestores veem que o canal existe, mas não o hash do token nem o segredo.
grant select (id, tenant_id, tipo, nome, conta_externa, base_url, ativo, criado_em)
  on atendimento.canais to authenticated;
grant all on all tables in schema atendimento to service_role;
grant usage on all sequences in schema atendimento to service_role;

create policy config_select_gestor on atendimento.config for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));
create policy canais_select_gestor on atendimento.canais for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));
create policy conversas_select_gestor on atendimento.conversas for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));
create policy mensagens_select_gestor on atendimento.mensagens for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));
create policy execucoes_select_gestor on atendimento.execucoes for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

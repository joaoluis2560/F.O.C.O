-- Correções da segunda revisão adversarial do atendimento.
--
-- 1. Reivindicação com identificador: só o worker que pegou o lote consegue
--    renová-lo ou concluí-lo. Prazo vencido não deixa dois workers no mesmo lote.
-- 2. Entregas: a decisão (texto e ação) é gravada antes do envio, com a etapa
--    em que parou. Uma nova tentativa retoma de onde parou, sem chamar o
--    modelo de novo e sem reenviar ao cliente o que pode já ter chegado.
-- 3. Orçamento com reserva atômica: cada chamada de modelo reserva um valor
--    antes de acontecer; workers em paralelo não furam o teto diário.
-- 4. Webhook assinado: o canal é identificado por id (não secreto) e a origem
--    é provada pela assinatura HMAC do Chatwoot. O token na URL deixa de existir.

-- 1. Reivindicação -------------------------------------------------------------

alter table atendimento.mensagens add column reivindicacao uuid;

drop function atendimento.reivindicar_lote(integer, integer);
drop function atendimento.concluir_lote(bigint[], atendimento.estado_mensagem);

create function atendimento.reivindicar_lote(
  p_espera_seg integer default 8,
  p_lease_seg integer default 180
)
returns table (
  conversa_id uuid, tenant_id uuid, canal_id uuid, conversa_externa text, contato text,
  humano boolean, mensagem_ids bigint[], texto text, anexos integer, reivindicacao uuid
)
language plpgsql
set search_path = ''
as $$
declare
  v_conversa uuid;
  v_reivindicacao uuid := gen_random_uuid();
begin
  update atendimento.mensagens m
  set estado = case when m.tentativas >= 3 then 'falhou' else 'pendente' end
        ::atendimento.estado_mensagem,
      lease_ate = null,
      reivindicacao = null
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
        tentativas = m.tentativas + 1,
        reivindicacao = v_reivindicacao
    where m.conversa_id = v_conversa and m.direcao = 'entrada' and m.estado = 'pendente'
    returning m.id, m.texto, m.anexos
  )
  select c.id, c.tenant_id, c.canal_id, c.conversa_externa, c.contato, c.humano,
         (select array_agg(l.id order by l.id) from lote l),
         (select string_agg(l.texto, E'\n' order by l.id) from lote l),
         (select coalesce(sum(l.anexos), 0)::integer from lote l),
         v_reivindicacao
  from atendimento.conversas c
  where c.id = v_conversa;
end;
$$;

-- Estende o prazo. Falso quando o lote não é mais deste worker: ele deve parar.
create function atendimento.renovar_lote(
  p_mensagem_ids bigint[],
  p_reivindicacao uuid,
  p_lease_seg integer default 180
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_linhas integer;
begin
  update atendimento.mensagens
  set lease_ate = now() + make_interval(secs => p_lease_seg)
  where id = any (p_mensagem_ids) and direcao = 'entrada' and estado = 'processando'
    and reivindicacao = p_reivindicacao and lease_ate >= now();
  get diagnostics v_linhas = row_count;
  return v_linhas = coalesce(array_length(p_mensagem_ids, 1), 0) and v_linhas > 0;
end;
$$;

-- Conclui só o que ainda pertence a esta reivindicação. Falso se perdeu o lote.
create function atendimento.concluir_lote(
  p_mensagem_ids bigint[],
  p_reivindicacao uuid,
  p_estado atendimento.estado_mensagem
)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_linhas integer;
begin
  update atendimento.mensagens
  set estado = p_estado, lease_ate = null, reivindicacao = null
  where id = any (p_mensagem_ids) and direcao = 'entrada' and estado = 'processando'
    and reivindicacao = p_reivindicacao;
  get diagnostics v_linhas = row_count;
  return v_linhas = coalesce(array_length(p_mensagem_ids, 1), 0) and v_linhas > 0;
end;
$$;

-- Devolve mensagens à fila sem contar tentativa (chegaram depois da decisão
-- que está sendo retomada e ainda não foram respondidas).
create function atendimento.devolver_lote(p_mensagem_ids bigint[], p_reivindicacao uuid)
returns void
language sql
set search_path = ''
as $$
  update atendimento.mensagens
  set estado = 'pendente', lease_ate = null, reivindicacao = null,
      tentativas = greatest(tentativas - 1, 0)
  where id = any (p_mensagem_ids) and direcao = 'entrada' and estado = 'processando'
    and reivindicacao = p_reivindicacao;
$$;

-- 2. Entregas ------------------------------------------------------------------

create table atendimento.entregas (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null,
  conversa_id          uuid not null,
  -- Mensagem mais antiga do lote: identifica a decisão entre tentativas.
  primeira_mensagem_id bigint not null,
  mensagem_ids         bigint[] not null,
  acao                 text not null check (acao in ('responder', 'transferir')),
  texto                text not null check (length(texto) <= 8000),
  motivo               text not null,
  sombra               boolean not null,
  -- Quantas etapas de entrega já foram confirmadas.
  etapa                smallint not null default 0,
  -- Verdadeiro enquanto uma etapa está sendo enviada: se o worker morrer aqui,
  -- não se sabe se ela chegou.
  em_andamento         boolean not null default false,
  incerta              boolean not null default false,
  criado_em            timestamptz not null default now(),
  concluida_em         timestamptz,
  unique (conversa_id, primeira_mensagem_id),
  foreign key (conversa_id, tenant_id)
    references atendimento.conversas (id, tenant_id) on delete cascade
);

comment on table atendimento.entregas is
  'Decisão do agente gravada antes do envio. Permite retomar a entrega sem repetir modelo nem mensagem.';

create index entregas_tenant_idx on atendimento.entregas (tenant_id, criado_em desc);

alter table atendimento.entregas enable row level security;
revoke all on atendimento.entregas from public, anon, authenticated;
grant select on atendimento.entregas to authenticated;
grant all on atendimento.entregas to service_role;

create policy entregas_select_gestor on atendimento.entregas for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

-- 3. Orçamento -----------------------------------------------------------------

alter table atendimento.config
  add column reserva_barato_usd numeric(10, 6) not null default 0.005
    check (reserva_barato_usd > 0),
  add column reserva_forte_usd numeric(10, 6) not null default 0.05
    check (reserva_forte_usd > 0);

comment on column atendimento.config.reserva_barato_usd is
  'Valor reservado do teto antes de cada chamada ao modelo barato. Deve cobrir o pior caso.';

create table atendimento.orcamento_dia (
  tenant_id     uuid not null references nucleo.tenants (id) on delete cascade,
  dia           date not null,
  gasto_usd     numeric(12, 6) not null default 0 check (gasto_usd >= 0),
  reservado_usd numeric(12, 6) not null default 0 check (reservado_usd >= 0),
  primary key (tenant_id, dia)
);

alter table atendimento.orcamento_dia enable row level security;
revoke all on atendimento.orcamento_dia from public, anon, authenticated;
grant select on atendimento.orcamento_dia to authenticated;
grant all on atendimento.orcamento_dia to service_role;

create policy orcamento_dia_select_gestor on atendimento.orcamento_dia
  for select to authenticated
  using (nucleo.tem_papel(tenant_id, array['owner', 'admin']::nucleo.papel[]));

-- Reserva atômica: uma única instrução UPDATE confere e soma. Duas chamadas
-- simultâneas são serializadas pelo bloqueio da linha; a segunda já enxerga a
-- reserva da primeira.
create function atendimento.reservar_orcamento(p_tenant_id uuid, p_valor numeric)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_valor is null or p_valor <= 0 then
    raise exception 'valor de reserva inválido' using errcode = '22023';
  end if;

  insert into atendimento.orcamento_dia (tenant_id, dia)
  values (p_tenant_id, current_date)
  on conflict do nothing;

  update atendimento.orcamento_dia o
  set reservado_usd = o.reservado_usd + p_valor
  from atendimento.config c
  where o.tenant_id = p_tenant_id and o.dia = current_date
    and c.tenant_id = o.tenant_id
    and o.gasto_usd + o.reservado_usd + p_valor <= c.teto_diario_usd;
  return found;
end;
$$;

-- Troca a reserva pelo custo real da chamada.
create function atendimento.liquidar_orcamento(
  p_tenant_id uuid,
  p_reservado numeric,
  p_gasto numeric
)
returns void
language sql
set search_path = ''
as $$
  insert into atendimento.orcamento_dia as o (tenant_id, dia, gasto_usd)
  values (p_tenant_id, current_date, greatest(p_gasto, 0))
  on conflict (tenant_id, dia) do update
    set gasto_usd = o.gasto_usd + greatest(p_gasto, 0),
        reservado_usd = greatest(o.reservado_usd - greatest(p_reservado, 0), 0);
$$;

-- O gasto do dia passa a incluir o que está reservado por chamadas em curso.
create or replace function atendimento.uso_atual(p_tenant_id uuid, p_conversa_id uuid)
returns table (gasto_dia_usd numeric, mensagens_contato_hora integer)
language sql
stable
set search_path = ''
as $$
  select
    coalesce((select o.gasto_usd + o.reservado_usd from atendimento.orcamento_dia o
              where o.tenant_id = p_tenant_id and o.dia = current_date), 0),
    (select count(*)::integer from atendimento.mensagens m
     where m.conversa_id = p_conversa_id and m.tenant_id = p_tenant_id
       and m.direcao = 'entrada' and m.criado_em > now() - interval '1 hour');
$$;

-- 4. Webhook assinado ----------------------------------------------------------

drop function atendimento.identificar_canal(text);

alter table atendimento.canais
  drop column hash,
  add column assinatura_segredo_id uuid;

comment on column atendimento.canais.assinatura_segredo_id is
  'vault.secrets.id do segredo com que o Chatwoot assina os webhooks deste canal.';

-- Dados do canal para conferir um webhook, incluindo o segredo da assinatura.
-- O id do canal vai na URL e não é segredo: quem prova a origem é a assinatura.
create function atendimento.canal_do_webhook(p_canal_id uuid)
returns table (
  canal_id uuid, tenant_id uuid, conta_externa text, base_url text, permite_http boolean,
  segredo_assinatura text
)
language sql
stable
security definer
set search_path = ''
as $$
  select c.id, c.tenant_id, c.conta_externa, c.base_url, c.permite_http, s.decrypted_secret
  from atendimento.canais c
  join nucleo.tenants t on t.id = c.tenant_id
  join vault.decrypted_secrets s on s.id = c.assinatura_segredo_id
  where c.id = p_canal_id and c.ativo and t.ativo;
$$;

create function atendimento.salvar_contato(p_tenant_id uuid, p_conversa_id uuid, p_contato text)
returns void
language sql
set search_path = ''
as $$
  update atendimento.conversas set contato = p_contato
  where id = p_conversa_id and tenant_id = p_tenant_id and contato is null;
$$;

revoke all on all functions in schema atendimento from public;
grant execute on all functions in schema atendimento to service_role;

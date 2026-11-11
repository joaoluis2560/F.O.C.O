-- Correção de corrida em atendimento.reivindicar_lote.
--
-- A conversa era escolhida com um retrato do banco e travada em seguida. Se
-- outro worker concluísse a reivindicação dele nesse intervalo, a trava era
-- obtida sobre uma conversa que o retrato ainda mostrava livre. Resultado:
-- lote vazio devolvido ao segundo worker ou, com mensagem nova na fila, dois
-- workers na mesma conversa.
--
-- Agora, depois de obter a trava, a situação é conferida de novo (cada
-- instrução em plpgsql enxerga o que já foi confirmado) e um lote vazio nunca
-- é devolvido.

create or replace function atendimento.reivindicar_lote(
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
  v_ids bigint[];
  v_texto text;
  v_anexos integer;
begin
  update atendimento.mensagens m
  set estado = case when m.tentativas >= 3 then 'falhou' else 'pendente' end
        ::atendimento.estado_mensagem,
      lease_ate = null,
      reivindicacao = null
  where m.direcao = 'entrada' and m.estado = 'processando' and m.lease_ate < now();

  -- Até cinco candidatas: se a escolhida acabou de ser reivindicada por outro
  -- worker, passa para a próxima em vez de voltar de mãos vazias.
  for v_tentativa in 1..5 loop
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

    -- Com a trava em mãos, confere de novo: outro worker pode ter acabado de
    -- reivindicar esta conversa. Cada instrução enxerga o que já foi confirmado,
    -- então a próxima volta do laço não a escolhe de novo.
    if exists (
      select 1 from atendimento.mensagens m
      where m.conversa_id = v_conversa and m.direcao = 'entrada' and m.estado = 'processando'
    ) then
      continue;
    end if;

    with lote as (
      update atendimento.mensagens m
      set estado = 'processando',
          lease_ate = now() + make_interval(secs => p_lease_seg),
          tentativas = m.tentativas + 1,
          reivindicacao = v_reivindicacao
      where m.conversa_id = v_conversa and m.direcao = 'entrada' and m.estado = 'pendente'
      returning m.id, m.texto, m.anexos
    )
    select array_agg(l.id order by l.id), string_agg(l.texto, E'\n' order by l.id),
           coalesce(sum(l.anexos), 0)::integer
    into v_ids, v_texto, v_anexos
    from lote l;

    exit when v_ids is not null;
  end loop;

  if v_ids is null then
    return;
  end if;

  return query
  select c.id, c.tenant_id, c.canal_id, c.conversa_externa, c.contato, c.humano,
         v_ids, v_texto, v_anexos, v_reivindicacao
  from atendimento.conversas c
  where c.id = v_conversa;
end;
$$;

revoke all on function atendimento.reivindicar_lote(integer, integer) from public;
grant execute on function atendimento.reivindicar_lote(integer, integer) to service_role;

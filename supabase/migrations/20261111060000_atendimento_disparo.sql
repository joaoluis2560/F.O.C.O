-- Disparo automático do worker de atendimento.
--
-- A cada 5 segundos o pg_cron executa atendimento.disparar_worker(). Ela só
-- chama a Edge Function quando há lote pronto na fila, então fila vazia não
-- gera invocação. A chamada é assíncrona (pg_net): o banco não espera o worker.
--
-- Endereço e credencial ficam no Vault, por ambiente:
--   foco_worker_url  URL da função atendimento-worker
--   foco_worker_jwt  JWT de serviço aceito pela função
-- Sem esses dois segredos o disparo não faz nada (é o caso de CI e de um
-- projeto recém-criado).

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Verdadeiro quando o worker teria o que fazer agora: conversa quieta há
-- `p_espera_seg` com mensagem pendente, ou lote preso com prazo vencido.
-- O valor padrão acompanha o do worker.
create function atendimento.ha_trabalho(p_espera_seg integer default 8)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from atendimento.mensagens m
    where m.direcao = 'entrada'
      and (
        (m.estado = 'processando' and m.lease_ate < now())
        or (
          m.estado = 'pendente'
          and not exists (
            select 1 from atendimento.mensagens r
            where r.conversa_id = m.conversa_id and r.direcao = 'entrada'
              and (r.estado = 'processando' and r.lease_ate >= now()
                   or (r.estado = 'pendente'
                       and r.criado_em > now() - make_interval(secs => p_espera_seg)))
          )
        )
      )
  );
$$;

-- Devolve o id da requisição enfileirada, ou nulo quando não disparou.
create function atendimento.disparar_worker()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_jwt text;
  v_id bigint;
begin
  if not atendimento.ha_trabalho() then
    return null;
  end if;

  select s.decrypted_secret into v_url
  from vault.decrypted_secrets s where s.name = 'foco_worker_url';
  select s.decrypted_secret into v_jwt
  from vault.decrypted_secrets s where s.name = 'foco_worker_jwt';
  if v_url is null or v_jwt is null then
    return null;
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_jwt,
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) into v_id;
  return v_id;
end;
$$;

revoke all on function atendimento.ha_trabalho(integer) from public;
revoke all on function atendimento.disparar_worker() from public;
grant execute on function atendimento.ha_trabalho(integer) to service_role;
grant execute on function atendimento.disparar_worker() to service_role;

select cron.schedule(
  'foco-atendimento-worker',
  '5 seconds',
  $$select atendimento.disparar_worker()$$
);

-- O histórico do pg_cron cresce uma linha a cada execução: guarda só um dia.
select cron.schedule(
  'foco-limpar-historico-cron',
  '17 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '1 day'$$
);

-- Atendimento: isolamento entre tenants, fila em lote e deduplicação.

begin;

create extension if not exists pgtap with schema extensions;

select plan(50);

select testes.fixtures();

select vault.create_secret('token-chatwoot-a', 'teste-chatwoot-a') as seg_a \gset
select vault.create_secret('token-chatwoot-b', 'teste-chatwoot-b') as seg_b \gset
select vault.create_secret('assinatura-a', 'teste-assinatura-a') as ass_a \gset
select vault.create_secret('assinatura-b', 'teste-assinatura-b') as ass_b \gset

insert into atendimento.canais
  (id, tenant_id, tipo, nome, conta_externa, base_url, segredo_id, assinatura_segredo_id)
values
  ('a3000000-0000-0000-0000-000000000000', testes.id('a'), 'chatwoot', 'whatsapp',
   '1', 'https://chat-a.example', :'seg_a', :'ass_a'),
  ('b3000000-0000-0000-0000-000000000000', testes.id('b'), 'chatwoot', 'whatsapp',
   '2', 'https://chat-b.example', :'seg_b', :'ass_b'),
  ('a4000000-0000-0000-0000-000000000000', testes.id('a'), 'chatwoot', 'sem-assinatura',
   '3', 'https://chat-a.example', :'seg_a', null);

insert into atendimento.config (tenant_id, modelo_barato, modelo_forte)
values (testes.id('a'), 'fornecedor/barato', 'fornecedor/forte'),
       (testes.id('b'), 'fornecedor/barato', 'fornecedor/forte');

-- Estrutura -----------------------------------------------------------------

select ok(
  (select bool_and(relrowsecurity) from pg_class
   where relnamespace = 'atendimento'::regnamespace and relkind = 'r'),
  'RLS habilitado em todas as tabelas de atendimento'
);
select ok(not has_schema_privilege('anon', 'atendimento', 'usage'), 'anon sem USAGE');
select ok(
  not has_function_privilege(
    'authenticated', 'atendimento.ler_segredo_canal(uuid, uuid)', 'execute'
  ),
  'authenticated não lê segredo de canal'
);
select ok(
  not has_function_privilege(
    'authenticated', 'atendimento.reivindicar_lote(integer, integer)', 'execute'
  ),
  'authenticated não reivindica lote'
);

-- Canal -----------------------------------------------------------------------

select results_eq(
  $$select tenant_id, segredo_assinatura
    from atendimento.canal_do_webhook('a3000000-0000-0000-0000-000000000000')$$,
  format($$values (%L::uuid, 'assinatura-a')$$, testes.id('a')),
  'id do canal resolve o tenant e o segredo da assinatura'
);
select is_empty(
  $$select 1 from atendimento.canal_do_webhook('c3000000-0000-0000-0000-000000000000')$$,
  'canal desconhecido não resolve'
);
select is_empty(
  $$select 1 from atendimento.canal_do_webhook('a4000000-0000-0000-0000-000000000000')$$,
  'canal sem segredo de assinatura não aceita webhook'
);
select ok(
  not has_function_privilege('authenticated', 'atendimento.canal_do_webhook(uuid)', 'execute'),
  'authenticated não lê o segredo da assinatura'
);
select is(
  atendimento.ler_segredo_canal(testes.id('a'), 'b3000000-0000-0000-0000-000000000000'),
  null,
  'Tenant A não lê o segredo do canal do Tenant B'
);

-- Fila ----------------------------------------------------------------------

select ok(
  atendimento.receber_mensagem(testes.id('a'), 'a3000000-0000-0000-0000-000000000000',
    '10', '5511999990001', 'm1', 'cliente', 'oi'),
  'mensagem nova entra'
);
select ok(
  not atendimento.receber_mensagem(testes.id('a'), 'a3000000-0000-0000-0000-000000000000',
    '10', '5511999990001', 'm1', 'cliente', 'oi'),
  'mensagem repetida não entra de novo'
);
select atendimento.receber_mensagem(testes.id('a'), 'a3000000-0000-0000-0000-000000000000',
  '10', '5511999990001', 'm2', 'cliente', 'tem tinta?');
select atendimento.receber_mensagem(testes.id('b'), 'b3000000-0000-0000-0000-000000000000',
  '10', '5511888880001', 'm1', 'cliente', 'olá do B');

select is_empty(
  'select 1 from atendimento.reivindicar_lote(8, 120)',
  'conversa com mensagem recente ainda não é entregue (cliente pode estar digitando)'
);

update atendimento.mensagens set criado_em = now() - interval '1 minute'
where tenant_id = testes.id('a');

select results_eq(
  'select tenant_id, texto, array_length(mensagem_ids, 1) from atendimento.reivindicar_lote(8, 120)',
  format($$values (%L::uuid, E'oi\ntem tinta?', 2)$$, testes.id('a')),
  'lote junta as mensagens da conversa quieta, em ordem'
);
select is_empty(
  'select 1 from atendimento.reivindicar_lote(8, 120)',
  'lote em processamento não é entregue duas vezes'
);

update atendimento.mensagens set lease_ate = now() - interval '1 second'
where tenant_id = testes.id('a') and estado = 'processando';
select isnt_empty(
  'select 1 from atendimento.reivindicar_lote(8, 120)',
  'lote com prazo vencido volta para a fila'
);

-- O lote foi reivindicado duas vezes: a primeira reivindicação perdeu a vez.
select reivindicacao as atual from atendimento.mensagens
where tenant_id = testes.id('a') and estado = 'processando' limit 1 \gset

select ok(
  not atendimento.concluir_lote(
    (select array_agg(id) from atendimento.mensagens where tenant_id = testes.id('a')),
    gen_random_uuid(), 'concluida'),
  'quem não tem a reivindicação atual não conclui o lote'
);
select ok(
  not atendimento.renovar_lote(
    (select array_agg(id) from atendimento.mensagens where tenant_id = testes.id('a')),
    gen_random_uuid()),
  'quem não tem a reivindicação atual não renova o prazo'
);
select is(
  (select count(*) from atendimento.mensagens
   where tenant_id = testes.id('a') and estado = 'processando'),
  2::bigint,
  'tentativa com reivindicação errada não altera o lote'
);
select ok(
  atendimento.renovar_lote(
    (select array_agg(id) from atendimento.mensagens where tenant_id = testes.id('a')),
    :'atual'),
  'dono da reivindicação renova o prazo'
);
select ok(
  atendimento.concluir_lote(
    (select array_agg(id) from atendimento.mensagens where tenant_id = testes.id('a')),
    :'atual', 'concluida'),
  'dono da reivindicação conclui o lote'
);
select is(
  (select count(*) from atendimento.mensagens
   where tenant_id = testes.id('a') and estado = 'concluida'),
  2::bigint,
  'lote concluído'
);

update atendimento.mensagens
set estado = 'processando', tentativas = 3, lease_ate = now() - interval '1 second'
where tenant_id = testes.id('a');
select is_empty(
  format(
    $$select 1 from atendimento.reivindicar_lote(8, 120) where tenant_id = %L$$, testes.id('a')
  ),
  'depois de três tentativas a mensagem não volta para a fila'
);
select is(
  (select count(*) from atendimento.mensagens
   where tenant_id = testes.id('a') and estado = 'falhou'),
  2::bigint,
  'mensagens esgotadas ficam como falhou'
);

-- Disparo do worker ------------------------------------------------------------

select ok(
  not has_function_privilege('authenticated', 'atendimento.disparar_worker()', 'execute'),
  'authenticated não dispara o worker'
);
select is(
  (select schedule from cron.job where jobname = 'foco-atendimento-worker'),
  '5 seconds',
  'disparo do worker está agendado'
);
select ok(
  not atendimento.ha_trabalho(),
  'sem mensagem pendente não há trabalho'
);
select is(atendimento.disparar_worker(), null, 'fila sem trabalho não gera chamada');

select atendimento.receber_mensagem(testes.id('a'), 'a3000000-0000-0000-0000-000000000000',
  '20', '5511999990002', 'd1', 'cliente', 'olá');
select ok(
  not atendimento.ha_trabalho(),
  'mensagem recém-chegada ainda não é trabalho (cliente pode estar digitando)'
);
update atendimento.mensagens set criado_em = now() - interval '1 minute'
where externa_id = 'd1';
select ok(atendimento.ha_trabalho(), 'conversa quieta com mensagem pendente é trabalho');

delete from vault.secrets where name in ('foco_worker_url', 'foco_worker_jwt');
select is(
  atendimento.disparar_worker(), null,
  'sem endereço e credencial no Vault o disparo não faz nada'
);

select vault.create_secret('http://worker.invalid/atendimento-worker', 'foco_worker_url');
select vault.create_secret('jwt-de-teste', 'foco_worker_jwt');
select isnt(
  atendimento.disparar_worker(), null,
  'com trabalho e segredos, a chamada ao worker é enfileirada'
);

select 1 from atendimento.reivindicar_lote(8, 120);
select ok(
  not atendimento.ha_trabalho(),
  'lote em processamento dentro do prazo não é trabalho novo'
);
update atendimento.mensagens set lease_ate = now() - interval '1 second'
where externa_id = 'd1';
select ok(atendimento.ha_trabalho(), 'lote preso com prazo vencido volta a ser trabalho');
select reivindicacao as d1 from atendimento.reivindicar_lote(8, 120) \gset
select atendimento.concluir_lote(
  (select array_agg(id) from atendimento.mensagens where externa_id = 'd1'), :'d1', 'concluida'
);

-- Orçamento com reserva -------------------------------------------------------

update atendimento.config set teto_diario_usd = 0.012 where tenant_id = testes.id('a');
select ok(atendimento.reservar_orcamento(testes.id('a'), 0.005), 'primeira reserva cabe no teto');
select ok(atendimento.reservar_orcamento(testes.id('a'), 0.005), 'segunda reserva cabe no teto');
select ok(
  not atendimento.reservar_orcamento(testes.id('a'), 0.005),
  'terceira reserva estouraria o teto e é negada'
);
select is(
  (select gasto_dia_usd from atendimento.uso_atual(testes.id('a'), gen_random_uuid())),
  0.010::numeric,
  'o que está reservado já conta como gasto do dia'
);
select atendimento.liquidar_orcamento(testes.id('a'), 0.005, 0.0004);
select atendimento.liquidar_orcamento(testes.id('a'), 0.005, 0.0004);
select results_eq(
  format(
    $$select gasto_usd, reservado_usd from atendimento.orcamento_dia where tenant_id = %L$$,
    testes.id('a')
  ),
  $$values (0.0008::numeric, 0::numeric)$$,
  'liquidar troca a reserva pelo custo real'
);
select ok(
  atendimento.reservar_orcamento(testes.id('a'), 0.005),
  'depois de liquidar, volta a haver espaço no teto'
);
select ok(
  atendimento.reservar_orcamento(testes.id('b'), 0.005),
  'reserva de um tenant não consome o teto de outro'
);
update atendimento.config set teto_diario_usd = 2 where tenant_id = testes.id('a');

select throws_ok(
  $$update atendimento.conversas set resumo = 'x' where conversa_externa = '20'$$,
  '23514', null,
  'resumo sem marcar até onde vai é recusado'
);

-- Humano assume ---------------------------------------------------------------

select atendimento.receber_mensagem(testes.id('a'), 'a3000000-0000-0000-0000-000000000000',
  '10', null, 'h1', 'humano', 'Oi, aqui é a Ana.');
select ok(
  (select humano from atendimento.conversas
   where tenant_id = testes.id('a') and conversa_externa = '10'),
  'resposta de pessoa da equipe marca a conversa como assumida'
);
select is(
  (select contato from atendimento.conversas
   where tenant_id = testes.id('a') and conversa_externa = '10'),
  '5511999990001',
  'mensagem sem telefone não apaga o telefone da conversa'
);
select throws_ok(
  format(
    $$select atendimento.receber_mensagem(%L, 'a3000000-0000-0000-0000-000000000000',
        '10', null, 'x1', 'agente', 'x')$$, testes.id('a')
  ),
  '22023', null,
  'mensagem com autor agente não entra pelo canal'
);

-- RLS -----------------------------------------------------------------------

select testes.como('a', 'owner');
select results_eq(
  'select distinct tenant_id from atendimento.mensagens',
  array[testes.id('a')],
  'owner A só enxerga mensagens do Tenant A'
);
select results_eq(
  'select distinct tenant_id from atendimento.conversas',
  array[testes.id('a')],
  'owner A só enxerga conversas (e resumos) do Tenant A'
);
select throws_ok(
  'select assinatura_segredo_id from atendimento.canais', '42501', null,
  'owner A não lê as referências de segredo do canal'
);
select is_empty(
  format($$select 1 from atendimento.config where tenant_id = %L$$, testes.id('b')),
  'owner A não enxerga a configuração do Tenant B'
);
reset role;

select testes.como('a', 'member');
select is_empty('select 1 from atendimento.mensagens', 'member A não enxerga mensagens');
reset role;

select testes.como_anon();
select throws_ok('select 1 from atendimento.mensagens', '42501', null, 'anon não lê mensagens');
reset role;

select * from finish();

rollback;

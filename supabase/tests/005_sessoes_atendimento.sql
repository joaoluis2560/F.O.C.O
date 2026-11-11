-- Sessões de atendimento: só o servidor abre, e um tenant não usa a de outro.

begin;

create extension if not exists pgtap with schema extensions;

select plan(15);

select testes.fixtures();

select nucleo.abrir_sessao_atendimento(testes.id('a'), '5511999990001', repeat('a', 64));
select nucleo.abrir_sessao_atendimento(testes.id('b'), '5511888880001', repeat('b', 64), 5);

-- Estrutura -----------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'nucleo.sessoes_atendimento'::regclass),
  'RLS habilitado em nucleo.sessoes_atendimento'
);
select ok(
  not has_function_privilege(
    'authenticated', 'nucleo.abrir_sessao_atendimento(uuid, text, text, integer)', 'execute'
  ),
  'authenticated não abre sessão'
);
select ok(
  not has_function_privilege('authenticated', 'nucleo.contato_da_sessao(uuid, text)', 'execute'),
  'authenticated não resolve sessão'
);
select ok(
  not has_function_privilege(
    'anon', 'nucleo.abrir_sessao_atendimento(uuid, text, text, integer)', 'execute'
  ),
  'anon não abre sessão'
);

-- Resolução -----------------------------------------------------------------

select is(
  nucleo.contato_da_sessao(testes.id('a'), repeat('a', 64)),
  '5511999990001',
  'sessão do Tenant A resolve o telefone'
);
select is(
  nucleo.contato_da_sessao(testes.id('b'), repeat('a', 64)),
  null,
  'Tenant B não resolve sessão do Tenant A'
);
select is(
  nucleo.contato_da_sessao(testes.id('a'), repeat('c', 64)),
  null,
  'token de sessão desconhecido não resolve'
);

update nucleo.sessoes_atendimento
set criado_em = now() - interval '2 hours', expira_em = now() - interval '1 hour'
where hash = repeat('a', 64);
select is(
  nucleo.contato_da_sessao(testes.id('a'), repeat('a', 64)),
  null,
  'sessão vencida não resolve'
);

update nucleo.tenants set ativo = false where id = testes.id('b');
select is(
  nucleo.contato_da_sessao(testes.id('b'), repeat('b', 64)),
  null,
  'sessão de tenant desativado não resolve'
);
select throws_ok(
  format(
    $$select nucleo.abrir_sessao_atendimento(%L, '5511888880002', %L)$$,
    testes.id('b'), repeat('d', 64)
  ),
  '42501', null,
  'não se abre sessão em tenant desativado'
);
update nucleo.tenants set ativo = true where id = testes.id('b');

-- Abertura ------------------------------------------------------------------

select nucleo.abrir_sessao_atendimento(testes.id('a'), '5511999990002', repeat('e', 64));
select is_empty(
  format($$select 1 from nucleo.sessoes_atendimento where hash = %L$$, repeat('a', 64)),
  'abrir sessão remove as vencidas do tenant'
);
select throws_ok(
  format(
    $$select nucleo.abrir_sessao_atendimento(%L, 'abc', %L)$$, testes.id('a'), repeat('f', 64)
  ),
  '23514', null,
  'telefone fora do formato é recusado'
);
select throws_ok(
  format(
    $$select nucleo.abrir_sessao_atendimento(%L, '5511999990003', %L, 100000)$$,
    testes.id('a'), repeat('f', 64)
  ),
  '22023', null,
  'validade acima do teto é recusada'
);

-- RLS -----------------------------------------------------------------------

select testes.como('a', 'owner');
select throws_ok(
  'select * from nucleo.sessoes_atendimento', '42501', null,
  'owner não lê sessões de atendimento'
);
reset role;

select testes.como_anon();
select throws_ok(
  'select * from nucleo.sessoes_atendimento', '42501', null,
  'anon não lê sessões de atendimento'
);
reset role;

select * from finish();

rollback;

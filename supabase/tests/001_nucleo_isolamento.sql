-- Isolamento entre tenants no schema `nucleo`.
-- Acesso cruzado aceitável: erro de autorização ou zero linhas. Nunca o objeto.

begin;

create extension if not exists pgtap with schema extensions;

select plan(22);

select testes.fixtures();

-- Estrutura -----------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'nucleo.tenants'::regclass),
  'RLS habilitado em nucleo.tenants'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'nucleo.membros'::regclass),
  'RLS habilitado em nucleo.membros'
);
select ok(
  not has_schema_privilege('anon', 'nucleo', 'usage'),
  'anon sem USAGE no schema nucleo'
);
select ok(
  not has_function_privilege('anon', 'nucleo.eh_membro(uuid)', 'execute'),
  'anon não executa nucleo.eh_membro'
);

-- anon ----------------------------------------------------------------------

select testes.como_anon();

select throws_ok(
  'select * from nucleo.tenants',
  '42501', null,
  'anon não lê tenants'
);
select throws_ok(
  'select * from nucleo.membros',
  '42501', null,
  'anon não lê membros'
);

reset role;

-- owner do Tenant A ---------------------------------------------------------

select testes.como('a', 'owner');

select results_eq(
  'select id from nucleo.tenants',
  array[testes.id('a')],
  'owner A enxerga só o Tenant A'
);
select is(
  (select count(*) from nucleo.membros where tenant_id = testes.id('a')),
  4::bigint,
  'owner A enxerga os 4 vínculos do Tenant A'
);
select is_empty(
  format('select 1 from nucleo.membros where tenant_id = %L', testes.id('b')),
  'owner A não enxerga membros do Tenant B'
);
select is_empty(
  format('select 1 from nucleo.tenants where id = %L', testes.id('b')),
  'owner A não enxerga o Tenant B pelo id'
);
select ok(not nucleo.eh_membro(testes.id('b')), 'owner A não é membro do Tenant B');
select ok(
  nucleo.tem_papel(testes.id('a'), array['owner']::nucleo.papel[]),
  'owner A tem papel owner no Tenant A'
);
select throws_ok(
  format('update nucleo.tenants set nome = %L where id = %L', 'invadido', testes.id('b')),
  '42501', null,
  'owner A não altera o Tenant B'
);
select throws_ok(
  format('delete from nucleo.membros where tenant_id = %L', testes.id('b')),
  '42501', null,
  'owner A não exclui membros do Tenant B'
);

reset role;

-- member do Tenant A --------------------------------------------------------

select testes.como('a', 'member');

select results_eq(
  'select id from nucleo.tenants',
  array[testes.id('a')],
  'member A enxerga só o Tenant A'
);
select ok(
  not nucleo.tem_papel(testes.id('a'), array['owner', 'admin']::nucleo.papel[]),
  'member A não tem papel owner/admin'
);
select throws_ok(
  format(
    'insert into nucleo.membros (tenant_id, user_id, papel) values (%L, %L, %L)',
    testes.id('b'), testes.id('a', 'member'), 'owner'
  ),
  '42501', null,
  'member A não se adiciona ao Tenant B'
);
select throws_ok(
  format(
    'update nucleo.membros set papel = %L where user_id = %L',
    'owner', testes.id('a', 'member')
  ),
  '42501', null,
  'member A não promove a si mesmo'
);

reset role;

-- usuário inativo do Tenant A -----------------------------------------------

select testes.como('a', 'inativo');

select is_empty('select 1 from nucleo.tenants', 'inativo A não enxerga nenhum tenant');
select is_empty('select 1 from nucleo.membros', 'inativo A não enxerga nenhum membro');

reset role;

-- tenant desativado ---------------------------------------------------------

update nucleo.tenants set ativo = false where id = testes.id('b');

select testes.como('b', 'owner');

select is_empty('select 1 from nucleo.tenants', 'owner de tenant desativado não enxerga tenants');
select is_empty('select 1 from nucleo.membros', 'owner de tenant desativado não enxerga membros');

reset role;

select * from finish();

rollback;

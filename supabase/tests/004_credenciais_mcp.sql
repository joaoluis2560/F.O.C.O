-- Credenciais do MCP e leitura de segredo: isolamento entre tenants.

begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

select testes.fixtures();

insert into nucleo.credenciais (tenant_id, nome, perfil, hash)
values
  (testes.id('a'), 'atendimento', 'atendimento', repeat('a', 64)),
  (testes.id('a'), 'hermes', 'equipe', repeat('c', 64)),
  (testes.id('a'), 'antiga', 'equipe', repeat('d', 64)),
  (testes.id('b'), 'atendimento', 'atendimento', repeat('b', 64));

update nucleo.credenciais set revogada_em = now() where hash = repeat('d', 64);

select vault.create_secret('segredo-do-tenant-a', 'teste-erp-a') as segredo_a \gset
select vault.create_secret('segredo-do-tenant-b', 'teste-erp-b') as segredo_b \gset

insert into integracao.integracoes (id, tenant_id, nome, base_url, tipo_auth, segredo_id)
values
  ('a1000000-0000-0000-0000-000000000000', testes.id('a'), 'erp', 'https://erp-a.example',
   'bearer', :'segredo_a'),
  ('b1000000-0000-0000-0000-000000000000', testes.id('b'), 'erp', 'https://erp-b.example',
   'bearer', :'segredo_b');

-- Estrutura -----------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'nucleo.credenciais'::regclass),
  'RLS habilitado em nucleo.credenciais'
);
select ok(
  not has_function_privilege('authenticated', 'nucleo.identificar_credencial(text)', 'execute'),
  'authenticated não executa identificar_credencial'
);
select ok(
  not has_function_privilege('authenticated', 'integracao.ler_segredo(uuid, uuid)', 'execute'),
  'authenticated não executa ler_segredo'
);
select ok(
  not has_function_privilege('anon', 'integracao.ler_segredo(uuid, uuid)', 'execute'),
  'anon não executa ler_segredo'
);

-- Identificação ---------------------------------------------------------------

select results_eq(
  format($$select tenant_id, perfil::text from nucleo.identificar_credencial(%L)$$, repeat('a', 64)),
  format($$values (%L::uuid, 'atendimento')$$, testes.id('a')),
  'token do Tenant A resolve para o Tenant A'
);
select results_eq(
  format($$select tenant_id, perfil::text from nucleo.identificar_credencial(%L)$$, repeat('c', 64)),
  format($$values (%L::uuid, 'equipe')$$, testes.id('a')),
  'perfil vem da credencial'
);
select isnt(
  (select ultimo_uso from nucleo.credenciais where hash = repeat('a', 64)),
  null,
  'uso da credencial fica registrado'
);
select is_empty(
  format($$select 1 from nucleo.identificar_credencial(%L)$$, repeat('d', 64)),
  'credencial revogada não identifica'
);
select is_empty(
  format($$select 1 from nucleo.identificar_credencial(%L)$$, repeat('e', 64)),
  'token desconhecido não identifica'
);

update nucleo.tenants set ativo = false where id = testes.id('b');
select is_empty(
  format($$select 1 from nucleo.identificar_credencial(%L)$$, repeat('b', 64)),
  'credencial de tenant desativado não identifica'
);
update nucleo.tenants set ativo = true where id = testes.id('b');

-- Segredo -------------------------------------------------------------------

select is(
  integracao.ler_segredo(testes.id('a'), 'a1000000-0000-0000-0000-000000000000'),
  'segredo-do-tenant-a',
  'servidor lê o segredo da integração do próprio tenant'
);
select is(
  integracao.ler_segredo(testes.id('a'), 'b1000000-0000-0000-0000-000000000000'),
  null,
  'Tenant A não lê segredo de integração do Tenant B'
);

-- RLS -----------------------------------------------------------------------

select testes.como('a', 'owner');
select results_eq(
  'select nome from nucleo.credenciais order by nome',
  array['antiga', 'atendimento', 'hermes'],
  'owner A enxerga só credenciais do Tenant A'
);
select throws_ok(
  'select hash from nucleo.credenciais',
  '42501', null,
  'owner A não lê o hash das credenciais'
);
reset role;

select testes.como('a', 'member');
select is_empty('select nome from nucleo.credenciais', 'member A não enxerga credenciais');
reset role;

select testes.como_anon();
select throws_ok('select nome from nucleo.credenciais', '42501', null, 'anon não lê credenciais');
reset role;

select * from finish();

rollback;

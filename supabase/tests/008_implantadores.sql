-- Canal de implantação: só o telefone do cadastro conduz a entrevista, e esse
-- telefone não vaza para outros tenants nem para quem não administra a empresa.

begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

select testes.fixtures();

insert into atendimento.implantadores (tenant_id, telefone) values
  (testes.id('a'), '5511999990001'),
  (testes.id('b'), '5511999990002');

-- Estrutura -----------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'atendimento.implantadores'::regclass),
  'RLS habilitado em atendimento.implantadores'
);
select ok(
  not has_function_privilege('authenticated', 'atendimento.pode_implantar(uuid, text)', 'execute'),
  'authenticated não consulta quem pode implantar'
);
select ok(
  not has_function_privilege('anon', 'atendimento.pode_implantar(uuid, text)', 'execute'),
  'anon não consulta quem pode implantar'
);
select is(
  (select column_default from information_schema.columns
   where table_schema = 'atendimento' and table_name = 'canais' and column_name = 'finalidade'),
  $$'atendimento'::atendimento.finalidade_canal$$,
  'canal nasce com finalidade de atendimento'
);

-- Conferência do telefone -----------------------------------------------------

select ok(atendimento.pode_implantar(testes.id('a'), '5511999990001'),
  'telefone do cadastro conduz a implantação da própria empresa');
select ok(not atendimento.pode_implantar(testes.id('a'), '5511999990002'),
  'telefone cadastrado em outro tenant não conduz a implantação deste');
select ok(not atendimento.pode_implantar(testes.id('b'), '5511999990001'),
  'telefone do Tenant A não conduz a implantação do Tenant B');
select ok(not atendimento.pode_implantar(testes.id('a'), '5511999990009'),
  'telefone desconhecido é recusado');
select ok(not atendimento.pode_implantar(testes.id('a'), null),
  'contato sem telefone é recusado');
select throws_ok(
  format($$insert into atendimento.implantadores (tenant_id, telefone)
           values (%L, '+55 (11) 99999-0001')$$, gen_random_uuid()),
  '23514', null,
  'telefone fora do formato é recusado'
);

-- Leitura por papel -----------------------------------------------------------

select testes.como('a', 'owner');
select results_eq(
  'select telefone from atendimento.implantadores',
  $$values ('5511999990001')$$,
  'owner vê só o telefone de implantação do próprio tenant'
);
select throws_ok(
  format($$update atendimento.implantadores set telefone = '5511999990009'
           where tenant_id = %L$$, testes.id('a')),
  '42501', null,
  'owner não troca o telefone direto na tabela'
);
reset role;

select testes.como('a', 'member');
select is_empty('select 1 from atendimento.implantadores', 'member não vê o telefone do dono');
reset role;

select testes.como('a', 'inativo');
select is_empty('select 1 from atendimento.implantadores', 'membro inativo não vê nada');
reset role;

select testes.como('b', 'admin');
select results_eq(
  'select telefone from atendimento.implantadores',
  $$values ('5511999990002')$$,
  'admin do Tenant B não vê o telefone do Tenant A'
);
reset role;

select testes.como_anon();
select throws_ok('select 1 from atendimento.implantadores', '42501', null, 'anon não lê a tabela');
reset role;

select * from finish();

rollback;

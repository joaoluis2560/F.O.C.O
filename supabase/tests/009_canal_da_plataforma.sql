-- Canal único da plataforma: a empresa é resolvida pelo telefone de quem
-- escreve, e um telefone nunca alcança a empresa de outro.

begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

select testes.fixtures();

insert into atendimento.implantadores (tenant_id, telefone) values
  (testes.id('a'), '5511999990001'),
  (testes.id('b'), '5511999990002');

select vault.create_secret('token', 'teste-plataforma') as seg \gset

-- Estrutura -----------------------------------------------------------------

select is(
  (select column_default from information_schema.columns
   where table_schema = 'atendimento' and table_name = 'canais' and column_name = 'compartilhado'),
  'false',
  'canal nasce sem ser compartilhado'
);
select ok(
  not has_function_privilege('authenticated', 'atendimento.empresas_do_implantador(text)', 'execute'),
  'authenticated não descobre empresa por telefone'
);
select ok(
  not has_function_privilege('anon', 'atendimento.empresas_do_implantador(text)', 'execute'),
  'anon não descobre empresa por telefone'
);
select throws_ok(
  format($$insert into atendimento.canais
             (tenant_id, tipo, nome, conta_externa, base_url, segredo_id, compartilhado)
           values (%L, 'chatwoot', 'errado', '9', 'https://chat.example', %L, true)$$,
         testes.id('a'), :'seg'),
  '23514', null,
  'canal de atendimento a clientes não pode ser compartilhado'
);
select lives_ok(
  format($$insert into atendimento.canais
             (tenant_id, tipo, nome, conta_externa, base_url, segredo_id, finalidade, compartilhado)
           values (%L, 'chatwoot', 'plataforma', '9', 'https://chat.example', %L,
                   'implantacao', true)$$,
         testes.id('a'), :'seg'),
  'canal de implantação pode ser compartilhado'
);

-- Resolução da empresa --------------------------------------------------------

select results_eq(
  $$select tenant_id from atendimento.empresas_do_implantador('5511999990001')$$,
  format($$values (%L::uuid)$$, testes.id('a')),
  'telefone do dono do Tenant A resolve só o Tenant A'
);
select results_eq(
  $$select tenant_id from atendimento.empresas_do_implantador('5511999990002')$$,
  format($$values (%L::uuid)$$, testes.id('b')),
  'telefone do dono do Tenant B resolve só o Tenant B'
);
select is_empty(
  $$select 1 from atendimento.empresas_do_implantador('5511999990009')$$,
  'telefone desconhecido não resolve empresa nenhuma'
);
select is_empty(
  $$select 1 from atendimento.empresas_do_implantador(null)$$,
  'contato sem telefone não resolve empresa nenhuma'
);

-- O mesmo telefone em duas empresas: o chamador precisa enxergar a ambiguidade.
update atendimento.implantadores set telefone = '5511999990001' where tenant_id = testes.id('b');
select is(
  (select count(*)::int from atendimento.empresas_do_implantador('5511999990001')),
  2,
  'telefone cadastrado em duas empresas devolve as duas'
);

select testes.como('a', 'owner');
select throws_ok(
  $$select * from atendimento.empresas_do_implantador('5511999990002')$$,
  '42501', null,
  'owner não consulta de quem é um telefone'
);
reset role;

select * from finish();

rollback;

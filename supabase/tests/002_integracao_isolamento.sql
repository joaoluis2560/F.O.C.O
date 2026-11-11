-- Isolamento e invariantes do schema `integracao`.

begin;

create extension if not exists pgtap with schema extensions;

select plan(20);

select testes.fixtures();

-- Dados de apoio (como servidor) ----------------------------------------------

insert into integracao.integracoes (id, tenant_id, nome, base_url)
values
  ('a1000000-0000-0000-0000-000000000000', testes.id('a'), 'erp', 'https://erp-a.example'),
  ('b1000000-0000-0000-0000-000000000000', testes.id('b'), 'erp', 'https://erp-b.example');

insert into integracao.conectores
  (id, tenant_id, integracao_id, capacidade, tipo, definicao, hash, estado, aprovado_em)
values
  ('a2000000-0000-0000-0000-000000000000', testes.id('a'),
   'a1000000-0000-0000-0000-000000000000', 'produtos.consultar', 'leitura',
   '{"requisicao": {"metodo": "GET", "caminho": "/p"}}', repeat('a', 64), 'aprovado', now()),
  ('b2000000-0000-0000-0000-000000000000', testes.id('b'),
   'b1000000-0000-0000-0000-000000000000', 'produtos.consultar', 'leitura',
   '{"requisicao": {"metodo": "GET", "caminho": "/p"}}', repeat('b', 64), 'aprovado', now());

insert into integracao.conector_execucoes (tenant_id, conector_id, capacidade, ok, duracao_ms)
values
  (testes.id('a'), 'a2000000-0000-0000-0000-000000000000', 'produtos.consultar', true, 10),
  (testes.id('b'), 'b2000000-0000-0000-0000-000000000000', 'produtos.consultar', true, 10);

-- Estrutura -----------------------------------------------------------------

select ok(
  (select bool_and(relrowsecurity) from pg_class
   where relnamespace = 'integracao'::regnamespace and relkind = 'r'),
  'RLS habilitado em todas as tabelas de integracao'
);
select ok(
  not has_schema_privilege('anon', 'integracao', 'usage'),
  'anon sem USAGE no schema integracao'
);

-- Invariantes ---------------------------------------------------------------

select throws_ok(
  format(
    $$insert into integracao.conectores (tenant_id, integracao_id, capacidade, tipo, definicao, hash)
      values (%L, %L, 'estoque.consultar', 'leitura', '{}', %L)$$,
    testes.id('a'), 'b1000000-0000-0000-0000-000000000000', repeat('c', 64)
  ),
  '23503', null,
  'conector do Tenant A não aponta para integração do Tenant B'
);
select throws_ok(
  format(
    $$insert into integracao.conectores
        (tenant_id, integracao_id, capacidade, tipo, definicao, hash, estado, aprovado_em, versao)
      values (%L, %L, 'produtos.consultar', 'leitura', '{}', %L, 'aprovado', now(), 2)$$,
    testes.id('a'), 'a1000000-0000-0000-0000-000000000000', repeat('d', 64)
  ),
  '23505', null,
  'só um conector aprovado por capacidade em cada tenant'
);
select throws_ok(
  $$update integracao.conectores set definicao = '{"alterado": true}'
    where id = 'a2000000-0000-0000-0000-000000000000'$$,
  '23514', null,
  'conector aprovado não tem a definição alterada'
);
select lives_ok(
  $$update integracao.conectores set estado = 'degradado'
    where id = 'a2000000-0000-0000-0000-000000000000'$$,
  'conector aprovado pode ser marcado como degradado'
);
select throws_ok(
  format(
    $$insert into integracao.integracoes (tenant_id, nome, base_url)
      values (%L, 'inseguro', 'http://erp.example')$$,
    testes.id('a')
  ),
  '23514', null,
  'base_url http é recusada sem permite_http'
);
select throws_ok(
  format(
    $$insert into integracao.integracoes (tenant_id, nome, base_url, tipo_auth)
      values (%L, 'sem-segredo', 'https://erp.example', 'bearer')$$,
    testes.id('a')
  ),
  '23514', null,
  'autenticação exige referência a segredo'
);

-- anon ----------------------------------------------------------------------

select testes.como_anon();
select throws_ok('select * from integracao.integracoes', '42501', null, 'anon não lê integracoes');
select throws_ok('select * from integracao.conectores', '42501', null, 'anon não lê conectores');
reset role;

-- owner do Tenant A ---------------------------------------------------------

select testes.como('a', 'owner');

select results_eq(
  'select tenant_id from integracao.integracoes',
  array[testes.id('a')],
  'owner A enxerga só integrações do Tenant A'
);
select results_eq(
  'select tenant_id from integracao.conectores',
  array[testes.id('a')],
  'owner A enxerga só conectores do Tenant A'
);
select results_eq(
  'select tenant_id from integracao.conector_execucoes',
  array[testes.id('a')],
  'owner A enxerga só execuções do Tenant A'
);
select is_empty(
  $$select 1 from integracao.conectores where id = 'b2000000-0000-0000-0000-000000000000'$$,
  'owner A não enxerga conector do Tenant B pelo id'
);
select throws_ok(
  $$update integracao.conectores set estado = 'arquivado'
    where id = 'b2000000-0000-0000-0000-000000000000'$$,
  '42501', null,
  'owner A não altera conector do Tenant B'
);
select throws_ok(
  format(
    $$insert into integracao.integracoes (tenant_id, nome, base_url)
      values (%L, 'invasor', 'https://x.example')$$,
    testes.id('a')
  ),
  '42501', null,
  'owner A não cria integração direto (escrita só pelo servidor)'
);

reset role;

-- admin, member e inativo do Tenant A ----------------------------------------

select testes.como('a', 'admin');
select isnt_empty('select 1 from integracao.conectores', 'admin A enxerga conectores do Tenant A');
reset role;

select testes.como('a', 'member');
select is_empty('select 1 from integracao.integracoes', 'member A não enxerga integrações');
select is_empty('select 1 from integracao.conectores', 'member A não enxerga conectores');
reset role;

select testes.como('a', 'inativo');
select is_empty('select 1 from integracao.conectores', 'inativo A não enxerga conectores');
reset role;

select * from finish();

rollback;

-- Segundo cérebro: isolamento, visibilidade, busca, revisão e auditoria.

begin;

create extension if not exists pgtap with schema extensions;

select plan(33);

select testes.fixtures();

-- Dados de apoio (como servidor) ----------------------------------------------

create temp table ids (nome text primary key, id uuid) on commit drop;
grant select on ids to authenticated, anon;

with novos as (
  select row_number() over () as n, id
  from cerebro.propor_fatos(
    testes.id('a'),
    '[
      {"dominio": "operacao", "tipo": "informacao", "titulo": "Horário de funcionamento",
       "texto": "Atendemos de segunda a sexta, das 8h às 18h, e aos sábados das 8h às 12h.",
       "visibilidade": "publico", "chaves": ["Horário", "funcionamento"]},
      {"dominio": "vendas", "tipo": "regra", "titulo": "Política de troca",
       "texto": "Trocas em até 30 dias com nota fiscal e produto sem uso.",
       "visibilidade": "publico", "chaves": ["troca", "devolução"]},
      {"dominio": "financeiro", "tipo": "regra", "titulo": "Desconto máximo sem aprovação",
       "texto": "Vendedor pode dar até 5% de desconto. Acima disso, só a gerência.",
       "visibilidade": "interno", "chaves": ["desconto"]},
      {"dominio": "financeiro", "tipo": "informacao", "titulo": "Margem por linha de produto",
       "texto": "Ferramentas elétricas têm margem alvo de 32%.",
       "visibilidade": "restrito", "chaves": ["margem"]},
      {"dominio": "vendas", "tipo": "faq", "titulo": "Frete grátis",
       "texto": "Frete grátis para compras acima de R$ 500 na região metropolitana.",
       "visibilidade": "publico", "chaves": ["frete"]}
    ]'::jsonb,
    'pacote'
  ) as id
)
insert into ids
select (array['horario', 'troca', 'desconto', 'margem', 'frete'])[n], id from novos;

insert into ids
select 'b_horario', id
from cerebro.propor_fatos(
  testes.id('b'),
  '[{"titulo": "Horário de funcionamento", "texto": "Aberto 24 horas, todos os dias.",
     "visibilidade": "publico", "chaves": ["horario"]}]'::jsonb,
  'pacote'
) as id;

-- Estrutura -----------------------------------------------------------------

select ok(
  (select bool_and(relrowsecurity) from pg_class
   where relnamespace = 'cerebro'::regnamespace and relkind = 'r'),
  'RLS habilitado em todas as tabelas do cerebro'
);
select ok(
  not has_schema_privilege('anon', 'cerebro', 'usage'),
  'anon sem USAGE no schema cerebro'
);
select ok(
  not has_function_privilege(
    'authenticated', 'cerebro.buscar_interno(uuid, text, cerebro.dominio, integer)', 'execute'
  ),
  'authenticated não executa as funções de busca do servidor'
);
select ok(
  not has_function_privilege(
    'authenticated', 'cerebro.revisar_fato(uuid, uuid, uuid, text, cerebro.visibilidade)', 'execute'
  ),
  'authenticated não executa revisar_fato'
);

-- Proposta e revisão ----------------------------------------------------------

select is(
  (select count(*) from cerebro.fatos where status = 'proposto'),
  6::bigint,
  'fatos nascem como proposto'
);
select is_empty(
  format($$select 1 from cerebro.buscar_publico(%L, 'horario de funcionamento')$$, testes.id('a')),
  'fato proposto não aparece na busca'
);
select throws_ok(
  format(
    $$update cerebro.fatos set status = 'ativo' where id = %L$$,
    (select id from ids where nome = 'horario')
  ),
  '23514', null,
  'fato público não fica ativo sem revisor'
);
select throws_ok(
  format(
    $$select cerebro.revisar_fato(%L, %L, %L, 'ativar')$$,
    testes.id('a'), (select id from ids where nome = 'horario'), testes.id('a', 'member')
  ),
  '42501', null,
  'member não revisa fato'
);
select throws_ok(
  format(
    $$select cerebro.revisar_fato(%L, %L, %L, 'ativar')$$,
    testes.id('a'), (select id from ids where nome = 'horario'), testes.id('b', 'owner')
  ),
  '42501', null,
  'owner do Tenant B não revisa fato do Tenant A'
);
select throws_ok(
  format(
    $$select cerebro.revisar_fato(%L, %L, %L, 'ativar')$$,
    testes.id('b'), (select id from ids where nome = 'horario'), testes.id('b', 'owner')
  ),
  'P0002', null,
  'owner B não ativa fato do Tenant A informando o próprio tenant'
);
select throws_ok(
  format(
    $$select cerebro.revisar_fato(%L, %L, %L, 'ativar')$$,
    testes.id('a'), (select id from ids where nome = 'horario'), testes.id('a', 'inativo')
  ),
  '42501', null,
  'usuário inativo não revisa fato'
);

select cerebro.revisar_fato(testes.id('a'), i.id, testes.id('a', 'owner'), 'ativar')
from ids i where i.nome in ('horario', 'troca', 'desconto', 'margem');
select cerebro.revisar_fato(testes.id('b'), i.id, testes.id('b', 'admin'), 'ativar')
from ids i where i.nome = 'b_horario';

select is(
  (select count(*) from cerebro.fatos where status = 'ativo'),
  5::bigint,
  'owner e admin ativam fatos do próprio tenant'
);

-- Busca ---------------------------------------------------------------------

select results_eq(
  format(
    $$select id from cerebro.buscar_publico(%L, 'Qual o horário de funcionamento de vocês?') limit 1$$,
    testes.id('a')
  ),
  format($$select id from ids where nome = 'horario'$$),
  'pergunta com acento e palavras a mais encontra o fato certo'
);
select results_eq(
  format($$select id from cerebro.buscar_publico(%L, 'horaio de funcionameto') limit 1$$, testes.id('a')),
  format($$select id from ids where nome = 'horario'$$),
  'erro de digitação ainda encontra o fato'
);
select results_eq(
  format($$select id from cerebro.buscar_publico(%L, 'posso fazer devolucao?') limit 1$$, testes.id('a')),
  format($$select id from ids where nome = 'troca'$$),
  'chave sem acento na pergunta encontra o fato'
);
select is_empty(
  format($$select 1 from cerebro.buscar_publico(%L, 'desconto máximo do vendedor')$$, testes.id('a')),
  'busca pública não devolve fato interno'
);
select is_empty(
  format($$select 1 from cerebro.buscar_publico(%L, 'margem ferramentas elétricas')$$, testes.id('a')),
  'busca pública não devolve fato restrito'
);
select is_empty(
  format($$select 1 from cerebro.buscar_publico(%L, 'frete grátis')$$, testes.id('a')),
  'busca pública não devolve fato ainda proposto'
);
select isnt_empty(
  format($$select 1 from cerebro.buscar_interno(%L, 'desconto máximo do vendedor')$$, testes.id('a')),
  'busca interna devolve fato interno'
);
select is_empty(
  format($$select 1 from cerebro.buscar_interno(%L, 'margem ferramentas elétricas')$$, testes.id('a')),
  'busca interna não devolve fato restrito'
);
select results_eq(
  format($$select texto from cerebro.buscar_publico(%L, 'horario de funcionamento')$$, testes.id('b')),
  array['Aberto 24 horas, todos os dias.'],
  'busca do Tenant B só devolve fato do Tenant B'
);
select is_empty(
  format($$select 1 from cerebro.buscar_publico(%L, 'troca')$$, testes.id('b')),
  'busca do Tenant B não enxerga fato do Tenant A'
);
select is_empty(
  format($$select 1 from cerebro.buscar_publico(%L, 'horario', 'financeiro')$$, testes.id('a')),
  'filtro de domínio é respeitado'
);
select is_empty(
  format($$select 1 from cerebro.buscar_publico(%L, '')$$, testes.id('a')),
  'termo vazio não devolve nada'
);

select cerebro.revisar_fato(
  testes.id('a'), (select id from ids where nome = 'troca'), testes.id('a', 'admin'), 'arquivar'
);
select is_empty(
  format($$select 1 from cerebro.buscar_publico(%L, 'troca devolução')$$, testes.id('a')),
  'fato arquivado sai da busca'
);

-- Auditoria -------------------------------------------------------------------

select results_eq(
  format(
    $$select acao, para ->> 'status' from cerebro.revisoes where fato_id = %L order by id$$,
    (select id from ids where nome = 'troca')
  ),
  $$values ('criar', 'proposto'), ('alterar', 'ativo'), ('alterar', 'arquivado')$$,
  'toda mudança de fato fica na trilha de revisões'
);

-- RLS: leitura por membros ------------------------------------------------------

select testes.como_anon();
select throws_ok('select * from cerebro.fatos', '42501', null, 'anon não lê fatos');
reset role;

select testes.como('a', 'member');
select results_eq(
  'select distinct tenant_id from cerebro.fatos',
  array[testes.id('a')],
  'member A só enxerga fatos do Tenant A'
);
select is_empty(
  $$select 1 from cerebro.fatos where visibilidade = 'restrito'$$,
  'member A não enxerga fato restrito'
);
select is_empty(
  $$select 1 from cerebro.chaves where chave = 'margem'$$,
  'member A não enxerga chave de fato restrito'
);
select is_empty('select 1 from cerebro.revisoes', 'member A não enxerga revisões');
reset role;

select testes.como('a', 'owner');
select isnt_empty(
  $$select 1 from cerebro.grafo where chave = 'margem'$$,
  'owner A enxerga fato restrito pelo grafo'
);
select is_empty(
  format($$select 1 from cerebro.grafo where tenant_id = %L$$, testes.id('b')),
  'owner A não enxerga o grafo do Tenant B'
);
reset role;

select * from finish();

rollback;

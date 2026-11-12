-- Propostas de agente e revisão pelo dono: nada fica ativo sem aprovação humana.

begin;

create extension if not exists pgtap with schema extensions;

select plan(34);

select testes.fixtures();

create temp table ids (nome text primary key, id uuid) on commit drop;
grant select on ids to authenticated, anon;

insert into ids values
  ('tom_a', atendimento.propor_orientacao(
     testes.id('a'), 'tom', 'Tratar por você, sem emoji.', 'Dono pediu.', 'agente')),
  ('limite_a', atendimento.propor_orientacao(
     testes.id('a'), 'limite', 'Não prometer prazo de entrega.', null, 'pacote')),
  ('tom_b', atendimento.propor_orientacao(
     testes.id('b'), 'tom', 'Linguagem formal.', null, 'agente')),
  ('fato_a', cerebro.propor_fato_de_agente(
     testes.id('a'),
     '{"titulo": "Aceita Pix", "texto": "Aceitamos Pix com 3% de desconto.",
       "visibilidade": "publico", "chaves": ["pix"]}'::jsonb));

-- Estrutura -----------------------------------------------------------------

select ok(
  (select relrowsecurity from pg_class where oid = 'atendimento.orientacoes'::regclass),
  'RLS habilitado em atendimento.orientacoes'
);
select ok(
  not has_function_privilege(
    'authenticated',
    'atendimento.propor_orientacao(uuid, atendimento.categoria_orientacao, text, text, text, text)',
    'execute'),
  'authenticated não cria proposta direto (só o servidor)'
);
select ok(
  not has_function_privilege(
    'authenticated', 'atendimento.revisar_orientacao(uuid, uuid, uuid, text)', 'execute'),
  'authenticated não chama a revisão que aceita revisor por parâmetro'
);
select ok(
  not has_function_privilege('anon', 'atendimento.minha_revisao_de_orientacao(uuid, text)', 'execute'),
  'anon não revisa orientação'
);
select ok(
  not has_function_privilege(
    'anon', 'cerebro.minha_revisao_de_fato(uuid, text, cerebro.visibilidade)', 'execute'),
  'anon não revisa fato'
);

-- Proposta ------------------------------------------------------------------

select is(
  (select count(*) from atendimento.orientacoes where status = 'proposta'), 3::bigint,
  'orientação nasce como proposta'
);
select results_eq(
  format($$select status::text, origem::text from cerebro.fatos where id = %L$$,
         (select id from ids where nome = 'fato_a')),
  $$values ('proposto', 'agente')$$,
  'fato de agente nasce proposto, com a origem registrada'
);
select throws_ok(
  format($$update atendimento.orientacoes set status = 'ativa' where id = %L$$,
         (select id from ids where nome = 'tom_a')),
  '23514', null,
  'orientação não fica ativa sem revisor'
);
select is(atendimento.total_pendente(testes.id('a')), 3, 'fila do Tenant A conta fatos e orientações');
select results_eq(
  format($$select tipo, categoria from atendimento.propostas_pendentes(%L) order by criado_em, tipo$$,
         testes.id('b')),
  $$values ('orientacao', 'tom')$$,
  'fila de um tenant não mostra propostas de outro'
);

-- Limite da fila ------------------------------------------------------------

insert into atendimento.orientacoes (tenant_id, categoria, texto, origem)
select testes.id('b'), 'tom', 'enchimento ' || g, 'agente' from generate_series(1, 199) g;
select throws_ok(
  format($$select atendimento.propor_orientacao(%L, 'tom', 'mais uma', null, 'agente')$$,
         testes.id('b')),
  '54000', null,
  'fila cheia recusa nova orientação'
);
select throws_ok(
  format($$select cerebro.propor_fato_de_agente(%L, '{"titulo": "x", "texto": "y"}'::jsonb)$$,
         testes.id('b')),
  '54000', null,
  'fila cheia recusa novo fato de agente'
);
select lives_ok(
  format($$select atendimento.propor_orientacao(%L, 'tom', 'Outra do A.', null, 'agente')$$,
         testes.id('a')),
  'fila cheia de um tenant não bloqueia outro'
);

-- Revisão pelo servidor -------------------------------------------------------

select throws_ok(
  format($$select atendimento.revisar_orientacao(%L, %L, %L, 'ativar')$$,
         testes.id('a'), (select id from ids where nome = 'tom_a'), testes.id('a', 'member')),
  '42501', null,
  'member não aprova orientação'
);
select throws_ok(
  format($$select atendimento.revisar_orientacao(%L, %L, %L, 'ativar')$$,
         testes.id('b'), (select id from ids where nome = 'tom_a'), testes.id('b', 'owner')),
  'P0002', null,
  'owner B não aprova orientação do Tenant A'
);

-- Revisão pela pessoa autenticada ---------------------------------------------

select testes.como('a', 'member');
select throws_ok(
  format($$select atendimento.minha_revisao_de_orientacao(%L, 'ativar')$$,
         (select id from ids where nome = 'tom_a')),
  '42501', null,
  'member autenticado não aprova orientação'
);
select throws_ok(
  format($$select cerebro.minha_revisao_de_fato(%L, 'ativar')$$,
         (select id from ids where nome = 'fato_a')),
  '42501', null,
  'member autenticado não aprova fato'
);
reset role;

select testes.como('b', 'owner');
select throws_ok(
  format($$select atendimento.minha_revisao_de_orientacao(%L, 'ativar')$$,
         (select id from ids where nome = 'tom_a')),
  '42501', null,
  'owner B autenticado não aprova orientação do Tenant A'
);
select throws_ok(
  format($$select cerebro.minha_revisao_de_fato(%L, 'ativar')$$,
         (select id from ids where nome = 'fato_a')),
  '42501', null,
  'owner B autenticado não aprova fato do Tenant A'
);
select is_empty(
  format($$select 1 from atendimento.orientacoes where tenant_id = %L$$, testes.id('a')),
  'owner B não enxerga orientações do Tenant A'
);
reset role;

select testes.como('a', 'owner');
select lives_ok(
  format($$select atendimento.minha_revisao_de_orientacao(%L, 'ativar')$$,
         (select id from ids where nome = 'tom_a')),
  'owner A aprova orientação do próprio tenant'
);
select lives_ok(
  format($$select atendimento.minha_revisao_de_orientacao(%L, 'rejeitar')$$,
         (select id from ids where nome = 'limite_a')),
  'owner A rejeita orientação'
);
select lives_ok(
  format($$select cerebro.minha_revisao_de_fato(%L, 'ativar', 'publico')$$,
         (select id from ids where nome = 'fato_a')),
  'owner A aprova fato proposto por agente'
);
reset role;

select results_eq(
  format($$select status::text, revisado_por from atendimento.orientacoes where id = %L$$,
         (select id from ids where nome = 'tom_a')),
  format($$values ('ativa', %L::uuid)$$, testes.id('a', 'owner')),
  'quem aprovou fica registrado'
);
select is(
  (select status::text from atendimento.orientacoes
   where id = (select id from ids where nome = 'limite_a')),
  'rejeitada', 'orientação rejeitada não fica ativa'
);
select isnt_empty(
  format($$select 1 from cerebro.buscar_publico(%L, 'aceita pix?')$$, testes.id('a')),
  'fato aprovado passa a aparecer para o atendimento'
);

select testes.como_anon();
select throws_ok('select 1 from atendimento.orientacoes', '42501', null, 'anon não lê orientações');
reset role;

-- Implantação: o que já foi respondido ----------------------------------------

select is_empty(
  format($$select 1 from atendimento.implantacao_respondidas(%L)$$, testes.id('a')),
  'proposta sem marca de pacote não conta como pergunta respondida'
);

select atendimento.propor_orientacao(
  testes.id('a'), 'tom', 'Tom cordial.', null, 'agente', 'pacote:otica@3001#marketing.tom');
select cerebro.propor_fato_de_agente(
  testes.id('a'),
  '{"titulo": "Prazo", "texto": "5 dias úteis.", "fonte": "pacote:otica@3001#otica.prazo"}'::jsonb);
insert into ids
select 'rejeitada', atendimento.propor_orientacao(
  testes.id('a'), 'limite', 'Limite ruim.', null, 'agente', 'pacote:otica@3001#geral.limites');
select atendimento.revisar_orientacao(
  testes.id('a'), (select id from ids where nome = 'rejeitada'), testes.id('a', 'owner'), 'rejeitar');

select results_eq(
  format($$select * from atendimento.implantacao_respondidas(%L) order by 1$$, testes.id('a')),
  array['pacote:otica@3001#marketing.tom', 'pacote:otica@3001#otica.prazo'],
  'pergunta com fato ou orientação pendente conta como respondida; rejeitada volta a ficar aberta'
);
select atendimento.ignorar_pergunta(testes.id('a'), 'otica.contato');
select atendimento.ignorar_pergunta(testes.id('a'), 'otica.contato');
select ok(
  'pacote:ignorada#otica.contato' in (
    select * from atendimento.implantacao_respondidas(testes.id('a'))),
  'pergunta marcada como não se aplica sai da lista (e marcar duas vezes não dá erro)'
);
select throws_ok(
  format($$select atendimento.ignorar_pergunta(%L, 'Texto Livre!')$$, testes.id('a')),
  '23514', null,
  'id de pergunta fora do formato é recusado'
);
select is_empty(
  format($$select 1 from atendimento.implantacao_respondidas(%L)$$, testes.id('b')),
  'respostas de um tenant não aparecem para outro'
);
select throws_ok(
  format($$update nucleo.tenants set segmento = 'Ótica Ltda' where id = %L$$, testes.id('a')),
  '23514', null,
  'segmento fora do formato é recusado'
);
select lives_ok(
  format($$update nucleo.tenants set segmento = 'otica' where id = %L$$, testes.id('a')),
  'segmento do tenant é gravado'
);

select * from finish();

rollback;

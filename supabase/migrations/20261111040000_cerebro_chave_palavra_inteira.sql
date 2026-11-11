-- Busca: chave só conta quando aparece como palavra inteira na pergunta.
-- Antes valia qualquer trecho: a chave "fecha" (horário) era acionada por
-- "fechadura", empurrando o fato errado para o topo.
-- As chaves só têm [a-z0-9 ] (restrição da tabela), então são seguras em regex.

create or replace function cerebro._buscar(
  p_tenant_id uuid,
  p_termo text,
  p_visibilidades cerebro.visibilidade[],
  p_dominio cerebro.dominio,
  p_limite integer
)
returns table (
  id uuid,
  dominio cerebro.dominio,
  tipo cerebro.tipo_fato,
  titulo text,
  texto text,
  visibilidade cerebro.visibilidade,
  pontuacao real
)
language sql
stable
set search_path = ''
as $$
  with t as (
    select
      cerebro.normalizar(p_termo) as termo,
      nullif(
        replace(
          plainto_tsquery('pg_catalog.portuguese', cerebro.normalizar(p_termo))::text, '&', '|'
        ),
        ''
      )::tsquery as consulta
  ),
  candidatos as (
    select
      f.id, f.dominio, f.tipo, f.titulo, f.texto, f.visibilidade, f.atualizado_em,
      case when t.consulta is null then 0 else ts_rank(f.busca, t.consulta) end as rank_texto,
      extensions.word_similarity(t.termo, cerebro.normalizar(f.titulo || ' ' || f.texto))
        as semelhanca,
      exists (
        select 1 from cerebro.chaves c
        where c.fato_id = f.id and t.termo ~ ('\m' || c.chave || '\M')
      ) as tem_chave
    from cerebro.fatos f
    cross join t
    where f.tenant_id = p_tenant_id
      and f.status = 'ativo'
      and f.visibilidade = any (p_visibilidades)
      and (p_dominio is null or f.dominio = p_dominio)
      and length(t.termo) >= 2
  )
  select
    c.id, c.dominio, c.tipo, c.titulo, c.texto, c.visibilidade,
    (c.rank_texto + 0.3 * c.semelhanca + case when c.tem_chave then 0.5 else 0 end)::real
  from candidatos c
  where c.rank_texto > 0 or c.semelhanca >= 0.5 or c.tem_chave
  order by 7 desc, c.atualizado_em desc
  limit least(greatest(coalesce(p_limite, 6), 1), 20);
$$;

revoke all on function
  cerebro._buscar(uuid, text, cerebro.visibilidade[], cerebro.dominio, integer) from public;
grant execute on function
  cerebro._buscar(uuid, text, cerebro.visibilidade[], cerebro.dominio, integer) to service_role;

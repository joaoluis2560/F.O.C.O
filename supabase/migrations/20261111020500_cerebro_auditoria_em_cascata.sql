-- Correção: excluir um tenant com fatos falhava. A exclusão em cascata dos
-- fatos disparava o gatilho de auditoria, que tentava gravar em `revisoes`
-- uma linha apontando para o tenant já excluído (violação de chave).
-- Quando o tenant não existe mais, a trilha dele também está sendo apagada
-- pela mesma cascata, então não há o que registrar.

create or replace function cerebro.tg_fatos_revisao()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid := coalesce(new.tenant_id, old.tenant_id);
  v_de jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) - 'busca' end;
  v_para jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) - 'busca' end;
begin
  if tg_op = 'DELETE'
     and not exists (select 1 from nucleo.tenants t where t.id = v_tenant_id) then
    return old;
  end if;

  insert into cerebro.revisoes (tenant_id, fato_id, acao, de, para, quem)
  values (
    v_tenant_id,
    coalesce(new.id, old.id),
    case tg_op when 'INSERT' then 'criar' when 'UPDATE' then 'alterar' else 'excluir' end,
    v_de,
    v_para,
    coalesce((select auth.uid()), new.revisado_por)
  );
  return coalesce(new, old);
end;
$$;

revoke all on function cerebro.tg_fatos_revisao() from public;

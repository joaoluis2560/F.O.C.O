-- Canal único da plataforma para a implantação.
--
-- Até aqui cada empresa tinha o próprio canal de implantação. Com um número só
-- para todos os donos, o canal não diz de qual empresa é a conversa: quem diz é
-- o telefone de quem escreve, conferido contra o cadastro.
--
-- O canal compartilhado pertence ao tenant da plataforma. Conversa, mensagens,
-- custo e teto diário ficam nesse tenant (a implantação é custo nosso). Só as
-- propostas vão para a empresa do dono, e a empresa é resolvida no servidor.

alter table atendimento.canais
  add column compartilhado boolean not null default false,
  add constraint compartilhado_so_na_implantacao
    check (not compartilhado or finalidade = 'implantacao');

comment on column atendimento.canais.compartilhado is
  'Verdadeiro no canal da plataforma: a empresa vem do telefone de quem escreve, não do canal.';

create index implantadores_telefone_idx on atendimento.implantadores (telefone);

-- Empresas que este telefone pode implantar. Devolve no máximo duas linhas:
-- basta para distinguir "nenhuma", "uma" e "mais de uma". Contato nulo não
-- encontra nada.
create function atendimento.empresas_do_implantador(p_contato text)
returns table (tenant_id uuid)
language sql
stable
set search_path = ''
as $$
  select i.tenant_id
  from atendimento.implantadores i
  where i.telefone = p_contato
  order by i.criado_em, i.tenant_id
  limit 2;
$$;

revoke all on function atendimento.empresas_do_implantador(text) from public, anon, authenticated;
grant execute on function atendimento.empresas_do_implantador(text) to service_role;

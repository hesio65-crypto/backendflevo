create table if not exists vendas (
  txid text primary key,
  subuser_id integer not null,
  gigas integer not null,
  valor integer not null,
  telefone text,
  status text not null default 'PENDENTE',
  created_at timestamptz not null default now()
);

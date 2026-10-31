-- فحص ميزات فاتورة المبيعات الجديدة (قراءة فقط)
select
  to_regprocedure('shaibani_erp.add_product_unit_to_product(uuid,text,numeric,numeric,numeric,text)') is not null as add_product_unit_exists,
  case when to_regprocedure('shaibani_erp.add_product_unit_to_product(uuid,text,numeric,numeric,numeric,text)') is not null then
    has_function_privilege('authenticated', to_regprocedure('shaibani_erp.add_product_unit_to_product(uuid,text,numeric,numeric,numeric,text)'), 'EXECUTE')
  else false end as authenticated_can_execute_add_unit,
  to_regclass('shaibani_erp.document_line_private_costs') is not null as private_cost_table_exists;

select
  c.relrowsecurity as rls_enabled,
  has_table_privilege('authenticated','shaibani_erp.document_line_private_costs','SELECT') as authenticated_has_select,
  has_table_privilege('authenticated','shaibani_erp.document_line_private_costs','INSERT') as authenticated_has_insert,
  has_table_privilege('authenticated','shaibani_erp.document_line_private_costs','UPDATE') as authenticated_has_update
from pg_class c
join pg_namespace n on n.oid=c.relnamespace
where n.nspname='shaibani_erp' and c.relname='document_line_private_costs';

select policyname, cmd, roles, qual
from pg_policies
where schemaname='shaibani_erp' and tablename='document_line_private_costs';

-- فحص جاهزية نظام الشيباني: قراءة فقط
select
  to_regprocedure('shaibani_erp.post_document(jsonb)') is not null as post_document_exists,
  case when to_regprocedure('shaibani_erp.post_document(jsonb)') is not null
       then has_function_privilege('authenticated',
              to_regprocedure('shaibani_erp.post_document(jsonb)'), 'EXECUTE')
       else false end as authenticated_can_execute;

select v.view_name,
       to_regclass('shaibani_erp.' || v.view_name) is not null as object_exists,
       case when to_regclass('shaibani_erp.' || v.view_name) is not null
         then has_table_privilege('authenticated',
                to_regclass('shaibani_erp.' || v.view_name), 'SELECT')
         else false end as authenticated_can_read
from (values ('v_cash_balances'), ('v_inventory_summary'),
             ('v_profit_loss'), ('v_trial_balance')) as v(view_name)
order by v.view_name;

select schemaname, tablename
from pg_publication_tables
where pubname='supabase_realtime'
  and schemaname='shaibani_erp'
  and tablename in ('documents','exchange_rates','parties',
                    'product_catalog_events','stock_movements')
order by tablename;

select role, count(*) as users_count,
       count(*) filter (where is_active) as active_users
from shaibani_erp.profiles
group by role
order by role;

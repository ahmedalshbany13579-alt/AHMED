-- فحص قراءة فقط بعد تنفيذ 06_security_and_validation_hardening.sql.
-- النتيجة المطلوبة لكل دالة: function_exists = true، anon_can_execute = false، authenticated_can_execute = true.
with expected(signature) as (
  values
    ('shaibani_erp.save_product(jsonb)'),
    ('shaibani_erp.add_product_unit_to_product(uuid,text,numeric,numeric,numeric,text)'),
    ('shaibani_erp.post_document(jsonb)'),
    ('shaibani_erp.post_stock_adjustment(jsonb)'),
    ('shaibani_erp.post_cash_transfer(jsonb)'),
    ('shaibani_erp.post_manual_journal_entry(jsonb)')
)
select
  signature,
  to_regprocedure(signature) is not null as function_exists,
  case when to_regprocedure(signature) is not null
    then has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE')
    else null
  end as anon_can_execute,
  case when to_regprocedure(signature) is not null
    then has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE')
    else null
  end as authenticated_can_execute
from expected
order by signature;

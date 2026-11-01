-- فحص قراءة فقط بعد تنفيذ 08_safe_record_deletion_and_invoice_voiding.sql.
with expected(signature, expected_definer) as (
  values
    ('shaibani_erp.manage_catalog_record_delete(text,uuid)', false),
    ('shaibani_erp.void_posted_document(uuid,text)', false),
    ('shaibani_internal.manage_catalog_record_delete(text,uuid)', true),
    ('shaibani_internal.void_posted_document(uuid,text)', true)
)
select
  signature,
  to_regprocedure(signature) is not null as function_exists,
  case when to_regprocedure(signature) is not null
    then (select prosecdef from pg_proc where oid=to_regprocedure(signature))
    else null end as security_definer,
  expected_definer,
  case when to_regprocedure(signature) is not null
    then has_function_privilege('anon', to_regprocedure(signature), 'EXECUTE')
    else null end as anon_can_execute,
  case when to_regprocedure(signature) is not null
    then has_function_privilege('authenticated', to_regprocedure(signature), 'EXECUTE')
    else null end as authenticated_can_execute
from expected
order by signature;

select
  to_regclass('shaibani_erp.record_management_audit') is not null as audit_table_exists,
  coalesce((select relrowsecurity from pg_class where oid=to_regclass('shaibani_erp.record_management_audit')), false) as audit_rls_enabled,
  has_table_privilege('authenticated','shaibani_erp.products','DELETE') as authenticated_can_direct_delete_products,
  has_table_privilege('authenticated','shaibani_erp.parties','DELETE') as authenticated_can_direct_delete_parties,
  has_table_privilege('authenticated','shaibani_erp.documents','DELETE') as authenticated_can_direct_delete_documents,
  has_schema_privilege('authenticated','shaibani_internal','USAGE') as authenticated_can_use_internal_schema;

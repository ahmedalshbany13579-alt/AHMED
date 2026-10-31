-- READ-ONLY compatibility check for the existing Shaibani ERP schema.
-- This query does not change data, grants, RLS, functions, or publications.
WITH required_objects(object_type, object_name) AS (
  VALUES
    ('table','profiles'),('table','currencies'),('table','settings'),
    ('table','exchange_rates'),('table','accounts'),('table','cash_accounts'),
    ('table','parties'),('table','products'),('table','product_units'),
    ('table','product_catalog_events'),('table','warehouses'),
    ('table','documents'),('table','document_lines'),('table','stock_movements'),
    ('table','journal_entries'),('table','journal_lines'),
    ('view','v_products'),('view','v_product_units'),('view','v_trial_balance'),
    ('view','v_profit_loss'),('view','v_inventory_summary'),('view','v_cash_balances'),
    ('function','current_app_role()'),('function','is_active_user()'),
    ('function','save_product(jsonb)'),('function','post_document(jsonb)'),
    ('function','set_opening_cash_balance(uuid,numeric)'),
    ('function','set_opening_party_balance(uuid,numeric,text)'),
    ('function','set_opening_stock(uuid,numeric,numeric)')
), object_status AS (
  SELECT object_type, object_name,
    CASE
      WHEN object_type IN ('table','view')
        THEN to_regclass(format('%I.%I','shaibani_erp',object_name)) IS NOT NULL
      WHEN object_type='function'
        THEN to_regprocedure('shaibani_erp.' || object_name) IS NOT NULL
      ELSE false
    END AS exists_now
  FROM required_objects
), schema_status AS (
  SELECT 'schema'::text AS object_type,
         'USAGE authenticated'::text AS object_name,
         has_schema_privilege('authenticated','shaibani_erp','USAGE') AS exists_now
  UNION ALL
  SELECT 'schema','USAGE service_role',
         has_schema_privilege('service_role','shaibani_erp','USAGE')
  UNION ALL
  SELECT 'service_role','profiles SELECT',
         has_table_privilege('service_role','shaibani_erp.profiles','SELECT')
  UNION ALL
  SELECT 'service_role','profiles INSERT',
         has_table_privilege('service_role','shaibani_erp.profiles','INSERT')
  UNION ALL
  SELECT 'service_role','profiles UPDATE',
         has_table_privilege('service_role','shaibani_erp.profiles','UPDATE')
), publication_status AS (
  SELECT 'realtime'::text AS object_type,
         t.table_name AS object_name,
         EXISTS (
           SELECT 1 FROM pg_publication_tables p
           WHERE p.pubname='supabase_realtime'
             AND p.schemaname='shaibani_erp'
             AND p.tablename=t.table_name
         ) AS exists_now
  FROM (VALUES ('documents'),('product_catalog_events'),('parties'),('stock_movements')) t(table_name)
)
SELECT object_type, object_name,
       CASE WHEN exists_now THEN 'OK' ELSE 'MISSING / CHECK' END AS status
FROM (
  SELECT * FROM object_status
  UNION ALL SELECT * FROM schema_status
  UNION ALL SELECT * FROM publication_status
) q
ORDER BY object_type, object_name;

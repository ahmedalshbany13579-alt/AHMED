-- READ-ONLY check: can authenticated read each view and its base tables?
-- A SECURITY INVOKER view requires the caller to have privileges on underlying relations.
SELECT
    c.relname AS view_name,
    c.reloptions AS view_options,
    has_table_privilege('authenticated', format('%I.%I','shaibani_erp',c.relname), 'SELECT')
        AS authenticated_can_read_view,
    CASE c.relname
        WHEN 'v_products' THEN has_table_privilege('authenticated','shaibani_erp.products','SELECT')
        WHEN 'v_product_units' THEN
            has_table_privilege('authenticated','shaibani_erp.product_units','SELECT')
            AND has_table_privilege('authenticated','shaibani_erp.products','SELECT')
        ELSE NULL
    END AS authenticated_can_read_required_base_tables
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'shaibani_erp'
  AND c.relkind = 'v'
  AND c.relname IN ('v_products','v_product_units')
ORDER BY c.relname;

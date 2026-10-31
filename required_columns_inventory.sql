-- READ-ONLY schema inventory for matching app operations with the existing database.
SELECT
    table_name,
    ordinal_position,
    column_name,
    data_type,
    is_nullable,
    column_default
FROM information_schema.columns
WHERE table_schema = 'shaibani_erp'
  AND table_name IN (
      'profiles','currencies','settings','exchange_rates','accounts',
      'cash_accounts','parties','products','product_units','warehouses',
      'documents','document_lines','stock_movements','journal_entries','journal_lines'
  )
ORDER BY table_name, ordinal_position;

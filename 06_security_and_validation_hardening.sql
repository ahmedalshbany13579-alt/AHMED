-- تقوية أمان وظائف ERP والتحقق من مدخلات وحدات الأصناف والتسوية والتحويل والقيد اليدوي.
-- يُنفّذ بعد 05_complete_accounting_erp_upgrade.sql وبعد أخذ نسخة احتياطية.
-- لا يحذف بيانات ولا يغيّر أرصدة قائمة؛ يعيد تعريف ثلاث وظائف ويضبط صلاحيات التنفيذ.

begin;

-- 1) تسوية الجرد: منع الاستدعاء دون مستخدم فعّال، وحصر الاتجاه في in/out.
create or replace function shaibani_erp.post_stock_adjustment(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_product uuid;
  v_direction text;
  v_qty numeric(20,6);
  v_cost numeric(20,6);
  v_notes text;
  v_warehouse uuid;
  v_inventory_account uuid;
  v_adj_account uuid;
  v_entry uuid;
  v_entry_no text;
  v_product_name text;
  v_old_qty numeric(20,6);
  v_value numeric(20,4);
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'بيانات تسوية الجرد غير صالحة';
  end if;
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  select role into v_role
  from shaibani_erp.profiles
  where id = v_uid and is_active = true;

  if v_role is null or v_role not in ('manager', 'accountant') then
    raise exception 'تسوية الجرد متاحة للمدير والمحاسب فقط';
  end if;

  v_product := nullif(p_payload->>'product_id', '')::uuid;
  v_direction := coalesce(nullif(trim(p_payload->>'direction'), ''), 'in');
  v_qty := coalesce(nullif(p_payload->>'quantity_base', '')::numeric, 0);
  v_notes := coalesce(nullif(trim(p_payload->>'notes'), ''), 'تسوية جرد مخزني');

  if v_product is null then
    raise exception 'حدد الصنف المطلوب تسويته';
  end if;
  if v_direction not in ('in', 'out') then
    raise exception 'اتجاه التسوية غير صحيح؛ اختر زيادة أو عجزاً';
  end if;
  if v_qty <= 0 then
    raise exception 'أدخل كمية تسوية أكبر من صفر';
  end if;

  select name, avg_cost_base
  into v_product_name, v_cost
  from shaibani_erp.products
  where id = v_product and active = true
  for update;
  if not found then
    raise exception 'الصنف غير موجود أو غير فعال';
  end if;

  v_cost := coalesce(nullif(p_payload->>'unit_cost_base', '')::numeric, nullif(v_cost, 0), 0);
  if v_cost <= 0 then
    raise exception 'حدد تكلفة الوحدة الأساسية لإثبات قيد التسوية';
  end if;

  select id into v_warehouse
  from shaibani_erp.warehouses
  where is_default = true and active = true
  order by id
  limit 1;
  if v_warehouse is null then
    raise exception 'لا يوجد مستودع افتراضي فعّال';
  end if;

  select coalesce(sum(quantity_in - quantity_out), 0)
  into v_old_qty
  from shaibani_erp.stock_movements
  where product_id = v_product and warehouse_id = v_warehouse;

  if v_direction = 'out' and v_old_qty < v_qty then
    raise exception 'لا يمكن خصم كمية أكبر من الرصيد المتاح (%)', v_old_qty;
  end if;

  select id into v_inventory_account
  from shaibani_erp.accounts
  where code = '1200' and active = true;
  select id into v_adj_account
  from shaibani_erp.accounts
  where code in ('5200', '5100') and active = true
  order by code desc
  limit 1;
  if v_inventory_account is null or v_adj_account is null then
    raise exception 'حساب المخزون 1200 أو حساب تسويات الجرد 5200/5100 غير موجود أو غير فعّال';
  end if;

  v_value := round(v_qty * v_cost, 4);
  v_entry_no := 'ADJ-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' ||
    upper(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 4));

  if v_direction = 'in' then
    insert into shaibani_erp.stock_movements(
      product_id, warehouse_id, movement_type, quantity_in, unit_cost_base, created_by
    ) values (v_product, v_warehouse, 'adjustment_in', v_qty, v_cost, v_uid);
  else
    insert into shaibani_erp.stock_movements(
      product_id, warehouse_id, movement_type, quantity_out, unit_cost_base, created_by
    ) values (v_product, v_warehouse, 'adjustment_out', v_qty, v_cost, v_uid);
  end if;

  insert into shaibani_erp.journal_entries(entry_no, entry_date, description, created_by)
  values (v_entry_no, current_date, v_notes || ' — ' || v_product_name, v_uid)
  returning id into v_entry;

  if v_direction = 'in' then
    insert into shaibani_erp.journal_lines(entry_id, account_id, debit_base, memo)
    values (v_entry, v_inventory_account, v_value, 'زيادة جرد مخزني: ' || v_product_name);
    insert into shaibani_erp.journal_lines(entry_id, account_id, credit_base, memo)
    values (v_entry, v_adj_account, v_value, 'مقابل فائض جرد مخزني');
  else
    insert into shaibani_erp.journal_lines(entry_id, account_id, debit_base, memo)
    values (v_entry, v_adj_account, v_value, 'عجز أو تالف جرد مخزني: ' || v_product_name);
    insert into shaibani_erp.journal_lines(entry_id, account_id, credit_base, memo)
    values (v_entry, v_inventory_account, v_value, 'تخفيض المخزون بالتسوية');
  end if;

  return v_entry;
end;
$$;

-- 2) التحويل بين الصناديق: فرض المصادقة والصلاحية وقفل الصندوقين أثناء إنشاء التحويل.
create or replace function shaibani_erp.post_cash_transfer(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_from_id uuid;
  v_to_id uuid;
  v_from_amount numeric(20,4);
  v_to_amount numeric(20,4);
  v_base_amount numeric(20,4);
  v_notes text;
  v_from_cash shaibani_erp.cash_accounts%rowtype;
  v_to_cash shaibani_erp.cash_accounts%rowtype;
  v_entry uuid;
  v_entry_no text;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'بيانات التحويل غير صالحة';
  end if;
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  select role into v_role
  from shaibani_erp.profiles
  where id = v_uid and is_active = true;
  if v_role is null or v_role not in ('manager', 'accountant') then
    raise exception 'التحويل بين الصناديق متاح للمدير والمحاسب فقط';
  end if;

  v_from_id := nullif(p_payload->>'from_cash_id', '')::uuid;
  v_to_id := nullif(p_payload->>'to_cash_id', '')::uuid;
  v_from_amount := coalesce(nullif(p_payload->>'from_amount', '')::numeric, 0);
  v_to_amount := coalesce(nullif(p_payload->>'to_amount', '')::numeric, 0);
  v_base_amount := coalesce(nullif(p_payload->>'base_amount', '')::numeric, 0);
  v_notes := coalesce(nullif(trim(p_payload->>'notes'), ''), 'تحويل بين الصناديق');

  if v_from_id is null or v_to_id is null or v_from_id = v_to_id then
    raise exception 'اختر صندوقين مختلفين للتحويل';
  end if;
  if v_from_amount <= 0 or v_to_amount <= 0 or v_base_amount <= 0 then
    raise exception 'أدخل مبالغ تحويل صحيحة أكبر من صفر';
  end if;

  -- قفل ثابت الترتيب للحد من التعارض عند تنفيذ تحويلين متزامنين.
  perform 1
  from shaibani_erp.cash_accounts
  where id in (v_from_id, v_to_id) and active = true
  order by id
  for update;

  select * into v_from_cash
  from shaibani_erp.cash_accounts
  where id = v_from_id and active = true;
  select * into v_to_cash
  from shaibani_erp.cash_accounts
  where id = v_to_id and active = true;

  if v_from_cash.id is null or v_to_cash.id is null then
    raise exception 'أحد الصناديق غير موجود أو غير نشط';
  end if;
  if v_from_cash.account_id is null or v_to_cash.account_id is null
     or not exists (select 1 from shaibani_erp.accounts where id = v_from_cash.account_id and active = true)
     or not exists (select 1 from shaibani_erp.accounts where id = v_to_cash.account_id and active = true) then
    raise exception 'الحساب المرتبط بأحد الصناديق غير موجود أو غير فعّال';
  end if;

  v_entry_no := 'TRF-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' ||
    upper(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 4));
  insert into shaibani_erp.journal_entries(entry_no, entry_date, description, created_by)
  values (
    v_entry_no,
    current_date,
    v_notes || ' (' || v_from_cash.name || ' ← ' || v_to_cash.name || ')',
    v_uid
  )
  returning id into v_entry;

  insert into shaibani_erp.journal_lines(
    entry_id, account_id, debit_base, currency, foreign_amount, memo
  ) values (
    v_entry, v_to_cash.account_id, round(v_base_amount, 4), v_to_cash.currency,
    v_to_amount, 'إيداع تحويل من ' || v_from_cash.name
  );

  insert into shaibani_erp.journal_lines(
    entry_id, account_id, credit_base, currency, foreign_amount, memo
  ) values (
    v_entry, v_from_cash.account_id, round(v_base_amount, 4), v_from_cash.currency,
    v_from_amount, 'سحب تحويل إلى ' || v_to_cash.name
  );

  return v_entry;
end;
$$;

-- 3) القيد اليدوي: منع المستخدم المجهول والمبالغ السالبة والتحقق من الحساب والطرف والعملة الأساسية.
create or replace function shaibani_erp.post_manual_journal_entry(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_date date;
  v_desc text;
  v_base_currency text;
  v_entry uuid;
  v_entry_no text;
  v_line jsonb;
  v_acc uuid;
  v_party uuid;
  v_debit numeric(20,4);
  v_credit numeric(20,4);
  v_total_debit numeric(20,4) := 0;
  v_total_credit numeric(20,4) := 0;
  v_count integer := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'بيانات القيد اليومي غير صالحة';
  end if;
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  select role into v_role
  from shaibani_erp.profiles
  where id = v_uid and is_active = true;
  if v_role is null or v_role not in ('manager', 'accountant') then
    raise exception 'إنشاء القيود اليدوية متاح للمدير والمحاسب فقط';
  end if;

  v_date := coalesce(nullif(p_payload->>'entry_date', '')::date, current_date);
  v_desc := nullif(trim(p_payload->>'description'), '');
  if v_desc is null then
    raise exception 'أدخل بيان القيد اليومي';
  end if;
  if coalesce(jsonb_typeof(p_payload->'lines'), '') <> 'array' then
    raise exception 'صيغة أسطر القيد غير صحيحة';
  end if;
  if jsonb_array_length(p_payload->'lines') < 2 then
    raise exception 'أضف سطري قيد على الأقل';
  end if;
  if jsonb_array_length(p_payload->'lines') > 500 then
    raise exception 'لا يمكن أن يتجاوز القيد 500 سطر';
  end if;

  select base_currency into v_base_currency
  from shaibani_erp.settings
  where id = 1;
  if v_base_currency is null then
    raise exception 'حدد العملة الأساسية في إعدادات النظام أولاً';
  end if;

  v_entry_no := 'MJE-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS') || '-' ||
    upper(substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 4));
  insert into shaibani_erp.journal_entries(entry_no, entry_date, description, created_by)
  values (v_entry_no, v_date, v_desc, v_uid)
  returning id into v_entry;

  for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
    v_acc := nullif(v_line->>'account_id', '')::uuid;
    v_party := nullif(v_line->>'party_id', '')::uuid;
    v_debit := round(coalesce(nullif(v_line->>'debit_base', '')::numeric, 0), 4);
    v_credit := round(coalesce(nullif(v_line->>'credit_base', '')::numeric, 0), 4);

    if v_acc is null
       or v_debit < 0
       or v_credit < 0
       or (v_debit = 0 and v_credit = 0)
       or (v_debit > 0 and v_credit > 0) then
      raise exception 'كل سطر يجب أن يحتوي على حساب ومبلغ موجب في جانب واحد فقط (مدين أو دائن)';
    end if;
    if not exists (select 1 from shaibani_erp.accounts where id = v_acc and active = true) then
      raise exception 'الحساب المحدد غير موجود أو غير فعّال';
    end if;
    if v_party is not null and not exists (
      select 1 from shaibani_erp.parties where id = v_party and active = true
    ) then
      raise exception 'العميل أو المورد المحدد غير موجود أو غير فعّال';
    end if;

    insert into shaibani_erp.journal_lines(
      entry_id, account_id, debit_base, credit_base, currency, foreign_amount, party_id, memo
    ) values (
      v_entry, v_acc, v_debit, v_credit, v_base_currency,
      greatest(v_debit, v_credit), v_party, coalesce(nullif(v_line->>'memo', ''), v_desc)
    );

    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
    v_count := v_count + 1;
  end loop;

  if v_count < 2 or abs(v_total_debit - v_total_credit) > 0.01 then
    raise exception 'القيد اليدوي غير متوازن (المدين: %، الدائن: %)', v_total_debit, v_total_credit;
  end if;

  return v_entry;
end;
$$;

-- 4) تصحيح تحقق الدور في إضافة وحدة الصنف؛ يجب رفض الملف النشط غير الموجود أيضاً.
create or replace function shaibani_erp.add_product_unit_to_product(
  p_product_id uuid,
  p_unit_name text,
  p_factor_to_base numeric,
  p_purchase_price numeric,
  p_sale_price numeric,
  p_currency text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $function$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_unit_name text := nullif(pg_catalog.btrim(p_unit_name), '');
  v_unit_id uuid;
  v_existing_factor numeric(20,8);
  v_is_base boolean;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  select p.role into v_role
  from shaibani_erp.profiles p
  where p.id = v_uid and p.is_active = true;

  if v_role is null or v_role not in ('manager', 'accountant') then
    raise exception 'إضافة وتعديل وحدات الأصناف متاحة للمدير والمحاسب الفعّالين فقط';
  end if;

  if p_product_id is null or v_unit_name is null then
    raise exception 'حدد الصنف واسم الوحدة';
  end if;
  if p_factor_to_base is null or p_factor_to_base <= 0 then
    raise exception 'عامل التحويل (المحتوى) يجب أن يكون أكبر من صفر';
  end if;
  if coalesce(p_purchase_price, 0) < 0 or coalesce(p_sale_price, 0) < 0 then
    raise exception 'أسعار الوحدة لا يمكن أن تكون سالبة';
  end if;
  if p_currency is null or p_currency not in ('YER', 'SAR', 'USD') then
    raise exception 'عملة الوحدة غير مدعومة';
  end if;

  perform 1
  from shaibani_erp.products pr
  where pr.id = p_product_id and pr.active = true
  for update;
  if not found then
    raise exception 'الصنف غير موجود أو غير فعال';
  end if;

  select pu.id, pu.factor_to_base, pu.is_base
  into v_unit_id, v_existing_factor, v_is_base
  from shaibani_erp.product_units pu
  where pu.product_id = p_product_id
    and pg_catalog.lower(pu.unit_name) = pg_catalog.lower(v_unit_name)
  for update;

  if found then
    if v_is_base and abs(p_factor_to_base - 1) > 0.00000001 then
      raise exception 'عامل تحويل الوحدة الأساسية يجب أن يبقى 1';
    end if;
    if abs(v_existing_factor - p_factor_to_base) > 0.00000001
       and exists (select 1 from shaibani_erp.document_lines dl where dl.unit_id = v_unit_id) then
      raise exception 'هذه الوحدة مستخدمة في فواتير سابقة؛ أنشئ وحدة باسم جديد للحفاظ على دقة الفواتير السابقة';
    end if;

    update shaibani_erp.product_units
    set factor_to_base = case when v_is_base then 1 else p_factor_to_base end,
        purchase_price = coalesce(p_purchase_price, 0),
        sale_price = coalesce(p_sale_price, 0),
        currency = p_currency,
        active = true
    where id = v_unit_id;
  else
    insert into shaibani_erp.product_units(
      product_id, unit_name, factor_to_base, purchase_price, sale_price, currency, is_base, active
    ) values (
      p_product_id, v_unit_name, p_factor_to_base,
      coalesce(p_purchase_price, 0), coalesce(p_sale_price, 0), p_currency, false, true
    )
    returning id into v_unit_id;
  end if;

  insert into shaibani_erp.product_catalog_events(product_id, event_type, created_by)
  values (p_product_id, 'changed', v_uid);

  return v_unit_id;
end;
$function$;

-- 5) تقليل صلاحيات الوظائف الحساسة: لا تنفيذ للمجهول أو PUBLIC، والتنفيذ للمستخدم المصادق فقط.
revoke all on function shaibani_erp.save_product(jsonb) from public, anon;
revoke all on function shaibani_erp.add_product_unit_to_product(uuid, text, numeric, numeric, numeric, text) from public, anon;
revoke all on function shaibani_erp.post_document(jsonb) from public, anon;
revoke all on function shaibani_erp.post_stock_adjustment(jsonb) from public, anon;
revoke all on function shaibani_erp.post_cash_transfer(jsonb) from public, anon;
revoke all on function shaibani_erp.post_manual_journal_entry(jsonb) from public, anon;

grant usage on schema shaibani_erp to authenticated;
grant execute on function shaibani_erp.save_product(jsonb) to authenticated;
grant execute on function shaibani_erp.add_product_unit_to_product(uuid, text, numeric, numeric, numeric, text) to authenticated;
grant execute on function shaibani_erp.post_document(jsonb) to authenticated;
grant execute on function shaibani_erp.post_stock_adjustment(jsonb) to authenticated;
grant execute on function shaibani_erp.post_cash_transfer(jsonb) to authenticated;
grant execute on function shaibani_erp.post_manual_journal_entry(jsonb) to authenticated;

revoke all on table shaibani_erp.v_party_balances from public, anon;
grant select on table shaibani_erp.v_party_balances to authenticated;

notify pgrst, 'reload schema';
commit;

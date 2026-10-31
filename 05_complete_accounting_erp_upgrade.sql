-- الترقية الشاملة للنظام المحاسبي المتكامل (الإصدار 2.0) — مخطط shaibani_erp
-- تضيف هذه الترقية:
-- 1) دعم مرتجعات المبيعات (sale_return) ومرتجعات المشتريات (purchase_return) والخصم/الضريبة في المشتريات داخل post_document.
-- 2) الحفاظ على أسعار البيع والشراء المخصصة للوحدات الفرعية داخل save_product دون الكتابة فوقها قسرياً.
-- 3) دالة تسوية الجرد المخزني الذرية post_stock_adjustment(jsonb) مع القيد المحاسبي المزدوج.
-- 4) دالة التحويل بين الصناديق ومصارفة العملات post_cash_transfer(jsonb).
-- 5) دالة القيود اليومية اليدوية المتوازنة post_manual_journal_entry(jsonb).
-- 6) عرض أرصدة العملاء والموردين الحية v_party_balances؛ شاشة المركز المالي تعتمد على بيانات v_trial_balance.

begin;

-- 1. توسيع قيد نوع المستند في جدول documents ليشمل المرتجعات والتسويات
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where table_schema = 'shaibani_erp'
      and table_name = 'documents'
      and constraint_name = 'documents_doc_type_check'
  ) then
    alter table shaibani_erp.documents drop constraint documents_doc_type_check;
  end if;
  alter table shaibani_erp.documents
    add constraint documents_doc_type_check
    check (doc_type in ('sale','purchase','sale_return','purchase_return','expense','receipt','payment'));
exception when others then
  null;
end $$;

-- 2. التأكد من وجود حساب تسويات وفروقات الجرد (5200) وحساب مردودات المبيعات (4100)
insert into shaibani_erp.accounts(code, name, account_type, normal_side, is_system, active)
values
  ('4100', 'مردودات ومسموحات المبيعات', 'revenue', 'debit', true, true),
  ('5200', 'فروقات وتسويات الجرد المخزني', 'expense', 'debit', true, true)
on conflict (code) do nothing;

-- 3. تحديث save_product للحفاظ على أسعار الوحدات الإضافية المخصصة
create or replace function shaibani_erp.save_product(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_role text; v_id uuid; v_base_id uuid;
  v_name text; v_sku text; v_category text; v_base_unit text; v_currency text;
  v_buy numeric(20,4); v_sell numeric(20,4); v_avg numeric(20,6); v_reorder numeric(20,4); v_desc text;
  v_unit jsonb; v_unit_name text; v_factor numeric(20,8); v_u_buy numeric(20,4); v_u_sell numeric(20,4); v_keep text[];
begin
  select role into v_role from shaibani_erp.profiles where id = v_uid and is_active = true;
  if v_role is null or v_role not in ('manager','accountant') then
    raise exception 'لا تملك صلاحية إدارة الأصناف';
  end if;
  v_name := nullif(trim(p_payload->>'name'),'');
  v_sku := nullif(trim(p_payload->>'sku'),'');
  v_category := nullif(trim(p_payload->>'category'),'');
  v_base_unit := nullif(trim(p_payload->>'base_unit'),'');
  v_currency := coalesce(p_payload->>'currency','YER');
  v_buy := coalesce(nullif(p_payload->>'purchase_price','')::numeric,0);
  v_sell := coalesce(nullif(p_payload->>'sale_price','')::numeric,0);
  v_avg := coalesce(nullif(p_payload->>'avg_cost_base','')::numeric,0);
  v_reorder := coalesce(nullif(p_payload->>'reorder_level','')::numeric,0);
  v_desc := nullif(p_payload->>'description','');
  if v_name is null or v_base_unit is null then
    raise exception 'اسم الصنف والوحدة الأساسية مطلوبان';
  end if;
  if v_currency not in ('YER','SAR','USD') or v_buy < 0 or v_sell < 0 or v_avg < 0 or v_reorder < 0 then
    raise exception 'تحقق من العملة والأسعار والتكلفة وحد إعادة الطلب';
  end if;
  if jsonb_typeof(coalesce(p_payload->'units','[]'::jsonb)) <> 'array' then
    raise exception 'صيغة الوحدات الإضافية غير صحيحة';
  end if;

  if nullif(p_payload->>'id','') is null then
    insert into shaibani_erp.products(sku,name,category,base_unit,avg_cost_base,reorder_level,description)
    values(v_sku,v_name,v_category,v_base_unit,v_avg,v_reorder,v_desc)
    returning id into v_id;
  else
    v_id := (p_payload->>'id')::uuid;
    -- إذا كانت للصنف حركة مخزون سابقة، نحافظ على الوحدة الأساسية ومتوسط التكلفة الحالي لتجنب خطأ الحارس
    if exists(select 1 from shaibani_erp.stock_movements where product_id = v_id) then
      update shaibani_erp.products
      set sku = v_sku, name = v_name, category = v_category,
          reorder_level = v_reorder, description = v_desc
      where id = v_id and active;
      select base_unit into v_base_unit from shaibani_erp.products where id = v_id;
    else
      update shaibani_erp.products
      set sku = v_sku, name = v_name, category = v_category, base_unit = v_base_unit,
          avg_cost_base = v_avg, reorder_level = v_reorder, description = v_desc
      where id = v_id and active;
    end if;
    if not found then raise exception 'الصنف غير موجود أو غير فعال'; end if;
  end if;

  select id into v_base_id from shaibani_erp.product_units where product_id = v_id and is_base = true for update;
  if v_base_id is null then
    insert into shaibani_erp.product_units(product_id,unit_name,factor_to_base,purchase_price,sale_price,currency,is_base,active)
    values(v_id,v_base_unit,1,v_buy,v_sell,v_currency,true,true);
  else
    update shaibani_erp.product_units
    set unit_name = v_base_unit, factor_to_base = 1, purchase_price = v_buy, sale_price = v_sell, currency = v_currency, active = true
    where id = v_base_id;
  end if;

  v_keep := array[v_base_unit];
  for v_unit in select value from jsonb_array_elements(coalesce(p_payload->'units','[]'::jsonb)) loop
    v_unit_name := nullif(trim(v_unit->>'unit_name'),'');
    v_factor := nullif(v_unit->>'factor_to_base','')::numeric;
    if v_unit_name is null or v_unit_name = v_base_unit or v_factor is null or v_factor <= 0 then
      raise exception 'تحقق من اسم الوحدة الإضافية وعامل التحويل';
    end if;
    if v_unit_name = any(v_keep) then
      raise exception 'اسم الوحدة مكرر: %', v_unit_name;
    end if;
    v_keep := array_append(v_keep, v_unit_name);
    v_u_buy := coalesce(nullif(v_unit->>'purchase_price','')::numeric, round(v_buy * v_factor, 4));
    v_u_sell := coalesce(nullif(v_unit->>'sale_price','')::numeric, round(v_sell * v_factor, 4));

    insert into shaibani_erp.product_units(product_id,unit_name,factor_to_base,purchase_price,sale_price,currency,is_base,active)
    values(v_id,v_unit_name,v_factor,v_u_buy,v_u_sell,v_currency,false,true)
    on conflict(product_id,unit_name) do update
      set factor_to_base = excluded.factor_to_base,
          purchase_price = case when v_unit ? 'purchase_price' and nullif(v_unit->>'purchase_price','') is not null then excluded.purchase_price else shaibani_erp.product_units.purchase_price end,
          sale_price = case when v_unit ? 'sale_price' and nullif(v_unit->>'sale_price','') is not null then excluded.sale_price else shaibani_erp.product_units.sale_price end,
          currency = excluded.currency,
          is_base = false,
          active = true;
  end loop;

  update shaibani_erp.product_units
  set active = false
  where product_id = v_id and is_base = false and not (unit_name = any(v_keep));

  insert into shaibani_erp.product_catalog_events(product_id,event_type,created_by)
  values(v_id, case when nullif(p_payload->>'id','') is null then 'created' else 'changed' end, v_uid);

  return v_id;
end $$;


-- 3-ب. ترقية add_product_unit_to_product للسماح بتعديل عامل التحويل يدوياً للوحدات غير المقيدة بفواتير سابقة
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
  if v_uid is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
  select p.role into v_role from shaibani_erp.profiles p where p.id = v_uid and p.is_active = true;
  if v_role not in ('manager', 'accountant') then raise exception 'إضافة وتعديل وحدات الأصناف متاحة للمدير والمحاسب فقط'; end if;
  if p_product_id is null or v_unit_name is null then raise exception 'حدد الصنف واسم الوحدة'; end if;
  if p_factor_to_base is null or p_factor_to_base <= 0 then raise exception 'عامل التحويل (المحتوى) يجب أن يكون أكبر من صفر'; end if;
  if coalesce(p_purchase_price, 0) < 0 or coalesce(p_sale_price, 0) < 0 then raise exception 'أسعار الوحدة لا يمكن أن تكون سالبة'; end if;
  if p_currency is null or p_currency not in ('YER', 'SAR', 'USD') then raise exception 'عملة الوحدة غير مدعومة'; end if;

  perform 1 from shaibani_erp.products pr where pr.id = p_product_id and pr.active = true for update;
  if not found then raise exception 'الصنف غير موجود أو غير فعال'; end if;

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
       and exists(select 1 from shaibani_erp.document_lines dl where dl.unit_id = v_unit_id) then
      raise exception 'هذه الوحدة مستخدمة في فواتير سابقة؛ أنشئ وحدة باسم جديد (مثلاً: % جديد) للحفاظ على دقة الفواتير السابقة', v_unit_name;
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
      product_id, unit_name, factor_to_base,
      purchase_price, sale_price, currency, is_base, active
    ) values (
      p_product_id, v_unit_name, p_factor_to_base,
      coalesce(p_purchase_price, 0), coalesce(p_sale_price, 0),
      p_currency, false, true
    )
    returning id into v_unit_id;
  end if;

  insert into shaibani_erp.product_catalog_events(product_id, event_type, created_by)
  values (p_product_id, 'changed', v_uid);

  return v_unit_id;
end;
$function$;
grant execute on function shaibani_erp.add_product_unit_to_product(uuid, text, numeric, numeric, numeric, text) to authenticated;

-- 4. تحديث دالة الترحيل الذري post_document لدعم المبيعات والمشتريات والمرتجعات والسندات والمصروفات
create or replace function shaibani_erp.post_document(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_role text; v_type text; v_currency text; v_fx numeric(20,8);
  v_date date; v_party uuid; v_method text; v_cash_id uuid; v_cash_account uuid; v_base_currency text; v_db_fx numeric(20,8);
  v_expense_account uuid; v_warehouse uuid; v_subtotal numeric(20,4):=0;
  v_discount numeric(20,4):=0; v_tax numeric(20,4):=0; v_total numeric(20,4):=0;
  v_doc uuid; v_doc_no text; v_entry uuid; v_entry_no text; v_doc_line_id uuid; v_purchase_unit_price numeric(20,4);
  v_line jsonb; v_product uuid; v_unit uuid; v_unit_name text; v_product_name text; v_factor numeric(20,8);
  v_qty numeric(20,4); v_qty_base numeric(20,6); v_price numeric(20,4); v_line_total numeric(20,4);
  v_available numeric(20,6); v_old_qty numeric(20,6); v_avg_cost numeric(20,6); v_cost numeric(20,4):=0;
  v_base_total numeric(20,4); v_revenue numeric(20,4); v_tax_base numeric(20,4);
  v_debit_account uuid; v_credit_account uuid; v_revenue_account uuid; v_inventory_account uuid;
  v_cogs_account uuid; v_tax_account uuid; v_ap_account uuid; v_ar_account uuid;
  v_lines_count integer:=0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'بيانات المستند غير صالحة';
  end if;
  if v_uid is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
  select role into v_role from shaibani_erp.profiles where id=v_uid and is_active=true;
  if v_role is null then raise exception 'الحساب غير مفعّل؛ راجع مدير النظام'; end if;
  if v_role not in ('manager','accountant','cashier') then raise exception 'دور المستخدم غير معتمد لتنفيذ العمليات'; end if;

  v_type := p_payload->>'doc_type';
  if v_type is null or v_type not in ('sale','purchase','sale_return','purchase_return','expense','receipt','payment') then
    raise exception 'نوع المستند غير مدعوم';
  end if;
  if v_role='cashier' and v_type not in ('sale','sale_return') then
    raise exception 'صلاحية الكاشير تسمح بفواتير المبيعات ومرتجعاتها فقط';
  end if;

  v_currency := coalesce(nullif(p_payload->>'currency',''),'YER');
  if not exists(select 1 from shaibani_erp.currencies where code=v_currency and active) then
    raise exception 'العملة غير مفعّلة';
  end if;
  v_fx := coalesce(nullif(p_payload->>'exchange_rate','')::numeric,1);
  if v_fx<=0 then raise exception 'سعر الصرف يجب أن يكون أكبر من صفر'; end if;
  v_date := coalesce(nullif(p_payload->>'document_date','')::date,current_date);
  select base_currency into v_base_currency from shaibani_erp.settings where id=1;
  if v_base_currency is null then raise exception 'حدد العملة الأساسية في الإعدادات'; end if;
  if v_currency=v_base_currency and abs(v_fx-1)>0.00000001 then
    raise exception 'سعر صرف العملة الأساسية يجب أن يساوي 1';
  end if;
  if v_currency<>v_base_currency then
    select er.rate into v_db_fx from shaibani_erp.exchange_rates er
    where er.from_currency=v_currency and er.to_currency=v_base_currency and er.effective_date<=v_date
    order by er.effective_date desc limit 1;
    if v_db_fx is null then raise exception 'سجّل سعر صرف % مقابل % أولاً',v_currency,v_base_currency; end if;
    if abs(v_fx-v_db_fx)>0.00000001 then
      raise exception 'سعر الصرف لا يطابق السعر المعتمد بتاريخ المستند (%). أعد تحميل السعر من الإعدادات',v_db_fx;
    end if;
  end if;

  v_party := nullif(p_payload->>'party_id','')::uuid;
  v_method := coalesce(p_payload->>'settlement_method','cash');
  if v_method not in ('cash','credit') then raise exception 'طريقة السداد غير صحيحة'; end if;
  if (v_type in ('purchase','purchase_return','receipt','payment') or (v_type in ('sale','sale_return','expense') and v_method='credit')) and v_party is null then
    raise exception 'اختر العميل أو المورد';
  end if;

  v_cash_id := nullif(p_payload->>'cash_account_id','')::uuid;
  if v_method='cash' or v_type in ('receipt','payment') then
    if v_cash_id is null then raise exception 'اختر الصندوق'; end if;
    select ca.account_id into v_cash_account from shaibani_erp.cash_accounts ca
      where ca.id=v_cash_id and ca.currency=v_currency and ca.active;
    if v_cash_account is null then raise exception 'الصندوق غير موجود أو عملته لا تطابق عملة المستند'; end if;
  end if;

  v_expense_account := nullif(p_payload->>'expense_account_id','')::uuid;
  if v_type='expense' then
    if v_expense_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_expense_account and account_type='expense' and active) then
      select id into v_expense_account from shaibani_erp.accounts where code='5100';
    end if;
  end if;

  select id into v_ar_account from shaibani_erp.accounts where code='1100';
  select id into v_ap_account from shaibani_erp.accounts where code='2000';
  select id into v_inventory_account from shaibani_erp.accounts where code='1200';
  select id into v_revenue_account from shaibani_erp.accounts where code='4000';
  select id into v_cogs_account from shaibani_erp.accounts where code='5000';
  select id into v_tax_account from shaibani_erp.accounts where code='2100';
  select id into v_warehouse from shaibani_erp.warehouses where is_default=true and active limit 1;

  if v_type in ('sale','purchase','sale_return','purchase_return') then
    if jsonb_typeof(p_payload->'lines')<>'array' then raise exception 'أضف بنداً واحداً على الأقل'; end if;
    for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
      v_product := (v_line->>'product_id')::uuid; v_unit := (v_line->>'unit_id')::uuid;
      v_qty := (v_line->>'quantity')::numeric; v_price := (v_line->>'unit_price')::numeric;
      if v_qty is null or v_price is null or v_qty<=0 or v_price<=0 then
        raise exception 'تحقق من الكمية والسعر؛ يجب أن يكون السعر أكبر من صفر';
      end if;
      select pu.unit_name,pu.factor_to_base into v_unit_name,v_factor
      from shaibani_erp.product_units pu join shaibani_erp.products pr on pr.id=pu.product_id
      where pu.id=v_unit and pu.product_id=v_product and pu.active and pr.active;
      if v_factor is null then raise exception 'وحدة الصنف غير صالحة'; end if;
      v_line_total := round(v_qty*v_price,4); v_subtotal := v_subtotal+v_line_total; v_lines_count:=v_lines_count+1;
    end loop;
    if v_lines_count=0 then raise exception 'أضف بنداً واحداً على الأقل'; end if;
  else
    v_subtotal := coalesce(nullif(p_payload->>'amount','')::numeric,0);
    if v_subtotal<=0 then raise exception 'أدخل مبلغاً أكبر من صفر'; end if;
  end if;

  v_discount := coalesce(nullif(p_payload->>'discount','')::numeric,0);
  v_tax := coalesce(nullif(p_payload->>'tax','')::numeric,0);
  if v_discount<0 or v_tax<0 or v_discount>v_subtotal then raise exception 'تحقق من الخصم والضريبة'; end if;
  v_total := round(v_subtotal-v_discount+v_tax,4);
  if v_total<=0 then raise exception 'إجمالي المستند يجب أن يكون أكبر من صفر'; end if;
  if v_type in ('receipt','payment') then v_method:='cash'; end if;

  v_doc_no := case v_type
      when 'sale' then 'SAL'
      when 'purchase' then 'PUR'
      when 'sale_return' then 'SRT'
      when 'purchase_return' then 'PRT'
      when 'expense' then 'EXP'
      when 'receipt' then 'RCT'
      else 'PAY'
    end || '-' || to_char(clock_timestamp(),'YYYYMMDD-HH24MISS-MS') || '-' || upper(substr(replace(pg_catalog.gen_random_uuid()::text,'-',''),1,5));

  insert into shaibani_erp.documents(doc_no,doc_type,party_id,document_date,currency,exchange_rate,settlement_method,cash_account_id,expense_account_id,subtotal,discount,tax,total,notes,created_by)
  values(v_doc_no,v_type,v_party,v_date,v_currency,v_fx,v_method,v_cash_id,v_expense_account,v_subtotal,v_discount,v_tax,v_total,p_payload->>'notes',v_uid)
  returning id into v_doc;

  if v_type in ('sale','purchase','sale_return','purchase_return') then
    perform 1 from shaibani_erp.products p
    where p.id in (select distinct (x.value->>'product_id')::uuid from jsonb_array_elements(p_payload->'lines') as x(value))
    order by p.id for update;

    for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
      v_product := (v_line->>'product_id')::uuid; v_unit := (v_line->>'unit_id')::uuid;
      v_qty := (v_line->>'quantity')::numeric; v_price := (v_line->>'unit_price')::numeric;
      select pu.unit_name,pu.factor_to_base,pr.name into v_unit_name,v_factor,v_product_name
      from shaibani_erp.product_units pu join shaibani_erp.products pr on pr.id=pu.product_id
      where pu.id=v_unit and pu.product_id=v_product and pu.active and pr.active;
      v_qty_base := round(v_qty*v_factor,6); v_line_total := round(v_qty*v_price,4);

      insert into shaibani_erp.document_lines(document_id,product_id,product_name,unit_id,unit_name,quantity,factor_to_base,quantity_base,unit_price,line_total)
      values(v_doc,v_product,v_product_name,v_unit,v_unit_name,v_qty,v_factor,v_qty_base,v_price,v_line_total)
      returning id into v_doc_line_id;

      v_purchase_unit_price := nullif(v_line->>'purchase_unit_price','')::numeric;
      if v_purchase_unit_price is not null and v_type='sale' and v_role in ('manager','accountant') and v_purchase_unit_price>=0 then
        insert into shaibani_erp.document_line_private_costs(document_line_id, purchase_unit_price, currency, created_by)
        values (v_doc_line_id, v_purchase_unit_price, v_currency, v_uid);
      end if;

      select avg_cost_base into v_avg_cost from shaibani_erp.products where id=v_product and active;
      select coalesce(sum(sm.quantity_in-sm.quantity_out),0) into v_old_qty from shaibani_erp.stock_movements sm
      where sm.product_id=v_product and sm.warehouse_id=v_warehouse;

      if v_type='sale' then
        if coalesce(v_avg_cost,0)<=0 then raise exception 'تكلفة الصنف غير محددة؛ سجّل فاتورة شراء أو رصيداً افتتاحياً بتكلفة صحيحة أولاً'; end if;
        if v_old_qty < v_qty_base then raise exception 'المخزون غير كافٍ للصنف: % (المتاح %)',v_product_name,v_old_qty; end if;
        insert into shaibani_erp.stock_movements(product_id,warehouse_id,document_id,movement_type,quantity_out,unit_cost_base,created_by)
        values(v_product,v_warehouse,v_doc,'sale',v_qty_base,v_avg_cost,v_uid);
        v_cost := v_cost+(v_qty_base*v_avg_cost);
      elsif v_type='sale_return' then
        insert into shaibani_erp.stock_movements(product_id,warehouse_id,document_id,movement_type,quantity_in,unit_cost_base,created_by)
        values(v_product,v_warehouse,v_doc,'adjustment_in',v_qty_base,coalesce(nullif(v_avg_cost,0),round(v_price*v_fx/v_factor,6)),v_uid);
        v_cost := v_cost+(v_qty_base*coalesce(nullif(v_avg_cost,0),round(v_price*v_fx/v_factor,6)));
      elsif v_type='purchase' then
        insert into shaibani_erp.stock_movements(product_id,warehouse_id,document_id,movement_type,quantity_in,unit_cost_base,created_by)
        values(v_product,v_warehouse,v_doc,'purchase',v_qty_base,round(v_price*v_fx/v_factor,6),v_uid);
        perform set_config('shaibani.allow_cost_recalc','on',true);
        update shaibani_erp.products set avg_cost_base=case when (v_old_qty+v_qty_base)>0
          then round(((v_old_qty*coalesce(v_avg_cost,0))+(v_qty_base*(v_price*v_fx/v_factor)))/(v_old_qty+v_qty_base),6)
          else round(v_price*v_fx/v_factor,6) end
        where id=v_product;
        perform set_config('shaibani.allow_cost_recalc','off',true);
      elsif v_type='purchase_return' then
        if v_old_qty < v_qty_base then raise exception 'المخزون غير كافٍ لإرجاع الصنف للمورد: % (المتاح %)',v_product_name,v_old_qty; end if;
        insert into shaibani_erp.stock_movements(product_id,warehouse_id,document_id,movement_type,quantity_out,unit_cost_base,created_by)
        values(v_product,v_warehouse,v_doc,'adjustment_out',v_qty_base,round(v_price*v_fx/v_factor,6),v_uid);
      end if;
    end loop;
  end if;

  v_entry_no := 'JE-'||to_char(clock_timestamp(),'YYYYMMDD-HH24MISS-MS')||'-'||upper(substr(replace(pg_catalog.gen_random_uuid()::text,'-',''),1,4));
  insert into shaibani_erp.journal_entries(entry_no,entry_date,description,document_id,created_by)
  values(v_entry_no,v_date,
    case v_type
      when 'sale' then 'قيد فاتورة مبيعات '||v_doc_no
      when 'purchase' then 'قيد فاتورة مشتريات '||v_doc_no
      when 'sale_return' then 'قيد مرتجع مبيعات '||v_doc_no
      when 'purchase_return' then 'قيد مرتجع مشتريات '||v_doc_no
      when 'expense' then 'قيد مصروف '||v_doc_no
      when 'receipt' then 'سند قبض '||v_doc_no
      else 'سند صرف '||v_doc_no
    end, v_doc, v_uid)
  returning id into v_entry;

  v_base_total := round(v_total*v_fx,4);

  if v_type='sale' then
    v_debit_account := case when v_method='cash' then v_cash_account else v_ar_account end;
    v_revenue := round((v_subtotal-v_discount)*v_fx,4); v_tax_base:=round(v_tax*v_fx,4);
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_debit_account,v_base_total,v_currency,v_total,v_party,'إثبات قيمة البيع');
    if v_revenue>0 then
      insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,party_id,memo)
      values(v_entry,v_revenue_account,v_revenue,v_currency,v_subtotal-v_discount,v_party,'إيراد المبيعات');
    end if;
    if v_tax_base>0 then
      insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,memo)
      values(v_entry,v_tax_account,v_tax_base,v_currency,v_tax,'الضريبة المستحقة');
    end if;
    if v_cost>0 then
      insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,memo) values(v_entry,v_cogs_account,round(v_cost,4),v_currency,0,'تكلفة البضاعة المباعة');
      insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,memo) values(v_entry,v_inventory_account,round(v_cost,4),v_currency,0,'تخفيض المخزون');
    end if;
  elsif v_type='sale_return' then
    v_credit_account := case when v_method='cash' then v_cash_account else v_ar_account end;
    v_revenue := round((v_subtotal-v_discount)*v_fx,4); v_tax_base:=round(v_tax*v_fx,4);
    if v_revenue>0 then
      insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,party_id,memo)
      values(v_entry,v_revenue_account,v_revenue,v_currency,v_subtotal-v_discount,v_party,'مردودات المبيعات');
    end if;
    if v_tax_base>0 then
      insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,memo)
      values(v_entry,v_tax_account,v_tax_base,v_currency,v_tax,'عكس ضريبة المبيعات');
    end if;
    insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_credit_account,v_base_total,v_currency,v_total,v_party,'رد قيمة المرتجع للعميل');
    if v_cost>0 then
      insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,memo) values(v_entry,v_inventory_account,round(v_cost,4),v_currency,0,'إعادة المرتجع للمخزون');
      insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,memo) values(v_entry,v_cogs_account,round(v_cost,4),v_currency,0,'عكس تكلفة البضاعة المباعة');
    end if;
  elsif v_type='purchase' then
    v_credit_account := case when v_method='cash' then v_cash_account else v_ap_account end;
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_inventory_account,v_base_total,v_currency,v_total,v_party,'إضافة مشتريات للمخزون');
    insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_credit_account,v_base_total,v_currency,v_total,v_party,'مقابل المشتريات');
  elsif v_type='purchase_return' then
    v_debit_account := case when v_method='cash' then v_cash_account else v_ap_account end;
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_debit_account,v_base_total,v_currency,v_total,v_party,'تخفيض ذمة المورد / استرداد نقدي');
    insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_inventory_account,v_base_total,v_currency,v_total,v_party,'مرتجع مشتريات من المخزون');
  elsif v_type='expense' then
    v_credit_account := case when v_method='cash' then v_cash_account else v_ap_account end;
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_expense_account,v_base_total,v_currency,v_total,v_party,'إثبات المصروف');
    insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_credit_account,v_base_total,v_currency,v_total,v_party,'الصندوق أو الطرف الدائن');
  elsif v_type='receipt' then
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_cash_account,v_base_total,v_currency,v_total,v_party,'قبض من عميل');
    insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_ar_account,v_base_total,v_currency,v_total,v_party,'تخفيض ذمم العملاء');
  elsif v_type='payment' then
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_ap_account,v_base_total,v_currency,v_total,v_party,'تخفيض ذمم الموردين');
    insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_cash_account,v_base_total,v_currency,v_total,v_party,'صرف لمورد');
  end if;

  if abs((select coalesce(sum(debit_base-credit_base),0) from shaibani_erp.journal_lines where entry_id=v_entry))>0.01 then
    raise exception 'القيد المحاسبي غير متوازن؛ أُلغيت العملية بالكامل';
  end if;
  return v_doc;
end $$;

-- 5. دالة تسوية الجرد المخزني الذرية post_stock_adjustment
create or replace function shaibani_erp.post_stock_adjustment(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_role text; v_product uuid; v_direction text;
  v_qty numeric(20,6); v_cost numeric(20,6); v_notes text; v_warehouse uuid;
  v_inventory_account uuid; v_adj_account uuid; v_entry uuid; v_entry_no text;
  v_product_name text; v_old_qty numeric(20,6); v_value numeric(20,4);
begin
  select role into v_role from shaibani_erp.profiles where id=v_uid and is_active=true;
  if v_role not in ('manager','accountant') then raise exception 'تسوية الجرد متاحة للمدير والمحاسب فقط'; end if;
  v_product := (p_payload->>'product_id')::uuid;
  v_direction := coalesce(p_payload->>'direction','in');
  v_qty := coalesce(nullif(p_payload->>'quantity_base','')::numeric,0);
  v_notes := coalesce(nullif(trim(p_payload->>'notes'),''),'تسوية جرد مخزني');
  if v_qty <= 0 then raise exception 'أدخل كمية تسوية أكبر من صفر'; end if;

  select name, avg_cost_base into v_product_name, v_cost from shaibani_erp.products where id=v_product and active for update;
  if not found then raise exception 'الصنف غير موجود'; end if;
  v_cost := coalesce(nullif(p_payload->>'unit_cost_base','')::numeric, nullif(v_cost,0), 0);
  if v_cost <= 0 then raise exception 'حدد تكلفة الوحدة الأساسية لإثبات قيد التسوية'; end if;

  select id into v_warehouse from shaibani_erp.warehouses where is_default=true and active limit 1;
  select coalesce(sum(quantity_in - quantity_out),0) into v_old_qty from shaibani_erp.stock_movements where product_id=v_product and warehouse_id=v_warehouse;
  if v_direction = 'out' and v_old_qty < v_qty then
    raise exception 'لا يمكن خصم كمية أكبر من الرصيد المتاح (%)', v_old_qty;
  end if;

  select id into v_inventory_account from shaibani_erp.accounts where code='1200';
  select id into v_adj_account from shaibani_erp.accounts where code in ('5200','5100') order by code desc limit 1;
  v_value := round(v_qty * v_cost, 4);
  v_entry_no := 'ADJ-'||to_char(clock_timestamp(),'YYYYMMDD-HH24MISS')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,4));

  if v_direction = 'in' then
    insert into shaibani_erp.stock_movements(product_id,warehouse_id,movement_type,quantity_in,unit_cost_base,created_by)
    values(v_product,v_warehouse,'adjustment_in',v_qty,v_cost,v_uid);
  else
    insert into shaibani_erp.stock_movements(product_id,warehouse_id,movement_type,quantity_out,unit_cost_base,created_by)
    values(v_product,v_warehouse,'adjustment_out',v_qty,v_cost,v_uid);
  end if;

  insert into shaibani_erp.journal_entries(entry_no,entry_date,description,created_by)
  values(v_entry_no,current_date,v_notes || ' — ' || v_product_name,v_uid)
  returning id into v_entry;

  if v_direction = 'in' then
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,memo) values(v_entry,v_inventory_account,v_value,'زيادة جرد مخزني: '||v_product_name);
    insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,memo) values(v_entry,v_adj_account,v_value,'مقابل فائض جرد مخزني');
  else
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,memo) values(v_entry,v_adj_account,v_value,'عجز أو تالف جرد مخزني: '||v_product_name);
    insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,memo) values(v_entry,v_inventory_account,v_value,'تخفيض المخزون بالتسوية');
  end if;

  return v_entry;
end $$;

-- 6. دالة التحويل بين الصناديق ومصارفة العملات post_cash_transfer
create or replace function shaibani_erp.post_cash_transfer(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_role text;
  v_from_id uuid := (p_payload->>'from_cash_id')::uuid;
  v_to_id uuid := (p_payload->>'to_cash_id')::uuid;
  v_from_amount numeric(20,4) := coalesce(nullif(p_payload->>'from_amount','')::numeric,0);
  v_to_amount numeric(20,4) := coalesce(nullif(p_payload->>'to_amount','')::numeric,0);
  v_base_amount numeric(20,4) := coalesce(nullif(p_payload->>'base_amount','')::numeric,0);
  v_notes text := coalesce(nullif(trim(p_payload->>'notes'),''),'تحويل بين الصناديق');
  v_from_cash shaibani_erp.cash_accounts%rowtype;
  v_to_cash shaibani_erp.cash_accounts%rowtype;
  v_entry uuid; v_entry_no text;
begin
  select role into v_role from shaibani_erp.profiles where id=v_uid and is_active=true;
  if v_role not in ('manager','accountant') then raise exception 'التحويل بين الصناديق متاح للمدير والمحاسب فقط'; end if;
  if v_from_id is null or v_to_id is null or v_from_id = v_to_id then raise exception 'اختر صندوقين مختلفين للتحويل'; end if;
  if v_from_amount <= 0 or v_to_amount <= 0 or v_base_amount <= 0 then raise exception 'أدخل مبالغ تحويل صحيحة أكبر من صفر'; end if;

  select * into v_from_cash from shaibani_erp.cash_accounts where id=v_from_id and active;
  select * into v_to_cash from shaibani_erp.cash_accounts where id=v_to_id and active;
  if v_from_cash.id is null or v_to_cash.id is null then raise exception 'أحد الصناديق غير موجود أو غير نشط'; end if;

  v_entry_no := 'TRF-'||to_char(clock_timestamp(),'YYYYMMDD-HH24MISS')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,4));
  insert into shaibani_erp.journal_entries(entry_no,entry_date,description,created_by)
  values(v_entry_no,current_date,v_notes || ' (' || v_from_cash.name || ' ← ' || v_to_cash.name || ')',v_uid)
  returning id into v_entry;

  insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,memo)
  values(v_entry,v_to_cash.account_id,round(v_base_amount,4),v_to_cash.currency,v_to_amount,'إيداع تحويل من '||v_from_cash.name);

  insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,memo)
  values(v_entry,v_from_cash.account_id,round(v_base_amount,4),v_from_cash.currency,v_from_amount,'سحب تحويل إلى '||v_to_cash.name);

  return v_entry;
end $$;

-- 7. دالة القيد اليومي اليدوي المتوازن post_manual_journal_entry
create or replace function shaibani_erp.post_manual_journal_entry(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_role text;
  v_date date := coalesce(nullif(p_payload->>'entry_date','')::date, current_date);
  v_desc text := nullif(trim(p_payload->>'description'),'');
  v_entry uuid; v_entry_no text; v_line jsonb;
  v_acc uuid; v_party uuid; v_debit numeric(20,4); v_credit numeric(20,4);
  v_total_debit numeric(20,4):=0; v_total_credit numeric(20,4):=0; v_count int:=0;
begin
  select role into v_role from shaibani_erp.profiles where id=v_uid and is_active=true;
  if v_role not in ('manager','accountant') then raise exception 'إنشاء القيود اليدوية متاح للمدير والمحاسب فقط'; end if;
  if v_desc is null then raise exception 'أدخل بيان القيد اليومي'; end if;
  if jsonb_typeof(p_payload->'lines') <> 'array' then raise exception 'أضف سطري قيد على الأقل'; end if;

  v_entry_no := 'MJE-'||to_char(clock_timestamp(),'YYYYMMDD-HH24MISS')||'-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,4));
  insert into shaibani_erp.journal_entries(entry_no,entry_date,description,created_by)
  values(v_entry_no,v_date,v_desc,v_uid)
  returning id into v_entry;

  for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
    v_acc := (v_line->>'account_id')::uuid;
    v_party := nullif(v_line->>'party_id','')::uuid;
    v_debit := round(coalesce(nullif(v_line->>'debit_base','')::numeric,0),4);
    v_credit := round(coalesce(nullif(v_line->>'credit_base','')::numeric,0),4);
    if v_acc is null or (v_debit<=0 and v_credit<=0) or (v_debit>0 and v_credit>0) then
      raise exception 'كل سطر في القيد يجب أن يحتوي على حساب ومبلغ مدين أو دائن فقط';
    end if;
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,credit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_acc,v_debit,v_credit,'YER',greatest(v_debit,v_credit),v_party,coalesce(v_line->>'memo',v_desc));
    v_total_debit := v_total_debit + v_debit;
    v_total_credit := v_total_credit + v_credit;
    v_count := v_count + 1;
  end loop;

  if v_count < 2 or abs(v_total_debit - v_total_credit) > 0.01 then
    raise exception 'القيد اليدوي غير متوازن (المدين: %، الدائن: %)', v_total_debit, v_total_credit;
  end if;

  return v_entry;
end $$;

-- 8. عرض أرصدة العملاء والموردين الحية v_party_balances
create or replace view shaibani_erp.v_party_balances
with (security_invoker = true) as
select
  p.id,
  p.party_type,
  p.name,
  p.phone,
  p.address,
  p.opening_balance,
  p.opening_balance_side,
  p.opening_currency,
  coalesce(sum(jl.debit_base), 0)::numeric(20,4) as total_debit_base,
  coalesce(sum(jl.credit_base), 0)::numeric(20,4) as total_credit_base,
  coalesce(sum(jl.debit_base - jl.credit_base), 0)::numeric(20,4) as net_balance_base
from shaibani_erp.parties p
left join shaibani_erp.journal_lines jl on jl.party_id = p.id
left join shaibani_erp.journal_entries je on je.id = jl.entry_id and je.posted = true
where p.active = true and (jl.id is null or je.id is not null)
group by p.id, p.party_type, p.name, p.phone, p.address, p.opening_balance, p.opening_balance_side, p.opening_currency;

grant select on shaibani_erp.v_party_balances to authenticated;
grant execute on function shaibani_erp.save_product(jsonb) to authenticated;
grant execute on function shaibani_erp.post_document(jsonb) to authenticated;
grant execute on function shaibani_erp.post_stock_adjustment(jsonb) to authenticated;
grant execute on function shaibani_erp.post_cash_transfer(jsonb) to authenticated;
grant execute on function shaibani_erp.post_manual_journal_entry(jsonb) to authenticated;

notify pgrst, 'reload schema';
commit;

-- ترقية آمنة لدالة ترحيل المستندات في المخطط الحالي فقط.
-- شغّلها بعد نسخة احتياطية، ومن SQL Editor بحساب مالك قاعدة البيانات.
-- لا تنشئ جداول ولا تلمس مخطط public.

-- إنشاء دالة ترحيل المستندات فقط في المخطط shaibani_erp.
-- لا ينشئ جداول أو يغير بيانات موجودة. خذ نسخة احتياطية قبل التنفيذ.
-- يتوافق payload مع app.js: doc_type, document_date, currency, exchange_rate,
-- settlement_method, cash_account_id, party_id, expense_account_id, amount, lines.

begin;

do $$
begin
  if to_regclass('shaibani_erp.documents') is null
     or to_regclass('shaibani_erp.document_lines') is null
     or to_regclass('shaibani_erp.journal_entries') is null
     or to_regclass('shaibani_erp.journal_lines') is null
     or to_regclass('shaibani_erp.stock_movements') is null
     or to_regclass('shaibani_erp.products') is null
     or to_regclass('shaibani_erp.product_units') is null
     or to_regclass('shaibani_erp.profiles') is null
     or to_regclass('shaibani_erp.accounts') is null
     or to_regclass('shaibani_erp.cash_accounts') is null
     or to_regclass('shaibani_erp.parties') is null
     or to_regclass('shaibani_erp.currencies') is null
     or to_regclass('shaibani_erp.exchange_rates') is null
     or to_regclass('shaibani_erp.warehouses') is null
     or to_regclass('shaibani_erp.settings') is null then
    raise exception 'مخطط shaibani_erp غير مكتمل: أحد الجداول المطلوبة غير موجود';
  end if;
end $$;

create or replace function shaibani_erp.post_document(p_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path=pg_catalog,shaibani_erp,pg_temp
as $$
declare
  v_uid uuid := auth.uid(); v_role text; v_type text; v_currency text; v_fx numeric(20,8);
  v_date date; v_party uuid; v_method text; v_cash_id uuid; v_cash_account uuid; v_base_currency text; v_db_fx numeric(20,8);
  v_expense_account uuid; v_warehouse uuid; v_subtotal numeric(20,4):=0;
  v_discount numeric(20,4):=0; v_tax numeric(20,4):=0; v_total numeric(20,4):=0;
  v_doc uuid; v_doc_no text; v_entry uuid; v_entry_no text;
  v_line jsonb; v_product uuid; v_unit uuid; v_unit_name text; v_product_name text; v_factor numeric(20,8);
  v_qty numeric(20,4); v_qty_base numeric(20,6); v_price numeric(20,4); v_line_total numeric(20,4);
  v_available numeric(20,6); v_old_qty numeric(20,6); v_avg_cost numeric(20,6); v_cost numeric(20,4):=0;
  v_base_total numeric(20,4); v_revenue numeric(20,4); v_tax_base numeric(20,4);
  v_debit_account uuid; v_credit_account uuid; v_revenue_account uuid; v_inventory_account uuid;
  v_cogs_account uuid; v_tax_account uuid; v_ap_account uuid; v_ar_account uuid;
  v_lines_count integer:=0; v_amount numeric(20,4);
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'بيانات المستند غير صالحة';
  end if;
  if v_uid is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
  select role into v_role from shaibani_erp.profiles where id=v_uid and is_active=true;
  if v_role is null then raise exception 'الحساب غير مفعّل؛ راجع مدير النظام'; end if;
  if v_role not in ('manager','accountant','cashier') then
    raise exception 'دور المستخدم غير معتمد لتنفيذ العمليات';
  end if;
  v_type := p_payload->>'doc_type';
  if v_type is null or v_type not in ('sale','purchase','expense','receipt','payment') then raise exception 'نوع المستند غير مدعوم'; end if;
  if v_role='cashier' and v_type<>'sale' then raise exception 'صلاحية الكاشير تسمح بفواتير البيع فقط'; end if;
  v_currency := coalesce(p_payload->>'currency','YER');
  if not exists(select 1 from shaibani_erp.currencies where code=v_currency and active) then raise exception 'العملة غير مفعّلة'; end if;
  v_fx := coalesce(nullif(p_payload->>'exchange_rate','')::numeric,1);
  if v_fx<=0 then raise exception 'سعر الصرف يجب أن يكون أكبر من صفر'; end if;
  v_date := coalesce(nullif(p_payload->>'document_date','')::date,current_date);
  select base_currency into v_base_currency from shaibani_erp.settings where id=1;
  if v_base_currency is null then raise exception 'حدد العملة الأساسية في الإعدادات'; end if;
  if v_currency=v_base_currency and abs(v_fx-1)>0.00000001 then raise exception 'سعر صرف العملة الأساسية يجب أن يساوي 1'; end if;
  if v_currency<>v_base_currency then
    select er.rate into v_db_fx from shaibani_erp.exchange_rates er where er.from_currency=v_currency and er.to_currency=v_base_currency and er.effective_date<=v_date order by er.effective_date desc limit 1;
    if v_db_fx is null then raise exception 'سجّل سعر صرف % مقابل % أولاً',v_currency,v_base_currency; end if;
    if abs(v_fx-v_db_fx)>0.00000001 then raise exception 'سعر الصرف لا يطابق السعر المعتمد بتاريخ المستند (%). أعد تحميل السعر من الإعدادات',v_db_fx; end if;
  end if;
  v_party := nullif(p_payload->>'party_id','')::uuid;
  v_method := coalesce(p_payload->>'settlement_method','cash');
  if v_method not in ('cash','credit') then raise exception 'طريقة السداد غير صحيحة'; end if;
  if (v_type in ('purchase','receipt','payment') or (v_type='sale' and v_method='credit') or (v_type='expense' and v_method='credit')) and v_party is null then raise exception 'اختر العميل أو المورد'; end if;
  if v_type='purchase' and not exists(select 1 from shaibani_erp.parties where id=v_party and party_type in ('supplier','both') and active) then raise exception 'الطرف المحدد ليس مورداً فعالاً'; end if;
  if v_type='expense' and v_method='credit' and not exists(select 1 from shaibani_erp.parties where id=v_party and party_type in ('supplier','both') and active) then raise exception 'حدد مورداً فعالاً للمصروف الآجل'; end if;
  if v_type in ('sale','receipt') and v_party is not null and not exists(select 1 from shaibani_erp.parties where id=v_party and party_type in ('customer','both') and active) then raise exception 'الطرف المحدد ليس عميلاً فعالاً'; end if;
  if v_type='payment' and not exists(select 1 from shaibani_erp.parties where id=v_party and party_type in ('supplier','both') and active) then raise exception 'اختر مورداً فعالاً للسداد'; end if;
  v_cash_id := nullif(p_payload->>'cash_account_id','')::uuid;
  if v_method='cash' or v_type in ('receipt','payment') then
    if v_cash_id is null then raise exception 'اختر الصندوق'; end if;
    select ca.account_id into v_cash_account from shaibani_erp.cash_accounts ca
      where ca.id=v_cash_id and ca.currency=v_currency and ca.active;
    if v_cash_account is null then raise exception 'الصندوق غير موجود أو عملته لا تطابق عملة المستند'; end if;
  end if;
  v_expense_account := nullif(p_payload->>'expense_account_id','')::uuid;
  if v_type='expense' then
    if v_role='cashier' then raise exception 'لا تملك صلاحية تسجيل المصروفات'; end if;
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
  if v_type in ('sale','purchase') and v_warehouse is null then raise exception 'أنشئ مستودعاً افتراضياً أولاً'; end if;

  if v_type in ('sale','purchase') then
    if jsonb_typeof(p_payload->'lines')<>'array' then raise exception 'أضف بنداً واحداً على الأقل'; end if;
    for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
      v_product := (v_line->>'product_id')::uuid; v_unit := (v_line->>'unit_id')::uuid;
      v_qty := (v_line->>'quantity')::numeric; v_price := (v_line->>'unit_price')::numeric;
      if v_qty is null or v_price is null or v_qty<=0 or v_price<=0 then raise exception 'تحقق من الكمية والسعر؛ يجب أن يكون السعر أكبر من صفر'; end if;
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
  if v_type<>'sale' and (v_discount<>0 or v_tax<>0) then raise exception 'الخصم والضريبة مفعّلان حالياً في فواتير البيع فقط'; end if;
  v_total := round(v_subtotal-v_discount+v_tax,4);
  if v_total<=0 then raise exception 'إجمالي المستند يجب أن يكون أكبر من صفر'; end if;
  if v_type in ('receipt','payment') then v_method:='cash'; end if;
  if v_type='expense' and v_method='credit' and v_party is null then raise exception 'حدد الطرف عند تسجيل مصروف آجل'; end if;

  -- تأكيد وجود الحسابات الأساسية ونشاطها قبل إنشاء أي مستند.
  if v_type='sale' then
    if v_revenue_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_revenue_account and active) then raise exception 'حساب إيرادات المبيعات 4000 غير موجود أو غير نشط'; end if;
    if v_inventory_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_inventory_account and active) then raise exception 'حساب المخزون 1200 غير موجود أو غير نشط'; end if;
    if v_cogs_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_cogs_account and active) then raise exception 'حساب تكلفة المبيعات 5000 غير موجود أو غير نشط'; end if;
    if v_method='credit' and (v_ar_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_ar_account and active)) then raise exception 'حساب العملاء 1100 غير موجود أو غير نشط'; end if;
    if v_tax>0 and (v_tax_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_tax_account and active)) then raise exception 'حساب الضريبة 2100 غير موجود أو غير نشط'; end if;
  elsif v_type='purchase' then
    if v_inventory_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_inventory_account and active) then raise exception 'حساب المخزون 1200 غير موجود أو غير نشط'; end if;
    if v_method='credit' and (v_ap_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_ap_account and active)) then raise exception 'حساب الموردين 2000 غير موجود أو غير نشط'; end if;
  elsif v_type='expense' then
    if v_expense_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_expense_account and account_type='expense' and active) then raise exception 'حساب المصروف غير موجود أو غير نشط'; end if;
    if v_method='credit' and (v_ap_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_ap_account and active)) then raise exception 'حساب الموردين 2000 غير موجود أو غير نشط'; end if;
  elsif v_type='receipt' then
    if v_ar_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_ar_account and active) then raise exception 'حساب العملاء 1100 غير موجود أو غير نشط'; end if;
  elsif v_type='payment' then
    if v_ap_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_ap_account and active) then raise exception 'حساب الموردين 2000 غير موجود أو غير نشط'; end if;
  end if;

  if v_method='cash' or v_type in ('receipt','payment') then
    if v_cash_account is null or not exists(select 1 from shaibani_erp.accounts where id=v_cash_account and active) then raise exception 'الحساب المرتبط بالصندوق غير موجود أو غير نشط'; end if;
  end if;

  v_doc_no := case v_type when 'sale' then 'SAL' when 'purchase' then 'PUR' when 'expense' then 'EXP' when 'receipt' then 'RCT' else 'PAY' end
    || '-' || to_char(clock_timestamp(),'YYYYMMDD-HH24MISS-MS') || '-' || upper(substr(replace(pg_catalog.gen_random_uuid()::text,'-',''),1,5));
  insert into shaibani_erp.documents(doc_no,doc_type,party_id,document_date,currency,exchange_rate,settlement_method,cash_account_id,expense_account_id,subtotal,discount,tax,total,notes,created_by)
  values(v_doc_no,v_type,v_party,v_date,v_currency,v_fx,v_method,v_cash_id,v_expense_account,v_subtotal,v_discount,v_tax,v_total,p_payload->>'notes',v_uid)
  returning id into v_doc;

  if v_type in ('sale','purchase') then
    -- قفل الأصناف بترتيب UUID ثابت لتقليل احتمالات التعارض بين الفواتير المتزامنة.
    perform 1
    from shaibani_erp.products p
    where p.id in (
      select distinct (x.value->>'product_id')::uuid
      from jsonb_array_elements(p_payload->'lines') as x(value)
    )
    order by p.id
    for update;

    for v_line in select value from jsonb_array_elements(p_payload->'lines') loop
      v_product := (v_line->>'product_id')::uuid; v_unit := (v_line->>'unit_id')::uuid;
      v_qty := (v_line->>'quantity')::numeric; v_price := (v_line->>'unit_price')::numeric;
      select pu.unit_name,pu.factor_to_base,pr.name into v_unit_name,v_factor,v_product_name
      from shaibani_erp.product_units pu join shaibani_erp.products pr on pr.id=pu.product_id
      where pu.id=v_unit and pu.product_id=v_product and pu.active and pr.active;
      v_qty_base := round(v_qty*v_factor,6); v_line_total := round(v_qty*v_price,4);
      insert into shaibani_erp.document_lines(document_id,product_id,product_name,unit_id,unit_name,quantity,factor_to_base,quantity_base,unit_price,line_total)
      values(v_doc,v_product,v_product_name,v_unit,v_unit_name,v_qty,v_factor,v_qty_base,v_price,v_line_total);
      -- Lock the product row before reading stock so concurrent cashiers cannot oversell stale quantities.
      select avg_cost_base into v_avg_cost from shaibani_erp.products where id=v_product and active;
      select coalesce(sum(sm.quantity_in-sm.quantity_out),0) into v_old_qty from shaibani_erp.stock_movements sm
      where sm.product_id=v_product and sm.warehouse_id=v_warehouse;
      if v_type='sale' then
        if coalesce(v_avg_cost,0)<=0 then raise exception 'تكلفة الصنف غير محددة؛ سجّل فاتورة شراء أو رصيداً افتتاحياً بتكلفة صحيحة أولاً'; end if;
        v_available := v_old_qty;
        if v_available < v_qty_base then raise exception 'المخزون غير كافٍ للصنف: % (المتاح %)',(select name from shaibani_erp.products where id=v_product),v_available; end if;
        insert into shaibani_erp.stock_movements(product_id,warehouse_id,document_id,movement_type,quantity_out,unit_cost_base,created_by)
        values(v_product,v_warehouse,v_doc,'sale',v_qty_base,v_avg_cost,v_uid);
        v_cost := v_cost+(v_qty_base*v_avg_cost);
      else
        insert into shaibani_erp.stock_movements(product_id,warehouse_id,document_id,movement_type,quantity_in,unit_cost_base,created_by)
        values(v_product,v_warehouse,v_doc,'purchase',v_qty_base,round(v_price*v_fx/v_factor,6),v_uid);
        perform set_config('shaibani.allow_cost_recalc','on',true);
        update shaibani_erp.products set avg_cost_base=case when (v_old_qty+v_qty_base)>0
          then round(((v_old_qty*coalesce(v_avg_cost,0))+(v_qty_base*(v_price*v_fx/v_factor)))/(v_old_qty+v_qty_base),6)
          else round(v_price*v_fx/v_factor,6) end
        where id=v_product;
        perform set_config('shaibani.allow_cost_recalc','off',true);
      end if;
    end loop;
  end if;

  v_entry_no := 'JE-'||to_char(clock_timestamp(),'YYYYMMDD-HH24MISS-MS')||'-'||upper(substr(replace(pg_catalog.gen_random_uuid()::text,'-',''),1,4));
  insert into shaibani_erp.journal_entries(entry_no,entry_date,description,document_id,created_by)
  values(v_entry_no,v_date,case v_type when 'sale' then 'قيد فاتورة مبيعات '||v_doc_no when 'purchase' then 'قيد فاتورة مشتريات '||v_doc_no when 'expense' then 'قيد مصروف '||v_doc_no when 'receipt' then 'سند قبض '||v_doc_no else 'سند صرف '||v_doc_no end,v_doc,v_uid)
  returning id into v_entry;
  v_base_total := round(v_total*v_fx,4);

  if v_type='sale' then
    v_debit_account := case when v_method='cash' then v_cash_account else v_ar_account end;
    v_revenue := round((v_subtotal-v_discount)*v_fx,4); v_tax_base:=round(v_tax*v_fx,4);
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_debit_account,v_base_total,v_currency,v_total,v_party,'إثبات قيمة البيع');
    if v_revenue>0 then insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,party_id,memo)
      values(v_entry,v_revenue_account,v_revenue,v_currency,v_subtotal-v_discount,v_party,'إيراد المبيعات'); end if;
    if v_tax_base>0 then insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,memo)
      values(v_entry,v_tax_account,v_tax_base,v_currency,v_tax,'الضريبة المستحقة'); end if;
    if v_cost>0 then
      insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,memo) values(v_entry,v_cogs_account,round(v_cost,4),v_currency,0,'تكلفة البضاعة المباعة');
      insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,memo) values(v_entry,v_inventory_account,round(v_cost,4),v_currency,0,'تخفيض المخزون');
    end if;
  elsif v_type='purchase' then
    v_credit_account := case when v_method='cash' then v_cash_account else v_ap_account end;
    insert into shaibani_erp.journal_lines(entry_id,account_id,debit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_inventory_account,round(v_subtotal*v_fx,4),v_currency,v_subtotal,v_party,'إضافة مشتريات للمخزون');
    insert into shaibani_erp.journal_lines(entry_id,account_id,credit_base,currency,foreign_amount,party_id,memo)
    values(v_entry,v_credit_account,round(v_subtotal*v_fx,4),v_currency,v_subtotal,v_party,'مقابل المشتريات');
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

revoke all on function shaibani_erp.post_document(jsonb) from public, anon;
grant usage on schema shaibani_erp to authenticated;
grant execute on function shaibani_erp.post_document(jsonb) to authenticated;

-- تحديث مخطط PostgREST حتى تظهر الدالة عبر Supabase RPC.
notify pgrst, 'reload schema';

commit;

-- فحص بعد التنفيذ: يجب أن تظهر exists=true و can_execute=true.
select
  to_regprocedure('shaibani_erp.post_document(jsonb)') is not null as post_document_exists,
  case when to_regprocedure('shaibani_erp.post_document(jsonb)') is not null
       then has_function_privilege('authenticated', to_regprocedure('shaibani_erp.post_document(jsonb)'), 'EXECUTE')
       else false end as authenticated_can_execute;

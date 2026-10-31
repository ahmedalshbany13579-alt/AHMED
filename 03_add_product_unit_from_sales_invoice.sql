-- إضافة وحدة جديدة لصنف من داخل فاتورة المبيعات.
-- ينفذها مدير النظام أو المحاسب فقط، وتبقى الوحدة مرتبطة بالصنف.
-- لا يستهدف public ولا يمنح كتابة مباشرة على جدول product_units.

begin;

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

  select p.role
    into v_role
  from shaibani_erp.profiles p
  where p.id = v_uid
    and p.is_active = true;

  if v_role not in ('manager', 'accountant') then
    raise exception 'إضافة وحدات الأصناف متاحة للمدير والمحاسب فقط';
  end if;

  if p_product_id is null or v_unit_name is null then
    raise exception 'حدد الصنف واسم الوحدة';
  end if;
  if p_factor_to_base is null or p_factor_to_base <= 0 then
    raise exception 'عامل التحويل يجب أن يكون أكبر من صفر';
  end if;
  if coalesce(p_purchase_price, 0) < 0 or coalesce(p_sale_price, 0) < 0 then
    raise exception 'أسعار الوحدة لا يمكن أن تكون سالبة';
  end if;
  if p_currency is null or p_currency not in ('YER', 'SAR', 'USD') then
    raise exception 'عملة الوحدة غير مدعومة';
  end if;

  -- قفل الصنف لتفادي إنشاء وحدات مكررة بالتزامن.
  perform 1
  from shaibani_erp.products pr
  where pr.id = p_product_id
    and pr.active = true
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
    if v_is_base then
      raise exception 'اسم الوحدة مستخدم كوحدة أساسية لهذا الصنف';
    end if;
    if abs(v_existing_factor - p_factor_to_base) > 0.00000001 then
      raise exception 'الوحدة موجودة بعامل تحويل مختلف؛ لا تغيّر عامل وحدة مستخدمة في فواتير سابقة';
    end if;

    update shaibani_erp.product_units
    set purchase_price = coalesce(p_purchase_price, 0),
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

revoke all on function shaibani_erp.add_product_unit_to_product(uuid, text, numeric, numeric, numeric, text) from public, anon;
grant usage on schema shaibani_erp to authenticated;
grant execute on function shaibani_erp.add_product_unit_to_product(uuid, text, numeric, numeric, numeric, text) to authenticated;

commit;

-- فحص وجود الدالة وصلاحية تنفيذها
select
  to_regprocedure('shaibani_erp.add_product_unit_to_product(uuid,text,numeric,numeric,numeric,text)') is not null as add_product_unit_exists,
  has_function_privilege(
    'authenticated',
    to_regprocedure('shaibani_erp.add_product_unit_to_product(uuid,text,numeric,numeric,numeric,text)'),
    'EXECUTE'
  ) as authenticated_can_execute;

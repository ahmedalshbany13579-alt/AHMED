-- حارس مركزي لمنع تكرار أسماء الأصناف والرموز عبر الأجهزة والمستخدمين.
-- شغّل استعلام الفحص أولاً، وخذ نسخة احتياطية قبل اعتماد هذا الترحيل.
begin;

-- توحيد الاسم العربي لتقريب سلوك الخادم من الفحص المحلي في واجهة التطبيق.
create or replace function shaibani_erp.normalize_product_identity(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select lower(
    btrim(
      regexp_replace(
        translate(
          regexp_replace(coalesce(p_value, ''), '[ً-ٰٟـ]', '', 'g'),
          'أإآٱىؤئ',
          'اااايوي'
        ),
        '[[:space:] ]+', ' ', 'g'
      )
    )
  );
$$;

create or replace function shaibani_erp.reject_duplicate_product_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, shaibani_erp, pg_temp
as $$
declare
  v_name_key text;
  v_sku_key text;
begin
  -- السماح بتعطيل صنف مكرر قديم حتى يتمكن المدير من معالجة البيانات.
  if not coalesce(new.active, true) then
    return new;
  end if;

  v_name_key := shaibani_erp.normalize_product_identity(new.name);
  v_sku_key := shaibani_erp.normalize_product_identity(new.sku);

  if v_name_key = '' then
    raise exception 'اسم الصنف مطلوب';
  end if;

  -- قفل معاملاتي حسب الاسم لمنع إدخال نفس الاسم بالتزامن من جهازين.
  perform pg_advisory_xact_lock(hashtext('product-name:' || v_name_key)::bigint);
  if exists (
    select 1
    from shaibani_erp.products p
    where p.active = true
      and p.id is distinct from new.id
      and shaibani_erp.normalize_product_identity(p.name) = v_name_key
  ) then
    raise exception 'اسم الصنف مسجل مسبقاً: %', new.name;
  end if;

  if v_sku_key <> '' then
    perform pg_advisory_xact_lock(hashtext('product-sku:' || v_sku_key)::bigint);
    if exists (
      select 1
      from shaibani_erp.products p
      where p.active = true
        and p.id is distinct from new.id
        and shaibani_erp.normalize_product_identity(p.sku) = v_sku_key
    ) then
      raise exception 'رمز الصنف أو الباركود مسجل مسبقاً: %', new.sku;
    end if;
  end if;

  return new;
end;
$$;

-- فهارس تعبيرية فريدة تفرض القاعدة وتسرّع البحث حتى مع الإدخال المتزامن.
create unique index if not exists products_active_name_identity_uidx
  on shaibani_erp.products (shaibani_erp.normalize_product_identity(name))
  where active = true;

create unique index if not exists products_active_sku_identity_uidx
  on shaibani_erp.products (shaibani_erp.normalize_product_identity(sku))
  where active = true and nullif(shaibani_erp.normalize_product_identity(sku), '') is not null;

revoke all on function shaibani_erp.normalize_product_identity(text) from public, anon, authenticated;
revoke all on function shaibani_erp.reject_duplicate_product_identity() from public, anon, authenticated;

drop trigger if exists trg_reject_duplicate_product_identity on shaibani_erp.products;
create trigger trg_reject_duplicate_product_identity
before insert or update of name, sku, active
on shaibani_erp.products
for each row
execute function shaibani_erp.reject_duplicate_product_identity();

commit;

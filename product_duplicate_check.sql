-- شغّل هذا الفحص قبل ترحيل 07؛ التطبيع هنا مكتوب داخلياً لذلك لا يعتمد على الدالة الجديدة.
-- يشمل الهمزات والحركات والتطويل والمسافات المتكررة.
select
  lower(btrim(regexp_replace(translate(regexp_replace(coalesce(name, ''), '[ً-ٰٟـ]', '', 'g'), 'أإآٱىؤئ', 'اااايوي'), '[[:space:] ]+', ' ', 'g'))) as normalized_name,
  count(*) as duplicate_count,
  array_agg(id order by created_at) as product_ids,
  array_agg(name order by created_at) as source_names
from shaibani_erp.products
where active = true
group by 1
having count(*) > 1
order by duplicate_count desc, normalized_name;

select
  lower(btrim(regexp_replace(translate(regexp_replace(coalesce(sku, ''), '[ً-ٰٟـ]', '', 'g'), 'أإآٱىؤئ', 'اااايوي'), '[[:space:] ]+', ' ', 'g'))) as normalized_sku,
  count(*) as duplicate_count,
  array_agg(id order by created_at) as product_ids,
  array_agg(name order by created_at) as product_names
from shaibani_erp.products
where active = true and nullif(btrim(regexp_replace(coalesce(sku, ''), '[[:space:] ]+', ' ', 'g')), '') is not null
group by 1
having count(*) > 1
order by duplicate_count desc, normalized_sku;

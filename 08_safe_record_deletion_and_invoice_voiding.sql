-- إدارة الحذف النهائي الآمن للأصناف والعملاء وإلغاء الفواتير بأمان محاسبياً.
-- نفّذ بعد استكمال patches السابقة، وبعد أخذ نسخة احتياطية.
-- لا يمنح هذا الترحيل صلاحية حذف مباشر للجداول؛ العمليات تمر عبر RPC محمي بالمدير.

begin;

-- تحفظ الإجراءات ذات الصلاحيات المرتفعة في مخطط داخلي غير مخصص لـ Data API.
-- مهم: لا تضف shaibani_internal إلى قائمة Exposed schemas في Supabase؛ التطبيق يستدعي واجهات shaibani_erp فقط.
create schema if not exists shaibani_internal;
revoke all on schema shaibani_internal from public, anon;
grant usage on schema shaibani_internal to authenticated;

create table if not exists shaibani_erp.record_management_audit (
  id bigint generated always as identity primary key,
  entity_type text not null check (entity_type in ('product','party','document')),
  record_id uuid not null,
  record_label text not null,
  operation text not null check (operation in ('deleted','archived','voided')),
  performed_by uuid not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists record_management_audit_created_idx
  on shaibani_erp.record_management_audit(created_at desc);
create index if not exists record_management_audit_record_idx
  on shaibani_erp.record_management_audit(entity_type, record_id, created_at desc);

alter table shaibani_erp.record_management_audit enable row level security;
revoke all on table shaibani_erp.record_management_audit from public, anon, authenticated;
-- لا تسمح بحذف مباشر يتجاوز قواعد الحذف والإلغاء الآمن.
revoke delete on table shaibani_erp.products, shaibani_erp.parties, shaibani_erp.documents
  from public, anon, authenticated;

-- حذف نهائي فقط عند عدم وجود أي ارتباط تشغيلي أو محاسبي؛ السجلات المرتبطة تُحمى من الحذف.
create or replace function shaibani_internal.manage_catalog_record_delete(
  p_entity text,
  p_record_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_label text;
  v_action text;
  v_party_type text;
  v_opening_balance numeric(20,4);
  v_opening_side text;
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  select pr.role into v_role
  from shaibani_erp.profiles as pr
  where pr.id = v_uid and pr.is_active = true;

  if v_role is distinct from 'manager' then
    raise exception 'الحذف وإلغاء الفواتير متاحان لمدير النظام فقط';
  end if;

  if p_record_id is null then
    raise exception 'لم يتم تحديد السجل المطلوب';
  end if;

  if p_entity = 'product' then
    select p.name into v_label
    from shaibani_erp.products as p
    where p.id = p_record_id
    for update;

    if not found then
      raise exception 'الصنف غير موجود أو سبق حذفه';
    end if;

    if exists (
      select 1 from shaibani_erp.stock_movements as sm
      where sm.product_id = p_record_id
    ) or exists (
      select 1 from shaibani_erp.document_lines as dl
      where dl.product_id = p_record_id
    ) then
      raise exception 'لا يمكن حذف الصنف % لأنه مرتبط بحركات مخزنية أو فواتير سابقة. احتفظ به حتى لا تتأثر تقارير المخزون وتكلفة البضاعة.', v_label;
    end if;

    delete from shaibani_erp.product_catalog_events
    where product_id = p_record_id;
    -- وحدات الصنف التابعة تحذف وفق علاقة المفتاح الخارجي المعرفة في المخطط.
    delete from shaibani_erp.products
    where id = p_record_id;
    v_action := 'deleted';

  elsif p_entity = 'party' then
    select p.name, p.party_type, p.opening_balance, p.opening_balance_side
    into v_label, v_party_type, v_opening_balance, v_opening_side
    from shaibani_erp.parties as p
    where p.id = p_record_id
    for update;

    if not found then
      raise exception 'العميل غير موجود أو سبق حذفه';
    end if;
    if v_party_type not in ('customer','both') then
      raise exception 'هذا السجل ليس عميلاً؛ لا يمكن حذفه من شاشة العملاء';
    end if;

    if v_party_type = 'both'
       or coalesce(v_opening_balance, 0) <> 0
       or coalesce(v_opening_side, 'none') <> 'none'
       or exists (
         select 1 from shaibani_erp.documents as d
         where d.party_id = p_record_id
       )
       or exists (
         select 1 from shaibani_erp.journal_lines as jl
         where jl.party_id = p_record_id
       ) then
      raise exception 'لا يمكن حذف العميل % لأنه مرتبط بفواتير أو قيود أو رصيد افتتاحي. احتفظ بسجله لحماية كشف الحساب والتاريخ المحاسبي.', v_label;
    end if;

    delete from shaibani_erp.parties
    where id = p_record_id;
    v_action := 'deleted';

  else
    raise exception 'نوع السجل غير مدعوم؛ الأنواع المسموحة: product, party';
  end if;

  insert into shaibani_erp.record_management_audit(
    entity_type, record_id, record_label, operation, performed_by, details
  ) values (
    p_entity, p_record_id, coalesce(v_label, p_record_id::text), v_action, v_uid,
    jsonb_build_object(
      'source', 'application',
      'reason', 'لا توجد مراجع تشغيلية تمنع الحذف النهائي.'
    )
  );

  return jsonb_build_object(
    'entity', p_entity,
    'record_id', p_record_id,
    'record_label', v_label,
    'action', v_action
  );
end;
$function$;

-- واجهة RPC في المخطط المكشوف تعمل بصلاحيات المستدعي وتفوض إلى دالة داخلية محمية.
create or replace function shaibani_erp.manage_catalog_record_delete(
  p_entity text,
  p_record_id uuid
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select shaibani_internal.manage_catalog_record_delete(p_entity, p_record_id);
$function$;

revoke all on function shaibani_internal.manage_catalog_record_delete(text, uuid)
  from public, anon;
grant execute on function shaibani_internal.manage_catalog_record_delete(text, uuid)
  to authenticated;

-- إلغاء مستند مرحّل بقيد عكسي وحركات مخزون عكسية، دون محو أثره التاريخي.
create or replace function shaibani_internal.void_posted_document(
  p_document_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_role text;
  v_doc shaibani_erp.documents%rowtype;
  v_movement record;
  v_product_id uuid;
  v_available numeric(20,6);
  v_journal_entry_id uuid;
  v_reversal_entry_id uuid;
  v_original_entries integer := 0;
  v_entry_no text;
  v_new_qty numeric(20,6);
  v_new_value numeric(24,8);
  v_new_avg numeric(20,6);
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_uid is null then
    raise exception 'يجب تسجيل الدخول أولاً';
  end if;

  select pr.role into v_role
  from shaibani_erp.profiles as pr
  where pr.id = v_uid and pr.is_active = true;

  if v_role is distinct from 'manager' then
    raise exception 'إلغاء الفواتير والوثائق المرحّلة متاح لمدير النظام فقط';
  end if;
  if p_document_id is null then
    raise exception 'لم يتم تحديد الفاتورة المطلوب إلغاؤها';
  end if;

  select d.* into v_doc
  from shaibani_erp.documents as d
  where d.id = p_document_id
  for update;

  if not found then
    raise exception 'الفاتورة غير موجودة';
  end if;
  if v_doc.doc_type not in ('sale','purchase','sale_return','purchase_return') then
    raise exception 'هذه العملية مخصصة لفواتير البيع والشراء والمرتجعات فقط؛ استخدم إجراء الإلغاء المعتمد للسندات الأخرى.';
  end if;
  if v_doc.status = 'void' then
    raise exception 'هذه الفاتورة ملغاة مسبقاً';
  end if;
  if v_doc.status <> 'posted' then
    raise exception 'لا يمكن إلغاء فاتورة بحالة غير مرحّلة';
  end if;

  select count(*) into v_original_entries
  from shaibani_erp.journal_entries as je
  where je.document_id = p_document_id and je.posted = true;
  if v_original_entries = 0 then
    raise exception 'لا يوجد قيد محاسبي مرحّل مرتبط بالفاتورة؛ أوقف العملية وراجع المحاسب';
  end if;

  -- قفل الأصناف المرتبطة لتفادي التعارض مع ترحيل فاتورة أو تسوية مخزون متزامنة.
  perform 1
  from shaibani_erp.products as p
  where p.id in (
    select distinct sm.product_id
    from shaibani_erp.stock_movements as sm
    where sm.document_id = p_document_id
  )
  order by p.id
  for update;

  -- متوسط التكلفة محفوظ على مستوى الصنف لا المستودع؛ لذلك نمنع الإلغاء عند وجود
  -- أي حركة أحدث للصنف في أي مستودع، مع كسر تعادل التوقيت بمعرّف الحركة.
  if exists (
    select 1
    from shaibani_erp.stock_movements as original_move
    join shaibani_erp.stock_movements as later_move
      on later_move.product_id = original_move.product_id
     and (later_move.created_at, later_move.id) > (original_move.created_at, original_move.id)
     and later_move.document_id is distinct from p_document_id
    where original_move.document_id = p_document_id
  ) then
    raise exception 'لا يمكن إلغاء هذه الفاتورة لوجود حركات مخزون لاحقة على أحد أصنافها. راجع تسلسل الحركات أولاً لتجنب تغيير تكلفة المخزون التاريخية.';
  end if;

  -- عكس كل حركة مخزون، مع رفض أي عكس ينتج عنه رصيد سالب.
  for v_movement in
    select sm.id, sm.product_id, sm.warehouse_id,
           sm.quantity_in, sm.quantity_out, sm.unit_cost_base
    from shaibani_erp.stock_movements as sm
    where sm.document_id = p_document_id
    order by sm.product_id, sm.warehouse_id, sm.id
    for update
  loop
    if coalesce(v_movement.quantity_in, 0) > 0 then
      select coalesce(sum(sm.quantity_in - sm.quantity_out), 0)
      into v_available
      from shaibani_erp.stock_movements as sm
      where sm.product_id = v_movement.product_id
        and sm.warehouse_id = v_movement.warehouse_id;

      if v_available < v_movement.quantity_in then
        raise exception 'لا يمكن إلغاء الفاتورة؛ الرصيد المتاح للصنف % لا يكفي لعكس الكمية المسجلة.', v_movement.product_id;
      end if;
    end if;

    insert into shaibani_erp.stock_movements(
      product_id, warehouse_id, document_id, movement_type,
      quantity_in, quantity_out, unit_cost_base, created_by
    ) values (
      v_movement.product_id,
      v_movement.warehouse_id,
      p_document_id,
      case when coalesce(v_movement.quantity_in, 0) > 0
        then 'adjustment_out' else 'adjustment_in' end,
      coalesce(v_movement.quantity_out, 0),
      coalesce(v_movement.quantity_in, 0),
      coalesce(v_movement.unit_cost_base, 0),
      v_uid
    );
  end loop;

  -- إنشاء قيد عكسي مستقل لكل قيد أصلي مرتبط بالفاتورة.
  for v_journal_entry_id in
    select je.id
    from shaibani_erp.journal_entries as je
    where je.document_id = p_document_id and je.posted = true
    order by je.created_at, je.id
    for update
  loop
    v_entry_no := 'REV-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISS-MS') || '-' ||
      upper(substr(replace((select pg_catalog.gen_random_uuid())::text, '-', ''), 1, 5));

    insert into shaibani_erp.journal_entries(
      entry_no, entry_date, description, document_id, posted, created_by
    ) values (
      v_entry_no,
      current_date,
      'قيد عكسي لإلغاء المستند ' || v_doc.doc_no,
      p_document_id,
      true,
      v_uid
    ) returning id into v_reversal_entry_id;

    insert into shaibani_erp.journal_lines(
      entry_id, account_id, debit_base, credit_base,
      currency, foreign_amount, party_id, memo
    )
    select
      v_reversal_entry_id,
      jl.account_id,
      jl.credit_base,
      jl.debit_base,
      jl.currency,
      jl.foreign_amount,
      jl.party_id,
      'عكس إلغاء: ' || coalesce(jl.memo, v_doc.doc_no)
    from shaibani_erp.journal_lines as jl
    where jl.entry_id = v_journal_entry_id;
  end loop;

  -- إعادة احتساب متوسط التكلفة للأصناف المتأثرة بعد عكس الحركات.
  for v_product_id in
    select distinct sm.product_id
    from shaibani_erp.stock_movements as sm
    where sm.document_id = p_document_id
  loop
    select
      coalesce(sum(sm.quantity_in - sm.quantity_out), 0),
      coalesce(sum((sm.quantity_in - sm.quantity_out) * sm.unit_cost_base), 0)
    into v_new_qty, v_new_value
    from shaibani_erp.stock_movements as sm
    where sm.product_id = v_product_id;

    v_new_avg := case
      when v_new_qty > 0 then greatest(0, round(v_new_value / v_new_qty, 6))::numeric(20,6)
      else 0::numeric(20,6)
    end;

    perform pg_catalog.set_config('shaibani.allow_cost_recalc', 'on', true);
    update shaibani_erp.products
    set avg_cost_base = v_new_avg
    where id = v_product_id;
    perform pg_catalog.set_config('shaibani.allow_cost_recalc', 'off', true);
  end loop;

  update shaibani_erp.documents
  set status = 'void'
  where id = p_document_id;

  insert into shaibani_erp.record_management_audit(
    entity_type, record_id, record_label, operation, performed_by, details
  ) values (
    'document', p_document_id, v_doc.doc_no, 'voided', v_uid,
    jsonb_build_object(
      'reason', coalesce(v_reason, 'إلغاء بطلب مدير النظام'),
      'reversal_entries', v_original_entries,
      'accounting_reversed', true,
      'stock_reversed', true
    )
  );

  return jsonb_build_object(
    'document_id', p_document_id,
    'document_no', v_doc.doc_no,
    'status', 'void',
    'reversed_journal_entries', v_original_entries
  );
end;
$function$;

create or replace function shaibani_erp.void_posted_document(
  p_document_id uuid,
  p_reason text default null
)
returns jsonb
language sql
volatile
security invoker
set search_path = ''
as $function$
  select shaibani_internal.void_posted_document(p_document_id, p_reason);
$function$;

revoke all on function shaibani_internal.void_posted_document(uuid, text)
  from public, anon;
grant execute on function shaibani_internal.void_posted_document(uuid, text)
  to authenticated;

revoke all on function shaibani_erp.manage_catalog_record_delete(text, uuid)
  from public, anon;
grant execute on function shaibani_erp.manage_catalog_record_delete(text, uuid)
  to authenticated;

revoke all on function shaibani_erp.void_posted_document(uuid, text)
  from public, anon;
grant execute on function shaibani_erp.void_posted_document(uuid, text)
  to authenticated;

notify pgrst, 'reload schema';
commit;

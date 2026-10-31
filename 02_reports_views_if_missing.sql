-- أنشئ/حدّث عروض التقارير الأربعة عند الحاجة فقط.
-- إذا كانت العروض موجودة وتعمل وصلاحياتها صحيحة، لا حاجة لإعادة تشغيل هذا الملف.

-- إنشاء عروض التقارير المفقودة فقط في مخطط shaibani_erp
-- لا ينشئ جداول ولا يغيّر بيانات ولا يستهدف public.
-- نفّذ بعد أخذ نسخة احتياطية، وبحساب مالك قاعدة البيانات في Supabase SQL Editor.

begin;

-- تأكيد الجداول والأعمدة المطلوبة قبل إنشاء أي عرض.
do $$
begin
  if to_regclass('shaibani_erp.accounts') is null
     or to_regclass('shaibani_erp.journal_lines') is null
     or to_regclass('shaibani_erp.journal_entries') is null
     or to_regclass('shaibani_erp.products') is null
     or to_regclass('shaibani_erp.stock_movements') is null
     or to_regclass('shaibani_erp.warehouses') is null
     or to_regclass('shaibani_erp.cash_accounts') is null then
    raise exception 'أحد الجداول الأساسية المطلوبة غير موجود داخل shaibani_erp';
  end if;
end $$;

-- ميزان المراجعة: أرصدة الحسابات من القيود المرحلة فقط.
create or replace view shaibani_erp.v_trial_balance
with (security_invoker = true) as
select
  a.id,
  a.code,
  a.name,
  a.account_type,
  a.normal_side,
  coalesce(sum(jl.debit_base), 0)::numeric(20,4) as debit,
  coalesce(sum(jl.credit_base), 0)::numeric(20,4) as credit,
  coalesce(sum(jl.debit_base - jl.credit_base), 0)::numeric(20,4) as net_balance
from shaibani_erp.accounts a
left join shaibani_erp.journal_lines jl on jl.account_id = a.id
left join shaibani_erp.journal_entries je on je.id = jl.entry_id and je.posted = true
where jl.id is null or je.id is not null
group by a.id, a.code, a.name, a.account_type, a.normal_side;

-- الأرباح والخسائر: الإيرادات والمصروفات من القيود المرحلة فقط.
create or replace view shaibani_erp.v_profit_loss
with (security_invoker = true) as
select
  a.account_type,
  a.code,
  a.name,
  coalesce(sum(
    case
      when a.account_type = 'revenue' then jl.credit_base - jl.debit_base
      else jl.debit_base - jl.credit_base
    end
  ), 0)::numeric(20,4) as net_amount
from shaibani_erp.accounts a
left join shaibani_erp.journal_lines jl on jl.account_id = a.id
left join shaibani_erp.journal_entries je on je.id = jl.entry_id and je.posted = true
where a.account_type in ('revenue', 'expense')
  and (jl.id is null or je.id is not null)
group by a.account_type, a.code, a.name;

-- ملخص المخزون حسب الصنف والمستودع.
-- إظهار التكلفة والقيمة للمدير والمحاسب فقط.
create or replace view shaibani_erp.v_inventory_summary
with (security_invoker = false) as
select
  p.id,
  p.sku,
  p.name,
  p.base_unit,
  case
    when shaibani_erp.current_app_role() in ('manager', 'accountant') then p.avg_cost_base
    else 0
  end as avg_cost_base,
  p.reorder_level,
  w.id as warehouse_id,
  w.name as warehouse_name,
  coalesce(sum(sm.quantity_in - sm.quantity_out), 0)::numeric(20,4) as quantity,
  (
    coalesce(sum(sm.quantity_in - sm.quantity_out), 0)
    * case
        when shaibani_erp.current_app_role() in ('manager', 'accountant') then p.avg_cost_base
        else 0
      end
  )::numeric(20,4) as inventory_value_base
from shaibani_erp.products p
cross join shaibani_erp.warehouses w
left join shaibani_erp.stock_movements sm
  on sm.product_id = p.id and sm.warehouse_id = w.id
where shaibani_erp.is_active_user()
  and p.active = true
  and w.active = true
group by p.id, p.sku, p.name, p.base_unit, p.avg_cost_base,
         p.reorder_level, w.id, w.name;

-- أرصدة الصناديق بعملة كل صندوق، من القيود المرحلة فقط.
create or replace view shaibani_erp.v_cash_balances
with (security_invoker = true) as
select
  ca.id,
  ca.name,
  ca.currency,
  ca.account_id,
  coalesce(sum(
    case
      when jl.debit_base > 0 then jl.foreign_amount
      when jl.credit_base > 0 then -jl.foreign_amount
      else 0
    end
  ), 0)::numeric(20,4) as foreign_balance
from shaibani_erp.cash_accounts ca
left join shaibani_erp.journal_lines jl
  on jl.account_id = ca.account_id and jl.currency = ca.currency
left join shaibani_erp.journal_entries je
  on je.id = jl.entry_id and je.posted = true
where ca.active = true
  and (jl.id is null or je.id is not null)
group by ca.id, ca.name, ca.currency, ca.account_id;

-- صلاحيات محددة على العروض فقط.
revoke all on shaibani_erp.v_trial_balance,
              shaibani_erp.v_profit_loss,
              shaibani_erp.v_inventory_summary,
              shaibani_erp.v_cash_balances
from public, anon;

grant usage on schema shaibani_erp to authenticated;
grant select on shaibani_erp.v_trial_balance,
                shaibani_erp.v_profit_loss,
                shaibani_erp.v_inventory_summary,
                shaibani_erp.v_cash_balances
to authenticated;

commit;

-- نتيجة تحقق مختصرة بعد الإنشاء.
select v.view_name,
       to_regclass('shaibani_erp.' || v.view_name) is not null as object_exists,
       case when to_regclass('shaibani_erp.' || v.view_name) is not null
         then has_table_privilege('authenticated', to_regclass('shaibani_erp.' || v.view_name), 'SELECT')
         else false
       end as authenticated_can_read
from (values ('v_cash_balances'), ('v_inventory_summary'),
             ('v_profit_loss'), ('v_trial_balance')) as v(view_name)
order by v.view_name;

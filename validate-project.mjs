import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

function pass(label) {
  checks.push({ label, ok: true });
}

function assert(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  pass(label);
}

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

try {
  const index = read('index.html');
  const app = read('app.js');
  const sw = read('sw.js');
  const manifest = JSON.parse(read('manifest.webmanifest'));
  const hardening = read('supabase/patches/06_security_and_validation_hardening.sql');
  const report = read('supabase/verification/security_hardening_check.sql');
  const css = read('styles.css');
  const offlineStore = read('offline-store.js');
  const duplicateGuard = read('supabase/patches/07_product_duplicate_guard.sql');
  const duplicateReport = read('supabase/verification/product_duplicate_check.sql');
  const deletionPatch = read('supabase/patches/08_safe_record_deletion_and_invoice_voiding.sql');
  const deletionReport = read('supabase/verification/deletion_feature_check.sql');

  for (const match of index.matchAll(/(?:src|href)="(\/(?:[^"?#]+))"/g)) {
    const asset = match[1].replace(/^\//, '');
    assert(existsSync(join(root, asset)), `ملف واجهة موجود: /${asset}`);
  }

  for (const match of sw.matchAll(/'\/(?:[^']+)'/g)) {
    const asset = match[0].slice(2, -1);
    assert(existsSync(join(root, asset)), `ملف PWA المخزّن موجود: /${asset}`);
  }

  assert(manifest.name && manifest.start_url && manifest.icons?.length >= 2, 'ملف PWA manifest صالح ويحتوي على الأيقونات الأساسية');
  assert(app.includes('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js'), 'مكتبة SheetJS مثبتة على الإصدار الرسمي 0.20.3');
  assert(!app.includes('cdn.jsdelivr.net/npm/xlsx@0.18.5'), 'إزالة رابط SheetJS القديم 0.18.5');
  assert(app.includes('if (xlsxLibraryPromise) return xlsxLibraryPromise;'), 'تحميل مكتبة Excel مرة واحدة عند تزامن الطلبات');
  assert(app.includes('nameSet.add(nameKey)') && app.includes('skuSet.add(skuKey)'), 'منع التكرار داخل ملف الاستيراد نفسه');
  assert(app.includes('تعذّر تسجيل رصيده الافتتاحي'), 'إظهار فشل الرصيد الافتتاحي بدلاً من إخفائه');

  for (const fn of [
    'add_product_unit_to_product',
    'post_stock_adjustment',
    'post_cash_transfer',
    'post_manual_journal_entry'
  ]) {
    const functionStart = hardening.indexOf(`function shaibani_erp.${fn}`);
    assert(functionStart >= 0, `ترقية أمان الدالة ${fn}`);
    const functionEnd = hardening.indexOf('$$;', functionStart);
    const body = hardening.slice(functionStart, functionEnd >= 0 ? functionEnd : undefined);
    assert(body.includes('if v_uid is null then'), `فحص المصادقة داخل ${fn}`);
    assert(body.includes('v_role is null or v_role not in'), `رفض الدور المفقود/غير المصرح داخل ${fn}`);
  }
  assert(hardening.includes("v_direction not in ('in', 'out')"), 'رفض اتجاهات تسوية المخزون غير المعروفة');
  assert(hardening.includes('grant execute on function shaibani_erp.add_product_unit_to_product'), 'منح تنفيذ إضافة الوحدة للمستخدم المصادق بعد التحقق من الدور');
  assert(hardening.includes('v_debit < 0') && hardening.includes('v_credit < 0'), 'رفض مبالغ القيود اليومية السالبة');
  assert(hardening.includes('from public, anon'), 'سحب صلاحية التنفيذ العامة وanon');
  assert(report.includes("has_function_privilege('anon'") && report.includes("has_function_privilege('authenticated'"), 'استعلام التحقق من صلاحيات anon والمستخدم المصادق');
  assert(report.includes('function_exists') && report.includes('shaibani_erp.post_cash_transfer'), 'استعلام التحقق يعرض أيضاً الدوال المفقودة بدلاً من إخفائها');

  assert(app.includes('class=\"items-mobile-list\"') && app.includes('data-item-card'), 'إنشاء قائمة أصناف مخصصة لبطاقات الهاتف');
  assert(app.includes('class=\"items-desktop-table\"'), 'الإبقاء على جدول الأصناف للشاشات الكبيرة');
  assert(app.includes("const itemCards = $$('#data-table [data-item-card]')"), 'تصفية بطاقات الأصناف عند البحث على الهاتف');
  assert(css.includes('.items-mobile-list {') && css.includes('display: none;') && css.includes('display: block;'), 'تعريف عرض متجاوب منفصل للجدول وبطاقات الهاتف');
  assert(css.includes('@media (max-width: 760px)') && css.includes('@media (max-width: 360px)'), 'إضافة نقاط توقف لشاشات الهاتف الصغيرة');
  assert(app.includes('data-action=\"new-product\"') && app.includes('data-action=\"import-items\"') && app.includes('data-action=\"new-stock-adjustment\"'), 'الإبقاء على إجراءات إضافة واستيراد وتسوية الأصناف');
  assert(sw.includes('shaibani-shell-v14-safe-delete-void'), 'تحديث ذاكرة PWA لنسخة الحذف الآمن وإلغاء الفواتير');
  assert(sw.includes("'/offline-store.js'") && existsSync(join(root, 'offline-store.js')), 'تخزين طبقة IndexedDB محلياً ضمن ملفات PWA');
  assert(app.includes("from './offline-store.js'") && app.includes('saveOfflineProduct'), 'ربط التطبيق بمخزن IndexedDB وحفظ الأصناف محلياً');
  assert(offlineStore.includes("createObjectStore('products'") && offlineStore.includes("createObjectStore('outbox'"), 'وجود مخازن الأصناف وطابور المزامنة المحلي');
  assert(offlineStore.includes('current_qty_at_entry') && offlineStore.includes('serverBaselineQty'), 'حفظ خط أساس الخادم عند تعديلات الرصيد المتكررة دون اتصال');
  assert(offlineStore.includes('transactionProducts = await requestResult(productStore.getAll())'), 'إعادة فحص التكرار داخل معاملة IndexedDB لمنع الحفظ المتزامن');
  assert(offlineStore.includes('export function stockSyncDecision'), 'توفير قرار مزامنة الرصيد واكتشاف التعارض');
  assert(app.includes('async function syncOfflineQueue') && app.includes("supabase.rpc('save_product'"), 'وجود مسار مزامنة الأصناف مع Supabase');
  assert(app.includes('priority(a) - priority(b)') && app.includes("item.type === 'save_product' ? 0 : 1"), 'مزامنة تعريف الصنف قبل حركة رصيده');
  assert(app.includes('stockSyncDecision(currentQty, baselineQty, targetQty)'), 'منع الكتابة فوق رصيد تغيّر على الخادم');
  assert(app.includes('window.confirm(conflictMessage)'), 'طلب موافقة صريحة قبل اعتماد جرد يتعارض مع رصيد الخادم');
  assert(app.includes('paddedBase64'), 'التحقق الصحيح من صلاحية رمز الدخول المخزّن محلياً');
  assert(app.includes('data-product-autocomplete') && app.includes('renderProductSuggestions'), 'إظهار اقتراحات الأصناف عند الكتابة');
  assert(app.includes("local_sync_state === 'pending'") && app.includes('const merged = new Map(serverProducts'), 'إبقاء الأصناف المحلية المعلقة ظاهرة بعد عودة الاتصال');
  assert(app.includes('pendingCachedProduct || products.find'), 'السماح بفتح وتعديل الصنف المحلي المعلق بعد عودة الاتصال');
  assert(app.includes('findDuplicateProduct') && app.includes('الصنف') && app.includes('موجود مسبقاً'), 'فحص تكرار الصنف قبل الحفظ محلياً');
  assert(duplicateGuard.includes('pg_advisory_xact_lock') && duplicateGuard.includes('trg_reject_duplicate_product_identity'), 'حارس قاعدة البيانات يمنع الإدخالات المتزامنة المكررة');
  assert(duplicateGuard.includes('products_active_name_identity_uidx') && duplicateGuard.includes('products_active_sku_identity_uidx'), 'فهارس فريدة لفرض عدم تكرار الاسم والرمز على الخادم');
  assert(duplicateGuard.includes('normalize_product_identity') && duplicateGuard.includes('translate('), 'تطبيع الهمزات والتشكيل والتطويل في منع التكرار على الخادم');
  assert(duplicateGuard.includes('if not coalesce(new.active, true) then'), 'السماح بتعطيل صنف قديم مكرر أثناء تنظيف البيانات');
  assert(duplicateReport.includes('having count(*) > 1') && duplicateReport.includes('translate('), 'استعلام مستقل لكشف التكرارات العربية قبل تفعيل الحارس');
  assert(deletionPatch.includes('function shaibani_internal.manage_catalog_record_delete') && deletionPatch.includes("v_role is distinct from 'manager'"), 'إجراء حذف الأصناف والعملاء محمي بدور المدير داخل مخطط داخلي');
  assert(deletionPatch.includes('function shaibani_erp.manage_catalog_record_delete') && deletionPatch.includes('security invoker'), 'واجهة RPC المكشوفة تفوض إلى دالة داخلية بصلاحيات المستدعي');
  assert(deletionPatch.includes('function shaibani_internal.void_posted_document') && deletionPatch.includes("set status = 'void'"), 'إلغاء الفواتير يحدّث الحالة مع الاحتفاظ بالمستند الأصلي');
  assert(deletionPatch.includes('journal_lines') && deletionPatch.includes('quantity_in') && deletionPatch.includes('quantity_out'), 'الإلغاء يعكس القيود المحاسبية وحركات المخزون');
  assert(deletionPatch.includes('(later_move.created_at, later_move.id) > (original_move.created_at, original_move.id)') && !deletionPatch.includes('later_move.warehouse_id = original_move.warehouse_id'), 'منع إلغاء حركة أقدم للصنف في أي مستودع لحماية متوسط التكلفة العام');
  assert(deletionPatch.includes('record_management_audit') && deletionPatch.includes('enable row level security'), 'تسجيل إجراءات الحذف والإلغاء بجدول تدقيق محمي');
  assert(deletionPatch.includes('revoke delete on table shaibani_erp.products') && deletionPatch.includes('shaibani_erp.documents'), 'منع الحذف المباشر من الجداول الحساسة');
  assert(deletionReport.includes('anon_can_execute') && deletionReport.includes('authenticated_can_execute') && deletionReport.includes('audit_rls_enabled'), 'توفير استعلام تحقق مستقل لصلاحيات دوال الحذف والتدقيق');
  assert(deletionPatch.includes('لا تضف shaibani_internal إلى قائمة Exposed schemas'), 'التنبيه إلى إبقاء مخطط الإجراءات الداخلية خارج Supabase Data API');
  assert(app.includes("supabase.rpc('manage_catalog_record_delete'") && app.includes("supabase.rpc('void_posted_document'"), 'ربط إجراءات الحذف والإلغاء بواجهات Supabase RPC');
  assert(app.includes('data-action=\"delete-catalog-record\"') && app.includes('data-action=\"void-document\"'), 'إظهار أزرار حذف الأصناف والعملاء وإلغاء الفواتير');
  assert(app.includes("x.status === 'void' ? 'ملغاة' : 'مرحّلة'"), 'إظهار حالة الفاتورة الملغاة في سجل الفواتير');
  assert(app.includes("window.addEventListener('online'") && app.includes("window.addEventListener('offline'"), 'مراقبة الاتصال وتشغيل المزامنة التلقائية');
  assert(existsSync(join(root, 'README_OFFLINE_FIRST_AR.md')), 'توفير دليل عربي لتشغيل وضع عدم الاتصال');
  assert(app.includes('async function renderInvoicePng(data)') && app.includes('image/png'), 'توليد صورة PNG فعلية للفاتورة');
  assert(app.includes('navigator.canShare({ files: [file] })') && app.includes('navigator.share({ files: [file]'), 'مشاركة ملف صورة الفاتورة عبر واجهة المشاركة الأصلية للهاتف');
  assert(app.includes('a.download = file.name') && app.includes('افتح واتساب وأرفق الصورة'), 'تنزيل صورة الفاتورة كبديل عند عدم دعم مشاركة الملفات');
  assert(app.includes('إرسال صورة الفاتورة عبر واتساب') && !app.includes('https://wa.me/${digits}?text=${encodeURIComponent(invoiceShareText(data))}'), 'استبدال إرسال نص الفاتورة بمسار مشاركة الصورة');

  for (const file of ['app.js', 'offline-store.js', 'sw.js', 'scripts/validate-project.mjs', 'tests/offline-store.test.mjs']) {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
    pass(`فحص JavaScript syntax: ${file}`);
  }

  console.log(`\nنجح ${checks.length} فحصاً محلياً:`);
  for (const item of checks) console.log(`✓ ${item.label}`);
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}

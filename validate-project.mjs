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
  assert(sw.includes('shaibani-shell-v9-mobile-items-layout'), 'تحديث ذاكرة PWA لإجبار تحميل تصميم الجوال الجديد');

  for (const file of ['app.js', 'sw.js', 'scripts/validate-project.mjs']) {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' });
    pass(`فحص JavaScript syntax: ${file}`);
  }

  console.log(`\nنجح ${checks.length} فحصاً محلياً:`);
  for (const item of checks) console.log(`✓ ${item.label}`);
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}

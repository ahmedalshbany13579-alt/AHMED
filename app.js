import {
  initOfflineStore, normalizeProductKey, findDuplicateProduct, stockSyncDecision,
  getCachedProducts, cacheProducts, getSnapshot, setSnapshot,
  cacheProfile, getCachedProfile, saveOfflineProduct,
  getOutbox, getOutboxCount, updateOutboxItem, removeOutboxItem,
  resolveProductId, markProductSynced, updateCachedProduct, queueOfflineStockTarget
} from './offline-store.js';

async function createSupabaseLiveClient(url, key, options) {
  let mod;
  try {
    mod = await withTimeout(
      import('https://esm.sh/@supabase/supabase-js@2.118.0'),
      12000,
      'انتهت مهلة تحميل مكتبة الاتصال. تحقق من الإنترنت أو أعد المحاولة.'
    );
  } catch (firstError) {
    try {
      mod = await withTimeout(
        import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm'),
        10000,
        'تعذر تحميل مكتبة Supabase من المصدرين.'
      );
    } catch (_secondError) {
      throw new Error('تعذر تحميل مكتبة الاتصال بقاعدة البيانات. قد يكون اتصال الإنترنت أو حجب مكتبات CDN هو السبب.');
    }
  }
  if (!mod?.createClient) throw new Error('تم تحميل مكتبة Supabase لكن دالة إنشاء الاتصال غير متاحة.');
  return mod.createClient(url, key, options);
}

const cfg = window.SHAIBANI_CONFIG || {};
const supabaseApiKey = cfg.SUPABASE_PUBLISHABLE_KEY || cfg.SUPABASE_ANON_KEY || '';
const configured = /^https:\/\/.+\.supabase\.co$/.test(cfg.SUPABASE_URL || '') &&
  supabaseApiKey && !String(supabaseApiKey).includes('YOUR_');
const LOGO_SRC = window.SHAIBANI_LOGO_DATA_URI || '/icons/shaibani-logo.jpg';
const BANNER_SRC = window.SHAIBANI_BANNER_DATA_URI || '/icons/shaibani-banner.svg';

const app = document.getElementById('app');
function markAppReady() {
  window.__SHAIBANI_APP_READY__ = true;
  if (window.__SHAIBANI_BOOT_WATCHDOG__) clearTimeout(window.__SHAIBANI_BOOT_WATCHDOG__);
}
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => clearTimeout(timer));
}
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (v, decimals = 2) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
const currencyName = c => ({ YER: 'ريال يمني', SAR: 'ريال سعودي', USD: 'دولار أمريكي' }[c] || c || '');
const pageNames = {
  dashboard: 'لوحة التحكم التنفيذية',
  pos: 'نقطة البيع التفاعلية (POS)',
  sales: 'فواتير المبيعات والمرتجعات',
  purchases: 'فواتير المشتريات والمرتجعات',
  items: 'الأصناف والمخزون والجرد',
  customers: 'العملاء وكشوف الحسابات',
  suppliers: 'الموردون وكشوف الحسابات',
  expenses: 'المصروفات التشغيلية',
  cash: 'الصناديق والسندات والتحويلات',
  journal: 'القيود اليومية ودليل الحسابات',
  reports: 'التقارير المالية والميزانية',
  users: 'الموظفون والصلاحيات',
  settings: 'الإعدادات وأسعار الصرف'
};

let supabase = null;
let session = null;
let profile = null;
let isDemoMode = false;
let currentPage = 'dashboard';
let currentReportTab = 'trial_balance';
let realtimeChannel = null;
let cachedProducts = [];
let cachedParties = [];
let cachedCash = [];
let installPrompt = null;
let offlineSessionActive = false;
let offlineSyncInProgress = false;
let offlineStoreReady = initOfflineStore().catch(err => { console.warn('Offline storage unavailable:', err); return null; });
// Reuse one in-flight loader so multiple import actions never inject duplicate scripts.
let xlsxLibraryPromise = null;

// POS State
let posCart = [];
let posCategory = 'all';
let posSearch = '';
let posCustomerName = '';
let posCustomerPhone = '';
let posPartyId = '';
let posSettlement = 'cash';
let posCurrency = 'YER';
let posDiscount = 0;
let posTax = 0;


function isPersistentOfflineSession() {
  return !isDemoMode && (offlineSessionActive || !navigator.onLine || !supabase);
}

function updateConnectionBadge(message = '') {
  const el = $('#connection-status');
  if (!el) return;
  if (isDemoMode) { el.textContent = '● محاكاة محلية'; return; }
  const pending = Number(el.dataset.pending || 0);
  if (offlineSessionActive || !navigator.onLine || !supabase) {
    el.textContent = `● دون اتصال${pending ? ` · ${pending} معلّق` : ''}`;
    el.classList.add('offline-status');
  } else {
    el.textContent = message || (pending ? `● متصل · ${pending} بانتظار المزامنة` : '● متصل ومتزامن');
    el.classList.remove('offline-status');
  }
}

async function refreshOfflineBadge() {
  try {
    const count = await getOutboxCount();
    const el = $('#connection-status');
    if (el) el.dataset.pending = String(count);
  } catch (_e) { /* IndexedDB may be unavailable in private browsing */ }
  updateConnectionBadge();
}

async function loadInventorySummary() {
  if (!isPersistentOfflineSession()) {
    try {
      const rows = await queryOrThrow(supabase.from('v_inventory_summary').select('id,quantity,inventory_value_base'));
      // لا تستبدل تعديلاً محلياً معلقاً برصيد الخادم القديم عند فشل جزئي في المزامنة.
      const pendingStock = (await getOutbox()).filter(item => item.type === 'stock_target');
      const cached = await getCachedProducts();
      for (const item of pendingStock) {
        const remoteId = await resolveProductId(item.local_product_id);
        let row = rows.find(entry => String(entry.id) === String(remoteId))
          || rows.find(entry => String(entry.id) === String(item.local_product_id));
        if (!row) {
          const product = cached.find(entry => String(entry.id) === String(item.local_product_id));
          row = {
            id: remoteId,
            quantity: 0,
            inventory_value_base: Number(item.target_qty) * Number(product?.avg_cost_base || 0)
          };
          rows.push(row);
        }
        row.quantity = Number(item.target_qty);
      }
      await setSnapshot('inventory-summary', rows);
      return rows;
    } catch (err) {
      console.warn('تعذر تحديث أرصدة المخزون؛ سيتم استخدام النسخة المحلية إن وجدت.', err);
    }
  }
  return (await getSnapshot('inventory-summary')) || [];
}

function getValidStoredAuthSession(profileId) {
  try {
    const projectRef = new URL(cfg.SUPABASE_URL).hostname.split('.')[0];
    const raw = localStorage.getItem(`sb-${projectRef}-auth-token`);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    const token = stored?.access_token;
    const userId = stored?.user?.id;
    if (!token || userId !== profileId) return null;
    const encoded = token.split('.')[1];
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const paddedBase64 = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const payload = JSON.parse(atob(paddedBase64));
    if (!payload.exp || Number(payload.exp) * 1000 <= Date.now() + 30000) return null;
    return stored;
  } catch (_e) { return null; }
}

async function startCachedOfflineSession(silent = false) {
  await offlineStoreReady;
  const cached = await getCachedProfile();
  if (!cached?.id || !cached.is_active) {
    if (!silent) toast('لا توجد جلسة موثقة سابقة محفوظة على هذا الجهاز.', true);
    return false;
  }
  const storedSession = getValidStoredAuthSession(cached.id);
  if (!storedSession) {
    if (!silent) toast('لا توجد جلسة دخول محلية صالحة. اتصل بالإنترنت وسجّل الدخول أولاً.', true);
    return false;
  }
  isDemoMode = false;
  offlineSessionActive = true;
  supabase = null;
  session = { user: storedSession.user, access_token: storedSession.access_token };
  profile = { id: cached.id, full_name: cached.full_name, role: cached.role, is_active: true };
  cachedProducts = await getCachedProducts();
  currentPage = 'items';
  buildShell();
  await renderPage();
  await refreshOfflineBadge();
  return true;
}

async function ensureLiveSupabaseClient() {
  if (supabase) return supabase;
  if (!navigator.onLine || !configured || isDemoMode) return null;
  supabase = await createSupabaseLiveClient(cfg.SUPABASE_URL, supabaseApiKey, {
    db: { schema: cfg.SUPABASE_SCHEMA || 'shaibani_erp' },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const { data: { session: restored } } = await supabase.auth.getSession();
  if (restored) session = restored;
  return supabase;
}

async function syncOfflineQueue(showMessage = true) {
  if (offlineSyncInProgress) return;
  if (isDemoMode) { if (showMessage) toast('بيانات وضع المحاكاة محلية ولا تُرفع إلى قاعدة Supabase.'); return; }
  if (!navigator.onLine) { if (showMessage) toast('لا يوجد اتصال بالإنترنت؛ ستبقى العمليات محفوظة محلياً.', true); return; }
  offlineSyncInProgress = true;
  try {
    await ensureLiveSupabaseClient();
    if (!supabase?.rpc) throw new Error('تعذر استعادة اتصال Supabase. أعد تسجيل الدخول عند الحاجة.');
    // احفظ تعريفات الأصناف أولاً دائماً، ثم رحّل أرصدتها حتى عند تعديل الصفوف مرات متعددة دون اتصال.
    const priority = item => item.type === 'save_product' ? 0 : 1;
    const queue = (await getOutbox()).sort((a, b) => priority(a) - priority(b) || String(a.created_at).localeCompare(String(b.created_at)));
    let synced = 0, failed = 0;
    const failedReasons = [];
    for (const item of queue) {
      try {
        if (item.type === 'save_product') {
          const result = await supabase.rpc('save_product', { p_payload: item.payload });
          if (result.error || !result.data) throw new Error(result.error?.message || 'لم يُرجع الخادم معرّف الصنف');
          await markProductSynced(item.local_product_id, result.data);
          await removeOutboxItem(item.id);
          synced++;
        } else if (item.type === 'stock_target') {
          const remoteId = await resolveProductId(item.local_product_id);
          if (String(remoteId).startsWith('local-')) throw new Error('ينتظر هذا الرصيد مزامنة بيانات الصنف أولاً');
          const inventory = await supabase.from('v_inventory_summary').select('quantity').eq('id', remoteId).maybeSingle();
          if (inventory.error) throw inventory.error;
          const currentQty = Number(inventory.data?.quantity || 0);
          const targetQty = Number(item.target_qty);
          const baselineQty = Number(item.current_qty_at_entry || 0);
          // إذا انقطعت الاستجابة بعد نجاح الترحيل، لا نكرر الحركة ما دام الخادم وصل للهدف.
          const stockDecision = stockSyncDecision(currentQty, baselineQty, targetQty);
          if (stockDecision === 'already_applied') {
            await removeOutboxItem(item.id);
            synced++;
            continue;
          }
          // لا تكتب فوق حركة أجراها مستخدم آخر أثناء بقاء هذا الجهاز دون اتصال.
          if (stockDecision === 'conflict') {
            const conflictMessage = `تغيّر رصيد الصنف أثناء انقطاع هذا الجهاز.\n\nالرصيد المحفوظ عند بدء التعديل: ${baselineQty}\nالرصيد الحالي على الخادم: ${currentQty}\nالكمية المحلية المطلوب اعتمادها: ${targetQty}\n\nهل تريد اعتماد الكمية المحلية كجرد نهائي؟ سيُنشئ النظام حركة تسوية على الرصيد الحالي في الخادم.`;
            const approved = showMessage && window.confirm(conflictMessage);
            if (!approved) {
              throw new Error(`تعارض رصيد الصنف: الخادم ${currentQty}، والكمية المحلية ${targetQty}. لم يتم الكتابة فوق رصيد الخادم؛ راجع العملية ثم أعد المزامنة.`);
            }
          }
          const stockResult = await applyProductStockTarget(remoteId, currentQty, targetQty, Number(item.unit_cost_base || 1), item.notes || 'تحديث رصيد محفوظ دون اتصال');
          if (!stockResult.ok) throw new Error(stockResult.error || 'تعذر ترحيل حركة المخزون');
          await removeOutboxItem(item.id);
          synced++;
        }
      } catch (err) {
        failed++;
        failedReasons.push(err.message || String(err));
        await updateOutboxItem({ ...item, status: 'failed', attempts: Number(item.attempts || 0) + 1, last_error: err.message || String(err), last_attempt_at: new Date().toISOString() });
      }
    }
    offlineSessionActive = false;
    cachedProducts = [];
    if (supabase) {
      try { await loadProducts(); await loadInventorySummary(); } catch (_e) { /* Keep local copy until next sync */ }
    }
    await refreshOfflineBadge();
    if (currentPage === 'items') await renderPage();
    if (showMessage) {
      const firstFailure = failedReasons[0] ? `
السبب الأول: ${failedReasons[0]}` : '';
      toast(`انتهت المزامنة: تم إرسال ${synced} عملية، وتعذّر ${failed}.${firstFailure}`, failed > 0);
    }
  } catch (err) {
    if (showMessage) toast('تعذرت المزامنة: ' + (err.message || err), true);
  } finally {
    offlineSyncInProgress = false;
    await refreshOfflineBadge();
  }
}

// Invoice Modal State
let activeSaleProducts = [];
let activeSaleInventory = new Map();
let activeInvoiceForActions = null;
let activeSaleLines = [];
let activeSaleCurrency = 'YER';
let activeInvoiceDocType = 'sale';
let saleLineSequence = 0;

// Packaging presets & draft units for auto-creating new products from Purchase/Sales Invoice
const PACKAGING_PRESETS = [
  { id: 'kilo_base', label: 'كيلو (وحدة أساسية = 1 كيلو)', pack_unit: 'كيلو', base_unit: 'كيلو', factor: 1, sub_units: [{ unit_name: 'نصف كيلو', factor_to_base: 0.5 }, { unit_name: 'ربع كيلو', factor_to_base: 0.25 }] },
  { id: 'ctn_12_box', label: 'كرتون يحتوي على 12 علبة', pack_unit: 'كرتون (12 علبة)', base_unit: 'علبة', factor: 12, sub_units: [] },
  { id: 'ctn_12_kg', label: 'كرتون يحتوي على 12 كيلو', pack_unit: 'كرتون (12 كيلو)', base_unit: 'كيلو', factor: 12, sub_units: [{ unit_name: 'نصف كيلو', factor_to_base: 0.5 }, { unit_name: 'ربع كيلو', factor_to_base: 0.25 }] },
  { id: 'ctn_12_pkt', label: 'كرتون يحتوي على 12 باكت', pack_unit: 'كرتون (12 باكت)', base_unit: 'باكت', factor: 12, sub_units: [] },
  { id: 'dzn_12_pcs', label: 'درزن يحتوي على 12 حبة', pack_unit: 'درزن (12 حبة)', base_unit: 'حبة', factor: 12, sub_units: [] },
  { id: 'qatma_25_kg', label: 'قطمة تحتوي على 25 كيلو', pack_unit: 'قطمة (25 كيلو)', base_unit: 'كيلو', factor: 25, sub_units: [{ unit_name: 'نصف كيلو', factor_to_base: 0.5 }, { unit_name: 'ربع كيلو', factor_to_base: 0.25 }] },
  { id: 'qatma_10_kg', label: 'قطمة تحتوي على 10 كيلو', pack_unit: 'قطمة (10 كيلو)', base_unit: 'كيلو', factor: 10, sub_units: [{ unit_name: 'نصف كيلو', factor_to_base: 0.5 }, { unit_name: 'ربع كيلو', factor_to_base: 0.25 }] },
  { id: 'bag_50_kg', label: 'كيس يحتوي على 50 كيلو', pack_unit: 'كيس (50 كيلو)', base_unit: 'كيلو', factor: 50, sub_units: [{ unit_name: 'قطمة (25 كيلو)', factor_to_base: 25 }, { unit_name: 'نصف كيلو', factor_to_base: 0.5 }, { unit_name: 'ربع كيلو', factor_to_base: 0.25 }] },
  { id: 'box_base', label: 'علبة (وحدة أساسية = 1 علبة)', pack_unit: 'علبة', base_unit: 'علبة', factor: 1, sub_units: [] },
  { id: 'pkt_base', label: 'باكت (وحدة أساسية = 1 باكت)', pack_unit: 'باكت', base_unit: 'باكت', factor: 1, sub_units: [] },
  { id: 'pcs_base', label: 'حبة (وحدة أساسية = 1 حبة)', pack_unit: 'حبة', base_unit: 'حبة', factor: 1, sub_units: [] },
  { id: 'oqia_base', label: 'أوقية (وحدة أساسية = 1 أوقية)', pack_unit: 'أوقية', base_unit: 'أوقية', factor: 1, sub_units: [] }
];

let draftNewProductConfig = {
  base_unit: 'كيلو',
  category: 'عام',
  selected_unit_name: 'كيلو',
  units: [
    { unit_name: 'كيلو', factor_to_base: 1, is_base: true },
    { unit_name: 'نصف كيلو', factor_to_base: 0.5, is_base: false },
    { unit_name: 'ربع كيلو', factor_to_base: 0.25, is_base: false }
  ]
};

function applyPresetToDraftNewProduct(presetId) {
  const preset = PACKAGING_PRESETS.find(p => p.id === presetId) || PACKAGING_PRESETS[0];
  draftNewProductConfig.base_unit = preset.base_unit;
  const units = [{ unit_name: preset.base_unit, factor_to_base: 1, is_base: true }];
  if (preset.pack_unit !== preset.base_unit && preset.factor > 0) {
    units.push({ unit_name: preset.pack_unit, factor_to_base: Number(preset.factor), is_base: false });
  }
  for (const su of (preset.sub_units || [])) {
    if (!units.some(u => u.unit_name === su.unit_name)) {
      units.push({ unit_name: su.unit_name, factor_to_base: Number(su.factor_to_base), is_base: false });
    }
  }
  draftNewProductConfig.units = units;
  draftNewProductConfig.selected_unit_name = preset.pack_unit;
}

/* ============================================================================
   INTERACTIVE DEMO / ACCOUNTING SIMULATION ENGINE
   ============================================================================ */
function createInitialDemoState() {
  return {
    settings: [{
      id: 1,
      store_name: 'محلات الشيباني للبهارات والأعشاب الطبيعية',
      base_currency: 'YER',
      tax_rate: 0,
      updated_at: '2026-10-31T08:00:00Z'
    }],
    currencies: [
      { code: 'YER', name: 'ريال يمني', symbol: 'ر.ي', decimal_places: 0, active: true },
      { code: 'SAR', name: 'ريال سعودي', symbol: 'ر.س', decimal_places: 2, active: true },
      { code: 'USD', name: 'دولار أمريكي', symbol: '$', decimal_places: 2, active: true }
    ],
    exchange_rates: [
      { id: 1, from_currency: 'SAR', to_currency: 'YER', rate: 538, effective_date: '2026-10-01' },
      { id: 2, from_currency: 'USD', to_currency: 'YER', rate: 2045, effective_date: '2026-10-01' }
    ],
    warehouses: [
      { id: 'wh-main', name: 'المستودع الرئيسي - الشيخ عثمان', is_default: true, active: true }
    ],
    profiles: [
      { id: 'u-manager', full_name: 'أنس الشيباني (المدير العام)', role: 'manager', is_active: true, created_at: '2026-09-01T08:00:00Z' },
      { id: 'u-accountant', full_name: 'خالد المقطري (رئيس الحسابات)', role: 'accountant', is_active: true, created_at: '2026-09-05T08:00:00Z' },
      { id: 'u-cashier', full_name: 'ماجد العدني (كاشير نقطة البيع)', role: 'cashier', is_active: true, created_at: '2026-09-10T08:00:00Z' }
    ],
    accounts: [
      { id: 'acc-1010', code: '1010', name: 'الصندوق - ريال يمني', account_type: 'asset', normal_side: 'debit', parent_id: null, is_system: true, active: true },
      { id: 'acc-1020', code: '1020', name: 'الصندوق - ريال سعودي', account_type: 'asset', normal_side: 'debit', parent_id: null, is_system: true, active: true },
      { id: 'acc-1030', code: '1030', name: 'الصندوق - دولار أمريكي', account_type: 'asset', normal_side: 'debit', parent_id: null, is_system: true, active: true },
      { id: 'acc-1100', code: '1100', name: 'العملاء / الذمم المدينة', account_type: 'asset', normal_side: 'debit', parent_id: null, is_system: true, active: true },
      { id: 'acc-1200', code: '1200', name: 'المخزون السلعي', account_type: 'asset', normal_side: 'debit', parent_id: null, is_system: true, active: true },
      { id: 'acc-2000', code: '2000', name: 'الموردون / الذمم الدائنة', account_type: 'liability', normal_side: 'credit', parent_id: null, is_system: true, active: true },
      { id: 'acc-2100', code: '2100', name: 'ضريبة القيمة المضافة المستحقة', account_type: 'liability', normal_side: 'credit', parent_id: null, is_system: true, active: true },
      { id: 'acc-3000', code: '3000', name: 'رأس المال والأرصدة الافتتاحية', account_type: 'equity', normal_side: 'credit', parent_id: null, is_system: true, active: true },
      { id: 'acc-4000', code: '4000', name: 'إيرادات المبيعات', account_type: 'revenue', normal_side: 'credit', parent_id: null, is_system: true, active: true },
      { id: 'acc-4100', code: '4100', name: 'مردودات ومسموحات المبيعات', account_type: 'revenue', normal_side: 'debit', parent_id: null, is_system: true, active: true },
      { id: 'acc-5000', code: '5000', name: 'تكلفة البضاعة المباعة', account_type: 'expense', normal_side: 'debit', parent_id: null, is_system: true, active: true },
      { id: 'acc-5100', code: '5100', name: 'المصروفات التشغيلية والإدارية', account_type: 'expense', normal_side: 'debit', parent_id: null, is_system: true, active: true },
      { id: 'acc-5110', code: '5110', name: 'مصروف الإيجار والكهرباء', account_type: 'expense', normal_side: 'debit', parent_id: 'acc-5100', is_system: false, active: true },
      { id: 'acc-5200', code: '5200', name: 'فروقات وتسويات الجرد المخزني', account_type: 'expense', normal_side: 'debit', parent_id: null, is_system: true, active: true }
    ],
    cash_accounts: [
      { id: 'cash-yer', name: 'الصندوق الرئيسي - يمني', currency: 'YER', account_id: 'acc-1010', active: true },
      { id: 'cash-sar', name: 'الصندوق الرئيسي - سعودي', currency: 'SAR', account_id: 'acc-1020', active: true },
      { id: 'cash-usd', name: 'الصندوق الرئيسي - دولار', currency: 'USD', account_id: 'acc-1030', active: true }
    ],
    parties: [
      { id: 'pty-c1', party_type: 'customer', name: 'مطاعم وبروست الخليج - عدن', phone: '+967771234501', address: 'الشيخ عثمان - جولة القاهرة', opening_balance: 180000, opening_balance_side: 'receivable', opening_currency: 'YER', notes: 'عميل جملة منتظم', active: true },
      { id: 'pty-c2', party_type: 'customer', name: 'سوبر ماركت السعادة الحديثة', phone: '+967773998811', address: 'المنصورة - شارع التسعين', opening_balance: 0, opening_balance_side: 'none', opening_currency: 'YER', notes: 'سداد نقدي ونصف شهري', active: true },
      { id: 'pty-c3', party_type: 'customer', name: 'محلات البركة للعطارة', phone: '+967770445566', address: 'كريتر - سوق الطويل', opening_balance: 450, opening_balance_side: 'receivable', opening_currency: 'SAR', notes: 'تعامل بالريال السعودي واليمني', active: true },
      { id: 'pty-s1', party_type: 'supplier', name: 'شركة التوابل العالمية للاستيراد', phone: '+967777112233', address: 'الميناء - المعلا', opening_balance: 650000, opening_balance_side: 'payable', opening_currency: 'YER', notes: 'مورد رئيسي للهيل والكمون والقرفة', active: true },
      { id: 'pty-s2', party_type: 'supplier', name: 'مناحل وادي دوعن للعسل الملكي', phone: '+967775667788', address: 'حضرموت - دوعن', opening_balance: 0, opening_balance_side: 'none', opening_currency: 'YER', notes: 'مورد عسل السدر والمراعي', active: true }
    ],
    products: [
      { id: 'prd-1', sku: 'SH-1001', name: 'هيل هندي ملكي فاخر رقم 1', category: 'بهارات', base_unit: 'كيلو', avg_cost_base: 26000, reorder_level: 10, description: 'هيل أخضر حبة كبيرة قطفة أولى', active: true },
      { id: 'prd-2', sku: 'SH-1002', name: 'كمون بلدي حب نقي', category: 'بهارات', base_unit: 'كيلو', avg_cost_base: 7200, reorder_level: 25, description: 'كمون بلدي منظف ومغربل درجة أولى', active: true },
      { id: 'prd-3', sku: 'SH-1003', name: 'خلطة بهارات الشيباني الملكية', category: 'مكسرات وخلطات', base_unit: 'كيلو', avg_cost_base: 9500, reorder_level: 15, description: 'خلطة محلات الشيباني الخاصة للكبسة والمندي', active: true },
      { id: 'prd-4', sku: 'SH-1004', name: 'قرفة سيلاني أعواد فاخرة', category: 'بهارات', base_unit: 'كيلو', avg_cost_base: 8400, reorder_level: 12, description: 'قرفة سيلانية أصلية سريعة التحضير', active: true },
      { id: 'prd-5', sku: 'SH-1005', name: 'زعفران إيراني سوبر نقيل', category: 'أعشاب', base_unit: 'أوقية', avg_cost_base: 32000, reorder_level: 8, description: 'زعفران نقيل طبيعي 100% خالي من الشوائب', active: true },
      { id: 'prd-6', sku: 'SH-1006', name: 'عسل سدر دوعني ملكي أصلي', category: 'عسل وزيوت', base_unit: 'كيلو', avg_cost_base: 38000, reorder_level: 8, description: 'عسل سدر حضرمي دوعني مضمون ومفحوص', active: true },
      { id: 'prd-7', sku: 'SH-1007', name: 'زنجبيل مطحون طبيعي حار', category: 'أعشاب', base_unit: 'كيلو', avg_cost_base: 5600, reorder_level: 20, description: 'زنجبيل مطحون طازج في مطاحن الشيباني', active: true },
      { id: 'prd-8', sku: 'SH-1008', name: 'قرنفل زنجباري مسمار أول', category: 'بهارات', base_unit: 'كيلو', avg_cost_base: 14500, reorder_level: 10, description: 'قرنفل زنجباري غني بالزيوت العطرية', active: true }
    ],
    product_units: [
      { id: 'u-101', product_id: 'prd-1', unit_name: 'كيلو', factor_to_base: 1, purchase_price: 26000, sale_price: 32000, currency: 'YER', is_base: true, active: true },
      { id: 'u-102', product_id: 'prd-1', unit_name: 'نصف كيلو', factor_to_base: 0.5, purchase_price: 13000, sale_price: 16500, currency: 'YER', is_base: false, active: true },
      { id: 'u-103', product_id: 'prd-1', unit_name: 'ربع كيلو', factor_to_base: 0.25, purchase_price: 6500, sale_price: 8500, currency: 'YER', is_base: false, active: true },
      { id: 'u-104', product_id: 'prd-1', unit_name: 'أوقية (100 جرام)', factor_to_base: 0.1, purchase_price: 2600, sale_price: 3500, currency: 'YER', is_base: false, active: true },

      { id: 'u-201', product_id: 'prd-2', unit_name: 'كيلو', factor_to_base: 1, purchase_price: 7200, sale_price: 9500, currency: 'YER', is_base: true, active: true },
      { id: 'u-202', product_id: 'prd-2', unit_name: 'نصف كيلو', factor_to_base: 0.5, purchase_price: 3600, sale_price: 4900, currency: 'YER', is_base: false, active: true },
      { id: 'u-203', product_id: 'prd-2', unit_name: 'ربع كيلو', factor_to_base: 0.25, purchase_price: 1800, sale_price: 2500, currency: 'YER', is_base: false, active: true },

      { id: 'u-301', product_id: 'prd-3', unit_name: 'كيلو', factor_to_base: 1, purchase_price: 9500, sale_price: 13000, currency: 'YER', is_base: true, active: true },
      { id: 'u-302', product_id: 'prd-3', unit_name: 'نصف كيلو', factor_to_base: 0.5, purchase_price: 4750, sale_price: 6700, currency: 'YER', is_base: false, active: true },
      { id: 'u-303', product_id: 'prd-3', unit_name: 'عبوة 250 جرام', factor_to_base: 0.25, purchase_price: 2400, sale_price: 3500, currency: 'YER', is_base: false, active: true },

      { id: 'u-401', product_id: 'prd-4', unit_name: 'كيلو', factor_to_base: 1, purchase_price: 8400, sale_price: 11200, currency: 'YER', is_base: true, active: true },
      { id: 'u-402', product_id: 'prd-4', unit_name: 'نصف كيلو', factor_to_base: 0.5, purchase_price: 4200, sale_price: 5800, currency: 'YER', is_base: false, active: true },

      { id: 'u-501', product_id: 'prd-5', unit_name: 'أوقية', factor_to_base: 1, purchase_price: 32000, sale_price: 42000, currency: 'YER', is_base: true, active: true },
      { id: 'u-502', product_id: 'prd-5', unit_name: 'نصف أوقية', factor_to_base: 0.5, purchase_price: 16000, sale_price: 21500, currency: 'YER', is_base: false, active: true },
      { id: 'u-503', product_id: 'prd-5', unit_name: 'علبة 5 جرام', factor_to_base: 0.2, purchase_price: 6400, sale_price: 9000, currency: 'YER', is_base: false, active: true },

      { id: 'u-601', product_id: 'prd-6', unit_name: 'كيلو', factor_to_base: 1, purchase_price: 38000, sale_price: 48000, currency: 'YER', is_base: true, active: true },
      { id: 'u-602', product_id: 'prd-6', unit_name: 'نصف كيلو (قرص)', factor_to_base: 0.5, purchase_price: 19000, sale_price: 24500, currency: 'YER', is_base: false, active: true },
      { id: 'u-603', product_id: 'prd-6', unit_name: 'ربع كيلو', factor_to_base: 0.25, purchase_price: 9500, sale_price: 12500, currency: 'YER', is_base: false, active: true },

      { id: 'u-701', product_id: 'prd-7', unit_name: 'كيلو', factor_to_base: 1, purchase_price: 5600, sale_price: 7800, currency: 'YER', is_base: true, active: true },
      { id: 'u-702', product_id: 'prd-7', unit_name: 'نصف كيلو', factor_to_base: 0.5, purchase_price: 2800, sale_price: 4000, currency: 'YER', is_base: false, active: true },

      { id: 'u-801', product_id: 'prd-8', unit_name: 'كيلو', factor_to_base: 1, purchase_price: 14500, sale_price: 18500, currency: 'YER', is_base: true, active: true },
      { id: 'u-802', product_id: 'prd-8', unit_name: 'ربع كيلو', factor_to_base: 0.25, purchase_price: 3625, sale_price: 4800, currency: 'YER', is_base: false, active: true }
    ],
    stock_movements: [
      { id: 'sm-1', product_id: 'prd-1', warehouse_id: 'wh-main', document_id: null, movement_type: 'adjustment_in', quantity_in: 45, quantity_out: 0, unit_cost_base: 26000, created_at: '2026-10-01T08:00:00Z' },
      { id: 'sm-2', product_id: 'prd-2', warehouse_id: 'wh-main', document_id: null, movement_type: 'adjustment_in', quantity_in: 80, quantity_out: 0, unit_cost_base: 7200, created_at: '2026-10-01T08:00:00Z' },
      { id: 'sm-3', product_id: 'prd-3', warehouse_id: 'wh-main', document_id: null, movement_type: 'adjustment_in', quantity_in: 60, quantity_out: 0, unit_cost_base: 9500, created_at: '2026-10-01T08:00:00Z' },
      { id: 'sm-4', product_id: 'prd-4', warehouse_id: 'wh-main', document_id: null, movement_type: 'adjustment_in', quantity_in: 9, quantity_out: 0, unit_cost_base: 8400, created_at: '2026-10-01T08:00:00Z' },
      { id: 'sm-5', product_id: 'prd-5', warehouse_id: 'wh-main', document_id: null, movement_type: 'adjustment_in', quantity_in: 6, quantity_out: 0, unit_cost_base: 32000, created_at: '2026-10-01T08:00:00Z' },
      { id: 'sm-6', product_id: 'prd-6', warehouse_id: 'wh-main', document_id: null, movement_type: 'adjustment_in', quantity_in: 24, quantity_out: 0, unit_cost_base: 38000, created_at: '2026-10-01T08:00:00Z' },
      { id: 'sm-7', product_id: 'prd-7', warehouse_id: 'wh-main', document_id: null, movement_type: 'adjustment_in', quantity_in: 50, quantity_out: 0, unit_cost_base: 5600, created_at: '2026-10-01T08:00:00Z' },
      { id: 'sm-8', product_id: 'prd-8', warehouse_id: 'wh-main', document_id: null, movement_type: 'adjustment_in', quantity_in: 30, quantity_out: 0, unit_cost_base: 14500, created_at: '2026-10-01T08:00:00Z' },
      { id: 'sm-9', product_id: 'prd-1', warehouse_id: 'wh-main', document_id: 'doc-s1', movement_type: 'sale', quantity_in: 0, quantity_out: 3, unit_cost_base: 26000, created_at: '2026-10-28T10:30:00Z' },
      { id: 'sm-10', product_id: 'prd-3', warehouse_id: 'wh-main', document_id: 'doc-s1', movement_type: 'sale', quantity_in: 0, quantity_out: 5, unit_cost_base: 9500, created_at: '2026-10-28T10:30:00Z' },
      { id: 'sm-11', product_id: 'prd-6', warehouse_id: 'wh-main', document_id: 'doc-s2', movement_type: 'sale', quantity_in: 0, quantity_out: 2, unit_cost_base: 38000, created_at: '2026-10-29T14:20:00Z' },
      { id: 'sm-12', product_id: 'prd-2', warehouse_id: 'wh-main', document_id: 'doc-p1', movement_type: 'purchase', quantity_in: 20, quantity_out: 0, unit_cost_base: 7200, created_at: '2026-10-26T09:15:00Z' }
    ],
    documents: [
      { id: 'doc-p1', doc_no: 'PUR-20261026-0915-A101', doc_type: 'purchase', party_id: 'pty-s1', document_date: '2026-10-26', currency: 'YER', exchange_rate: 1, settlement_method: 'credit', cash_account_id: null, expense_account_id: null, subtotal: 144000, discount: 0, tax: 0, total: 144000, notes: 'توريد كمون بلدي حب نقي', status: 'posted', created_at: '2026-10-26T09:15:00Z' },
      { id: 'doc-s1', doc_no: 'SAL-20261028-1030-B204', doc_type: 'sale', party_id: 'pty-c1', document_date: '2026-10-28', currency: 'YER', exchange_rate: 1, settlement_method: 'cash', cash_account_id: 'cash-yer', expense_account_id: null, subtotal: 161000, discount: 1000, tax: 0, total: 160000, notes: 'اسم العميل: مطاعم وبروست الخليج - عدن\nهاتف العميل: +967771234501\nطلبية بهارات وهيل أسبوعية', status: 'posted', created_at: '2026-10-28T10:30:00Z' },
      { id: 'doc-s2', doc_no: 'SAL-20261029-1420-C309', doc_type: 'sale', party_id: 'pty-c2', document_date: '2026-10-29', currency: 'YER', exchange_rate: 1, settlement_method: 'credit', cash_account_id: null, expense_account_id: null, subtotal: 96000, discount: 0, tax: 0, total: 96000, notes: 'اسم العميل: سوبر ماركت السعادة الحديثة\nهاتف العميل: +967773998811\nعسل سدر دوعني ملكي', status: 'posted', created_at: '2026-10-29T14:20:00Z' },
      { id: 'doc-e1', doc_no: 'EXP-20261030-1100-E401', doc_type: 'expense', party_id: null, document_date: '2026-10-30', currency: 'YER', exchange_rate: 1, settlement_method: 'cash', cash_account_id: 'cash-yer', expense_account_id: 'acc-5110', subtotal: 35000, discount: 0, tax: 0, total: 35000, notes: 'سداد فاتورة الكهرباء والمولد الشهري للمحل', status: 'posted', created_at: '2026-10-30T11:00:00Z' },
      { id: 'doc-r1', doc_no: 'RCT-20261030-1600-R502', doc_type: 'receipt', party_id: 'pty-c1', document_date: '2026-10-30', currency: 'YER', exchange_rate: 1, settlement_method: 'cash', cash_account_id: 'cash-yer', expense_account_id: null, subtotal: 80000, discount: 0, tax: 0, total: 80000, notes: 'دفعة من الحساب الجاري لمطاعم الخليج', status: 'posted', created_at: '2026-10-30T16:00:00Z' },
      { id: 'doc-pay1', doc_no: 'PAY-20261031-0900-P603', doc_type: 'payment', party_id: 'pty-s1', document_date: '2026-10-31', currency: 'YER', exchange_rate: 1, settlement_method: 'cash', cash_account_id: 'cash-yer', expense_account_id: null, subtotal: 200000, discount: 0, tax: 0, total: 200000, notes: 'دفعة نقدية لشركة التوابل العالمية', status: 'posted', created_at: '2026-10-31T09:00:00Z' }
    ],
    document_lines: [
      { id: 'dl-1', document_id: 'doc-p1', product_id: 'prd-2', product_name: 'كمون بلدي حب نقي', unit_id: 'u-201', unit_name: 'كيلو', quantity: 20, factor_to_base: 1, quantity_base: 20, unit_price: 7200, line_total: 144000 },
      { id: 'dl-2', document_id: 'doc-s1', product_id: 'prd-1', product_name: 'هيل هندي ملكي فاخر رقم 1', unit_id: 'u-101', unit_name: 'كيلو', quantity: 3, factor_to_base: 1, quantity_base: 3, unit_price: 32000, line_total: 96000 },
      { id: 'dl-3', document_id: 'doc-s1', product_id: 'prd-3', product_name: 'خلطة بهارات الشيباني الملكية', unit_id: 'u-301', unit_name: 'كيلو', quantity: 5, factor_to_base: 1, quantity_base: 5, unit_price: 13000, line_total: 65000 },
      { id: 'dl-4', document_id: 'doc-s2', product_id: 'prd-6', product_name: 'عسل سدر دوعني ملكي أصلي', unit_id: 'u-601', unit_name: 'كيلو', quantity: 2, factor_to_base: 1, quantity_base: 2, unit_price: 48000, line_total: 96000 }
    ],
    document_line_private_costs: [
      { document_line_id: 'dl-2', purchase_unit_price: 26000, currency: 'YER' },
      { document_line_id: 'dl-3', purchase_unit_price: 9500, currency: 'YER' },
      { document_line_id: 'dl-4', purchase_unit_price: 38000, currency: 'YER' }
    ],
    journal_entries: [
      { id: 'je-open', entry_no: 'OPEN-INIT-20261001', entry_date: '2026-10-01', description: 'قيد الأرصدة الافتتاحية للصناديق والمخزون والأطراف', document_id: null, posted: true, created_at: '2026-10-01T08:00:00Z' },
      { id: 'je-p1', entry_no: 'JE-20261026-0915-A101', entry_date: '2026-10-26', description: 'قيد فاتورة مشتريات PUR-20261026-0915-A101', document_id: 'doc-p1', posted: true, created_at: '2026-10-26T09:15:00Z' },
      { id: 'je-s1', entry_no: 'JE-20261028-1030-B204', entry_date: '2026-10-28', description: 'قيد فاتورة مبيعات SAL-20261028-1030-B204', document_id: 'doc-s1', posted: true, created_at: '2026-10-28T10:30:00Z' },
      { id: 'je-s2', entry_no: 'JE-20261029-1420-C309', entry_date: '2026-10-29', description: 'قيد فاتورة مبيعات SAL-20261029-1420-C309', document_id: 'doc-s2', posted: true, created_at: '2026-10-29T14:20:00Z' },
      { id: 'je-e1', entry_no: 'JE-20261030-1100-E401', entry_date: '2026-10-30', description: 'قيد مصروف EXP-20261030-1100-E401', document_id: 'doc-e1', posted: true, created_at: '2026-10-30T11:00:00Z' },
      { id: 'je-r1', entry_no: 'JE-20261030-1600-R502', entry_date: '2026-10-30', description: 'سند قبض RCT-20261030-1600-R502', document_id: 'doc-r1', posted: true, created_at: '2026-10-30T16:00:00Z' },
      { id: 'je-pay1', entry_no: 'JE-20261031-0900-P603', entry_date: '2026-10-31', description: 'سند صرف PAY-20261031-0900-P603', document_id: 'doc-pay1', posted: true, created_at: '2026-10-31T09:00:00Z' }
    ],
    journal_lines: [
      // Opening balances (Balanced: Debit = 6,623,700, Credit = 6,623,700)
      { id: 'jl-1', entry_id: 'je-open', account_id: 'acc-1010', debit_base: 1500000, credit_base: 0, currency: 'YER', foreign_amount: 1500000, party_id: null, memo: 'رصيد افتتاحي الصندوق اليمني' },
      { id: 'jl-2', entry_id: 'je-open', account_id: 'acc-1020', debit_base: 538000, credit_base: 0, currency: 'SAR', foreign_amount: 1000, party_id: null, memo: 'رصيد افتتاحي الصندوق السعودي' },
      { id: 'jl-3', entry_id: 'je-open', account_id: 'acc-1030', debit_base: 409000, credit_base: 0, currency: 'USD', foreign_amount: 200, party_id: null, memo: 'رصيد افتتاحي صندوق الدولار' },
      { id: 'jl-4', entry_id: 'je-open', account_id: 'acc-1200', debit_base: 3754600, credit_base: 0, currency: 'YER', foreign_amount: 3754600, party_id: null, memo: 'قيمة المخزون الافتتاحي' },
      { id: 'jl-5', entry_id: 'je-open', account_id: 'acc-1100', debit_base: 180000, credit_base: 0, currency: 'YER', foreign_amount: 180000, party_id: 'pty-c1', memo: 'رصيد افتتاحي مطاعم الخليج' },
      { id: 'jl-6', entry_id: 'je-open', account_id: 'acc-1100', debit_base: 242100, credit_base: 0, currency: 'SAR', foreign_amount: 450, party_id: 'pty-c3', memo: 'رصيد افتتاحي محلات البركة' },
      { id: 'jl-7', entry_id: 'je-open', account_id: 'acc-2000', debit_base: 0, credit_base: 650000, currency: 'YER', foreign_amount: 650000, party_id: 'pty-s1', memo: 'رصيد افتتاحي شركة التوابل العالمية' },
      { id: 'jl-8', entry_id: 'je-open', account_id: 'acc-3000', debit_base: 0, credit_base: 5973700, currency: 'YER', foreign_amount: 5973700, party_id: null, memo: 'صافي رأس المال والأرصدة الافتتاحية' },

      // Purchase doc-p1 (144,000)
      { id: 'jl-9', entry_id: 'je-p1', account_id: 'acc-1200', debit_base: 144000, credit_base: 0, currency: 'YER', foreign_amount: 144000, party_id: 'pty-s1', memo: 'إضافة مشتريات للمخزون' },
      { id: 'jl-10', entry_id: 'je-p1', account_id: 'acc-2000', debit_base: 0, credit_base: 144000, currency: 'YER', foreign_amount: 144000, party_id: 'pty-s1', memo: 'مقابل المشتريات الآجلة' },

      // Sale doc-s1 (160,000 cash, COGS = 3*26000 + 5*9500 = 125,500)
      { id: 'jl-11', entry_id: 'je-s1', account_id: 'acc-1010', debit_base: 160000, credit_base: 0, currency: 'YER', foreign_amount: 160000, party_id: 'pty-c1', memo: 'إثبات قيمة البيع النقدي' },
      { id: 'jl-12', entry_id: 'je-s1', account_id: 'acc-4000', debit_base: 0, credit_base: 160000, currency: 'YER', foreign_amount: 160000, party_id: 'pty-c1', memo: 'إيراد المبيعات' },
      { id: 'jl-13', entry_id: 'je-s1', account_id: 'acc-5000', debit_base: 125500, credit_base: 0, currency: 'YER', foreign_amount: 0, party_id: null, memo: 'تكلفة البضاعة المباعة' },
      { id: 'jl-14', entry_id: 'je-s1', account_id: 'acc-1200', debit_base: 0, credit_base: 125500, currency: 'YER', foreign_amount: 0, party_id: null, memo: 'تخفيض المخزون' },

      // Sale doc-s2 (96,000 credit, COGS = 2*38000 = 76,000)
      { id: 'jl-15', entry_id: 'je-s2', account_id: 'acc-1100', debit_base: 96000, credit_base: 0, currency: 'YER', foreign_amount: 96000, party_id: 'pty-c2', memo: 'إثبات قيمة البيع الآجل' },
      { id: 'jl-16', entry_id: 'je-s2', account_id: 'acc-4000', debit_base: 0, credit_base: 96000, currency: 'YER', foreign_amount: 96000, party_id: 'pty-c2', memo: 'إيراد المبيعات' },
      { id: 'jl-17', entry_id: 'je-s2', account_id: 'acc-5000', debit_base: 76000, credit_base: 0, currency: 'YER', foreign_amount: 0, party_id: null, memo: 'تكلفة البضاعة المباعة' },
      { id: 'jl-18', entry_id: 'je-s2', account_id: 'acc-1200', debit_base: 0, credit_base: 76000, currency: 'YER', foreign_amount: 0, party_id: null, memo: 'تخفيض المخزون' },

      // Expense doc-e1 (35,000)
      { id: 'jl-19', entry_id: 'je-e1', account_id: 'acc-5110', debit_base: 35000, credit_base: 0, currency: 'YER', foreign_amount: 35000, party_id: null, memo: 'سداد فاتورة الكهرباء والمولد' },
      { id: 'jl-20', entry_id: 'je-e1', account_id: 'acc-1010', debit_base: 0, credit_base: 35000, currency: 'YER', foreign_amount: 35000, party_id: null, memo: 'صرف من الصندوق الرئيسي' },

      // Receipt doc-r1 (80,000)
      { id: 'jl-21', entry_id: 'je-r1', account_id: 'acc-1010', debit_base: 80000, credit_base: 0, currency: 'YER', foreign_amount: 80000, party_id: 'pty-c1', memo: 'قبض من مطاعم الخليج' },
      { id: 'jl-22', entry_id: 'je-r1', account_id: 'acc-1100', debit_base: 0, credit_base: 80000, currency: 'YER', foreign_amount: 80000, party_id: 'pty-c1', memo: 'تخفيض ذمم العملاء' },

      // Payment doc-pay1 (200,000)
      { id: 'jl-23', entry_id: 'je-pay1', account_id: 'acc-2000', debit_base: 200000, credit_base: 0, currency: 'YER', foreign_amount: 200000, party_id: 'pty-s1', memo: 'تخفيض ذمم الموردين' },
      { id: 'jl-24', entry_id: 'je-pay1', account_id: 'acc-1010', debit_base: 0, credit_base: 200000, currency: 'YER', foreign_amount: 200000, party_id: 'pty-s1', memo: 'صرف لشركة التوابل العالمية' }
    ]
  };
}

let demoDB = null;
function loadDemoDB() {
  if (demoDB) return demoDB;
  try {
    const raw = localStorage.getItem('shaibani_erp_demo_v2');
    if (raw) {
      demoDB = JSON.parse(raw);
      return demoDB;
    }
  } catch (_e) { /* sandbox fallback */ }
  demoDB = createInitialDemoState();
  return demoDB;
}
function saveDemoDB() {
  try {
    if (demoDB) localStorage.setItem('shaibani_erp_demo_v2', JSON.stringify(demoDB));
  } catch (_e) { /* ignore storage quota in sandbox */ }
}
function resetDemoDB() {
  demoDB = createInitialDemoState();
  saveDemoDB();
}

function createDemoSupabaseClient() {
  const db = loadDemoDB();
  const computeView = (name) => {
    const isFin = ['manager', 'accountant'].includes(profile?.role);
    if (name === 'v_products') {
      return db.products.filter(p => p.active !== false).map(p => ({
        ...p,
        avg_cost_base: isFin ? p.avg_cost_base : null
      }));
    }
    if (name === 'v_product_units') {
      return db.product_units.filter(u => u.active !== false).map(u => ({
        ...u,
        purchase_price: isFin ? u.purchase_price : null
      }));
    }
    if (name === 'v_inventory_summary') {
      return db.products.filter(p => p.active !== false).map(p => {
        const qty = db.stock_movements
          .filter(m => m.product_id === p.id)
          .reduce((s, m) => s + Number(m.quantity_in || 0) - Number(m.quantity_out || 0), 0);
        const cost = isFin ? Number(p.avg_cost_base || 0) : 0;
        return {
          id: p.id,
          sku: p.sku,
          name: p.name,
          base_unit: p.base_unit,
          avg_cost_base: cost,
          reorder_level: p.reorder_level,
          warehouse_id: 'wh-main',
          warehouse_name: 'المستودع الرئيسي',
          quantity: Number(qty.toFixed(4)),
          inventory_value_base: Number((qty * cost).toFixed(4))
        };
      });
    }
    if (name === 'v_cash_balances') {
      return db.cash_accounts.filter(c => c.active !== false).map(c => {
        const bal = db.journal_lines
          .filter(jl => jl.account_id === c.account_id && (jl.currency || c.currency) === c.currency)
          .reduce((s, jl) => s + (Number(jl.debit_base) > 0 ? Number(jl.foreign_amount || jl.debit_base) : -Number(jl.foreign_amount || jl.credit_base)), 0);
        return { ...c, foreign_balance: Number(bal.toFixed(4)) };
      });
    }
    if (name === 'v_trial_balance') {
      return db.accounts.map(a => {
        const lines = db.journal_lines.filter(jl => jl.account_id === a.id);
        const debit = lines.reduce((s, x) => s + Number(x.debit_base || 0), 0);
        const credit = lines.reduce((s, x) => s + Number(x.credit_base || 0), 0);
        return {
          id: a.id,
          code: a.code,
          name: a.name,
          account_type: a.account_type,
          normal_side: a.normal_side,
          debit: Number(debit.toFixed(4)),
          credit: Number(credit.toFixed(4)),
          net_balance: Number((debit - credit).toFixed(4))
        };
      });
    }
    if (name === 'v_profit_loss') {
      return db.accounts.filter(a => ['revenue', 'expense'].includes(a.account_type)).map(a => {
        const lines = db.journal_lines.filter(jl => jl.account_id === a.id);
        const net = lines.reduce((s, jl) => s + (a.account_type === 'revenue'
          ? Number(jl.credit_base || 0) - Number(jl.debit_base || 0)
          : Number(jl.debit_base || 0) - Number(jl.credit_base || 0)), 0);
        return { account_type: a.account_type, code: a.code, name: a.name, net_amount: Number(net.toFixed(4)) };
      });
    }
    if (name === 'v_party_balances') {
      return db.parties.filter(p => p.active !== false).map(p => {
        const lines = db.journal_lines.filter(jl => jl.party_id === p.id);
        const debit = lines.reduce((s, x) => s + Number(x.debit_base || 0), 0);
        const credit = lines.reduce((s, x) => s + Number(x.credit_base || 0), 0);
        return {
          ...p,
          total_debit_base: Number(debit.toFixed(4)),
          total_credit_base: Number(credit.toFixed(4)),
          net_balance_base: Number((debit - credit).toFixed(4))
        };
      });
    }
    return db[name] ? [...db[name]] : [];
  };

  const enrichRow = (tableName, row) => {
    const copy = { ...row };
    if (tableName === 'documents') {
      copy.parties = db.parties.find(p => p.id === copy.party_id) || null;
      copy.document_lines = db.document_lines.filter(dl => dl.document_id === copy.id).map(dl => {
        const priv = db.document_line_private_costs.find(c => c.document_line_id === dl.id);
        return { ...dl, private_cost: priv ? priv.purchase_unit_price : null };
      });
    }
    if (tableName === 'journal_entries') {
      copy.journal_lines = db.journal_lines.filter(jl => jl.entry_id === copy.id).map(jl => ({
        ...jl,
        accounts: db.accounts.find(a => a.id === jl.account_id) || null,
        parties: db.parties.find(p => p.id === jl.party_id) || null
      }));
    }
    if (tableName === 'stock_movements') {
      copy.products = db.products.find(p => p.id === copy.product_id) || null;
      copy.documents = db.documents.find(d => d.id === copy.document_id) || null;
    }
    if (tableName === 'journal_lines') {
      copy.accounts = db.accounts.find(a => a.id === copy.account_id) || null;
      copy.parties = db.parties.find(p => p.id === copy.party_id) || null;
      copy.journal_entries = db.journal_entries.find(je => je.id === copy.entry_id) || null;
    }
    return copy;
  };

  class QueryBuilder {
    constructor(tableName) {
      this.tableName = tableName;
      this.filters = [];
      this.orders = [];
      this.limitCount = null;
      this.isSingle = false;
      this.isMaybeSingle = false;
      this.isHeadCount = false;
      this.mutation = null;
    }
    select(_cols = '*', opts = {}) {
      if (opts && opts.count === 'exact' && opts.head) this.isHeadCount = true;
      return this;
    }
    eq(col, val) { this.filters.push(r => String(r[col]) === String(val)); return this; }
    in(col, vals) { this.filters.push(r => vals.map(String).includes(String(r[col]))); return this; }
    gte(col, val) { this.filters.push(r => String(r[col] ?? '') >= String(val)); return this; }
    lte(col, val) { this.filters.push(r => String(r[col] ?? '') <= String(val)); return this; }
    gt(col, val) { this.filters.push(r => Number(r[col] || 0) > Number(val)); return this; }
    order(col, { ascending = true } = {}) {
      this.orders.push((a, b) => {
        const va = a[col] ?? '', vb = b[col] ?? '';
        return ascending ? (va > vb ? 1 : va < vb ? -1 : 0) : (va < vb ? 1 : va > vb ? -1 : 0);
      });
      return this;
    }
    limit(n) { this.limitCount = n; return this; }
    single() { this.isSingle = true; return this; }
    maybeSingle() { this.isMaybeSingle = true; return this; }
    insert(payload) {
      this.mutation = () => {
        const items = Array.isArray(payload) ? payload : [payload];
        const inserted = items.map(item => {
          const rec = {
            id: item.id || ('id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)),
            active: item.active ?? true,
            created_at: new Date().toISOString(),
            ...item
          };
          db[this.tableName].push(rec);
          return rec;
        });
        saveDemoDB();
        return Array.isArray(payload) ? inserted : inserted[0];
      };
      return this;
    }
    update(payload) {
      this.mutation = () => {
        const rows = db[this.tableName].filter(r => this.filters.every(fn => fn(r)));
        rows.forEach(r => Object.assign(r, payload, { updated_at: new Date().toISOString() }));
        saveDemoDB();
        return rows[0] || null;
      };
      return this;
    }
    upsert(payload, _opts = {}) {
      this.mutation = () => {
        if (this.tableName === 'exchange_rates') {
          const idx = db.exchange_rates.findIndex(x =>
            x.from_currency === payload.from_currency &&
            x.to_currency === payload.to_currency &&
            x.effective_date === payload.effective_date
          );
          if (idx >= 0) db.exchange_rates[idx] = { ...db.exchange_rates[idx], ...payload };
          else db.exchange_rates.push({ id: db.exchange_rates.length + 1, ...payload });
        } else {
          db[this.tableName].push({ id: 'id-' + Date.now(), ...payload });
        }
        saveDemoDB();
        return payload;
      };
      return this;
    }
    async execute() {
      try {
        if (this.mutation) {
          const res = this.mutation();
          return { data: res, error: null };
        }
        let rows = computeView(this.tableName).map(r => enrichRow(this.tableName, r));
        rows = rows.filter(r => this.filters.every(fn => fn(r)));
        for (const cmp of this.orders) rows.sort(cmp);
        if (this.isHeadCount) return { data: null, count: rows.length, error: null };
        if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
        if (this.isSingle) {
          if (!rows.length) return { data: null, error: { message: 'السجل المطلوب غير موجود' } };
          return { data: rows[0], error: null };
        }
        if (this.isMaybeSingle) return { data: rows[0] || null, error: null };
        return { data: rows, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message || String(err) } };
      }
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }

  return {
    from: (tableName) => new QueryBuilder(tableName),
    channel: () => ({ on() { return this; }, subscribe(cb) { if (cb) cb('SUBSCRIBED'); return this; } }),
    removeChannel: async () => {},
    auth: {
      getSession: async () => ({ data: { session } }),
      signInWithPassword: async () => ({ data: {}, error: null }),
      signOut: async () => { isDemoMode = false; session = null; profile = null; },
      onAuthStateChange: () => {}
    },
    rpc: async (fnName, args = {}) => {
      try {
        if (fnName === 'add_product_unit_to_product') {
          const { p_product_id, p_unit_name, p_factor_to_base, p_purchase_price, p_sale_price, p_currency } = args;
          const existing = db.product_units.find(u => u.product_id === p_product_id && u.unit_name.toLowerCase() === String(p_unit_name).trim().toLowerCase());
          if (existing) {
            existing.factor_to_base = Number(p_factor_to_base || existing.factor_to_base || 1);
            existing.purchase_price = Number(p_purchase_price || 0);
            existing.sale_price = Number(p_sale_price || 0);
            existing.currency = p_currency || 'YER';
            existing.active = true;
            saveDemoDB();
            return { data: existing.id, error: null };
          }
          const newId = 'u-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
          db.product_units.push({
            id: newId, product_id: p_product_id, unit_name: String(p_unit_name).trim(),
            factor_to_base: Number(p_factor_to_base), purchase_price: Number(p_purchase_price || 0),
            sale_price: Number(p_sale_price || 0), currency: p_currency || 'YER', is_base: false, active: true
          });
          saveDemoDB();
          return { data: newId, error: null };
        }

        if (fnName === 'save_product') {
          const p = args.p_payload;
          let prodId = p.id;
          if (!prodId) {
            prodId = 'prd-' + Date.now();
            db.products.push({
              id: prodId, sku: p.sku || null, name: p.name, category: p.category || 'عام',
              base_unit: p.base_unit, avg_cost_base: Number(p.avg_cost_base || p.purchase_price || 0),
              reorder_level: Number(p.reorder_level || 0), description: p.description || '', active: true
            });
          } else {
            const idx = db.products.findIndex(x => x.id === prodId);
            if (idx < 0) return { data: null, error: { message: 'الصنف غير موجود' } };
            const hasMov = db.stock_movements.some(m => m.product_id === prodId);
            db.products[idx] = {
              ...db.products[idx],
              sku: p.sku || null,
              name: p.name,
              category: p.category || 'عام',
              base_unit: hasMov ? db.products[idx].base_unit : p.base_unit,
              avg_cost_base: hasMov ? db.products[idx].avg_cost_base : Number(p.avg_cost_base || 0),
              reorder_level: Number(p.reorder_level || 0),
              description: p.description || ''
            };
          }
          const baseUnitName = db.products.find(x => x.id === prodId).base_unit;
          let baseU = db.product_units.find(u => u.product_id === prodId && u.is_base);
          if (!baseU) {
            db.product_units.push({
              id: 'u-base-' + Date.now(), product_id: prodId, unit_name: baseUnitName,
              factor_to_base: 1, purchase_price: Number(p.purchase_price || 0),
              sale_price: Number(p.sale_price || 0), currency: p.currency || 'YER', is_base: true, active: true
            });
          } else {
            Object.assign(baseU, {
              unit_name: baseUnitName, factor_to_base: 1,
              purchase_price: Number(p.purchase_price || 0), sale_price: Number(p.sale_price || 0),
              currency: p.currency || 'YER', active: true
            });
          }
          const keepNames = new Set([baseUnitName]);
          for (const u of (p.units || [])) {
            const uName = String(u.unit_name || '').trim();
            const factor = Number(u.factor_to_base || 0);
            if (!uName || factor <= 0 || keepNames.has(uName)) continue;
            keepNames.add(uName);
            const ex = db.product_units.find(x => x.product_id === prodId && x.unit_name === uName && !x.is_base);
            const uBuy = u.purchase_price !== undefined && u.purchase_price !== '' ? Number(u.purchase_price) : Number((Number(p.purchase_price || 0) * factor).toFixed(4));
            const uSell = u.sale_price !== undefined && u.sale_price !== '' ? Number(u.sale_price) : Number((Number(p.sale_price || 0) * factor).toFixed(4));
            if (ex) {
              Object.assign(ex, { factor_to_base: factor, purchase_price: uBuy, sale_price: uSell, currency: p.currency || 'YER', active: true });
            } else {
              db.product_units.push({
                id: 'u-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
                product_id: prodId, unit_name: uName, factor_to_base: factor,
                purchase_price: uBuy, sale_price: uSell, currency: p.currency || 'YER', is_base: false, active: true
              });
            }
          }
          db.product_units.forEach(u => {
            if (u.product_id === prodId && !u.is_base && !keepNames.has(u.unit_name)) u.active = false;
          });
          saveDemoDB();
          return { data: prodId, error: null };
        }

        if (fnName === 'set_opening_stock') {
          const { p_product_id, p_quantity_base, p_unit_cost_base } = args;
          const prod = db.products.find(x => x.id === p_product_id);
          if (!prod) return { data: null, error: { message: 'الصنف غير موجود' } };
          if (db.stock_movements.some(m => m.product_id === p_product_id)) {
            return { data: null, error: { message: 'للصنف حركات مخزون سابقة؛ استخدم تسوية الجرد المخزني' } };
          }
          const qty = Number(p_quantity_base || 0), cost = Number(p_unit_cost_base || prod.avg_cost_base || 0);
          if (qty <= 0 || cost <= 0) return { data: null, error: { message: 'أدخل كمية وتكلفة افتتاحية أكبر من صفر' } };
          prod.avg_cost_base = cost;
          db.stock_movements.push({
            id: 'sm-' + Date.now(), product_id: p_product_id, warehouse_id: 'wh-main',
            document_id: null, movement_type: 'adjustment_in', quantity_in: qty, quantity_out: 0,
            unit_cost_base: cost, created_at: new Date().toISOString()
          });
          const val = Number((qty * cost).toFixed(4));
          const jeId = 'je-open-stk-' + Date.now();
          db.journal_entries.push({
            id: jeId, entry_no: 'OPEN-STOCK-' + Date.now().toString().slice(-6),
            entry_date: new Date().toISOString().slice(0, 10),
            description: 'رصيد مخزون افتتاحي: ' + prod.name, document_id: null, posted: true, created_at: new Date().toISOString()
          });
          db.journal_lines.push(
            { id: 'jl-a-' + Date.now(), entry_id: jeId, account_id: 'acc-1200', debit_base: val, credit_base: 0, currency: 'YER', foreign_amount: val, party_id: null, memo: 'قيمة المخزون الافتتاحي' },
            { id: 'jl-b-' + Date.now(), entry_id: jeId, account_id: 'acc-3000', debit_base: 0, credit_base: val, currency: 'YER', foreign_amount: val, party_id: null, memo: 'مقابل رصيد المخزون الافتتاحي' }
          );
          saveDemoDB();
          return { data: jeId, error: null };
        }

        if (fnName === 'set_opening_cash_balance') {
          const { p_cash_account_id, p_amount } = args;
          const cashAcc = db.cash_accounts.find(c => c.id === p_cash_account_id);
          const amt = Number(p_amount || 0);
          if (!cashAcc || amt <= 0) return { data: null, error: { message: 'تحقق من الصندوق والمبلغ' } };
          const fx = cashAcc.currency === 'YER' ? 1 : (db.exchange_rates.find(r => r.from_currency === cashAcc.currency)?.rate || 1);
          const baseVal = Number((amt * fx).toFixed(4));
          const jeId = 'je-open-cash-' + Date.now();
          db.journal_entries.push({
            id: jeId, entry_no: 'OPEN-CASH-' + Date.now().toString().slice(-6),
            entry_date: new Date().toISOString().slice(0, 10),
            description: 'رصيد افتتاحي للصندوق: ' + cashAcc.name, document_id: null, posted: true, created_at: new Date().toISOString()
          });
          db.journal_lines.push(
            { id: 'jl-c1-' + Date.now(), entry_id: jeId, account_id: cashAcc.account_id, debit_base: baseVal, credit_base: 0, currency: cashAcc.currency, foreign_amount: amt, party_id: null, memo: 'رصيد صندوق افتتاحي' },
            { id: 'jl-c2-' + Date.now(), entry_id: jeId, account_id: 'acc-3000', debit_base: 0, credit_base: baseVal, currency: cashAcc.currency, foreign_amount: amt, party_id: null, memo: 'مقابل رصيد افتتاحي' }
          );
          saveDemoDB();
          return { data: jeId, error: null };
        }

        if (fnName === 'set_opening_party_balance') {
          const { p_party_id, p_amount, p_currency } = args;
          const party = db.parties.find(p => p.id === p_party_id);
          const amt = Number(p_amount || 0);
          if (!party || amt <= 0) return { data: null, error: { message: 'تحقق من الطرف والمبلغ' } };
          const fx = p_currency === 'YER' ? 1 : (db.exchange_rates.find(r => r.from_currency === p_currency)?.rate || 1);
          const baseVal = Number((amt * fx).toFixed(4));
          const jeId = 'je-open-pty-' + Date.now();
          db.journal_entries.push({
            id: jeId, entry_no: 'OPEN-PARTY-' + Date.now().toString().slice(-6),
            entry_date: new Date().toISOString().slice(0, 10),
            description: 'قيد افتتاحي للطرف: ' + party.name, document_id: null, posted: true, created_at: new Date().toISOString()
          });
          if (party.opening_balance_side === 'receivable') {
            db.journal_lines.push(
              { id: 'jl-p1-' + Date.now(), entry_id: jeId, account_id: 'acc-1100', debit_base: baseVal, credit_base: 0, currency: p_currency, foreign_amount: amt, party_id: party.id, memo: 'رصيد عميل افتتاحي' },
              { id: 'jl-p2-' + Date.now(), entry_id: jeId, account_id: 'acc-3000', debit_base: 0, credit_base: baseVal, currency: p_currency, foreign_amount: amt, party_id: party.id, memo: 'مقابل أرصدة افتتاحية' }
            );
          } else {
            db.journal_lines.push(
              { id: 'jl-p1-' + Date.now(), entry_id: jeId, account_id: 'acc-3000', debit_base: baseVal, credit_base: 0, currency: p_currency, foreign_amount: amt, party_id: party.id, memo: 'مقابل أرصدة افتتاحية' },
              { id: 'jl-p2-' + Date.now(), entry_id: jeId, account_id: 'acc-2000', debit_base: 0, credit_base: baseVal, currency: p_currency, foreign_amount: amt, party_id: party.id, memo: 'رصيد مورد افتتاحي' }
            );
          }
          saveDemoDB();
          return { data: jeId, error: null };
        }

        if (fnName === 'post_stock_adjustment') {
          const p = args.p_payload;
          const prod = db.products.find(x => x.id === p.product_id);
          if (!prod) return { data: null, error: { message: 'الصنف غير موجود' } };
          const qty = Number(p.quantity_base || 0);
          const cost = Number(p.unit_cost_base || prod.avg_cost_base || 0);
          const dir = p.direction || 'in';
          if (qty <= 0 || cost <= 0) return { data: null, error: { message: 'أدخل كمية وتكلفة صحيحة أكبر من صفر' } };
          const currentStock = db.stock_movements.filter(m => m.product_id === prod.id).reduce((s, m) => s + Number(m.quantity_in || 0) - Number(m.quantity_out || 0), 0);
          if (dir === 'out' && currentStock < qty) {
            return { data: null, error: { message: `الرصيد المتاح (${currentStock}) أقل من كمية الخصم (${qty})` } };
          }
          db.stock_movements.push({
            id: 'sm-adj-' + Date.now(), product_id: prod.id, warehouse_id: 'wh-main', document_id: null,
            movement_type: dir === 'in' ? 'adjustment_in' : 'adjustment_out',
            quantity_in: dir === 'in' ? qty : 0, quantity_out: dir === 'out' ? qty : 0,
            unit_cost_base: cost, created_at: new Date().toISOString()
          });
          const val = Number((qty * cost).toFixed(4));
          const jeId = 'je-adj-' + Date.now();
          db.journal_entries.push({
            id: jeId, entry_no: 'ADJ-' + Date.now().toString().slice(-6),
            entry_date: new Date().toISOString().slice(0, 10),
            description: `${p.notes || 'تسوية جرد مخزني'} — ${prod.name}`, document_id: null, posted: true, created_at: new Date().toISOString()
          });
          if (dir === 'in') {
            db.journal_lines.push(
              { id: 'jl-adj1-' + Date.now(), entry_id: jeId, account_id: 'acc-1200', debit_base: val, credit_base: 0, currency: 'YER', foreign_amount: val, party_id: null, memo: 'زيادة جرد مخزني: ' + prod.name },
              { id: 'jl-adj2-' + Date.now(), entry_id: jeId, account_id: 'acc-5200', debit_base: 0, credit_base: val, currency: 'YER', foreign_amount: val, party_id: null, memo: 'مقابل فائض جرد مخزني' }
            );
          } else {
            db.journal_lines.push(
              { id: 'jl-adj1-' + Date.now(), entry_id: jeId, account_id: 'acc-5200', debit_base: val, credit_base: 0, currency: 'YER', foreign_amount: val, party_id: null, memo: 'عجز أو تالف جرد مخزني: ' + prod.name },
              { id: 'jl-adj2-' + Date.now(), entry_id: jeId, account_id: 'acc-1200', debit_base: 0, credit_base: val, currency: 'YER', foreign_amount: val, party_id: null, memo: 'تخفيض المخزون بالتسوية' }
            );
          }
          saveDemoDB();
          return { data: jeId, error: null };
        }

        if (fnName === 'post_cash_transfer') {
          const p = args.p_payload;
          const fromCash = db.cash_accounts.find(c => c.id === p.from_cash_id);
          const toCash = db.cash_accounts.find(c => c.id === p.to_cash_id);
          if (!fromCash || !toCash || fromCash.id === toCash.id) {
            return { data: null, error: { message: 'اختر صندوقين مختلفين للتحويل' } };
          }
          const fromAmt = Number(p.from_amount || 0), toAmt = Number(p.to_amount || 0), baseAmt = Number(p.base_amount || 0);
          if (fromAmt <= 0 || toAmt <= 0 || baseAmt <= 0) {
            return { data: null, error: { message: 'أدخل مبالغ صحيحة أكبر من صفر' } };
          }
          const jeId = 'je-trf-' + Date.now();
          db.journal_entries.push({
            id: jeId, entry_no: 'TRF-' + Date.now().toString().slice(-6),
            entry_date: new Date().toISOString().slice(0, 10),
            description: `${p.notes || 'تحويل بين الصناديق'} (${fromCash.name} ← ${toCash.name})`,
            document_id: null, posted: true, created_at: new Date().toISOString()
          });
          db.journal_lines.push(
            { id: 'jl-trf1-' + Date.now(), entry_id: jeId, account_id: toCash.account_id, debit_base: baseAmt, credit_base: 0, currency: toCash.currency, foreign_amount: toAmt, party_id: null, memo: 'إيداع تحويل من ' + fromCash.name },
            { id: 'jl-trf2-' + Date.now(), entry_id: jeId, account_id: fromCash.account_id, debit_base: 0, credit_base: baseAmt, currency: fromCash.currency, foreign_amount: fromAmt, party_id: null, memo: 'سحب تحويل إلى ' + toCash.name }
          );
          saveDemoDB();
          return { data: jeId, error: null };
        }

        if (fnName === 'post_manual_journal_entry') {
          const p = args.p_payload;
          const lines = p.lines || [];
          const totalD = lines.reduce((s, l) => s + Number(l.debit_base || 0), 0);
          const totalC = lines.reduce((s, l) => s + Number(l.credit_base || 0), 0);
          if (lines.length < 2 || Math.abs(totalD - totalC) > 0.01 || totalD <= 0) {
            return { data: null, error: { message: 'القيد اليومي يجب أن يحتوي على سطرين على الأقل وأن يكون متوازناً تماماً' } };
          }
          const jeId = 'je-mje-' + Date.now();
          db.journal_entries.push({
            id: jeId, entry_no: 'MJE-' + Date.now().toString().slice(-6),
            entry_date: p.entry_date || new Date().toISOString().slice(0, 10),
            description: p.description || 'قيد يومية يدوي', document_id: null, posted: true, created_at: new Date().toISOString()
          });
          lines.forEach((l, idx) => {
            const d = Number(l.debit_base || 0), c = Number(l.credit_base || 0);
            db.journal_lines.push({
              id: `jl-mje-${Date.now()}-${idx}`, entry_id: jeId, account_id: l.account_id,
              debit_base: d, credit_base: c, currency: 'YER', foreign_amount: Math.max(d, c),
              party_id: l.party_id || null, memo: l.memo || p.description
            });
          });
          saveDemoDB();
          return { data: jeId, error: null };
        }

        if (fnName === 'post_document') {
          const p = args.p_payload;
          const v_type = p.doc_type;
          const v_currency = p.currency || 'YER';
          const v_fx = Number(p.exchange_rate || 1);
          const v_method = p.settlement_method || 'cash';
          const v_party = p.party_id || null;
          const v_cash_id = v_method === 'credit' ? null : p.cash_account_id;
          const v_date = p.document_date || new Date().toISOString().slice(0, 10);

          if (profile?.role === 'cashier' && !['sale', 'sale_return'].includes(v_type)) {
            return { data: null, error: { message: 'صلاحية الكاشير تسمح بفواتير المبيعات ومرتجعاتها فقط' } };
          }
          if ((['purchase', 'purchase_return', 'receipt', 'payment'].includes(v_type) || (['sale', 'sale_return', 'expense'].includes(v_type) && v_method === 'credit')) && !v_party) {
            return { data: null, error: { message: 'اختر العميل أو المورد لهذا المستند' } };
          }
          let cashAcc = null;
          if (v_method === 'cash' || ['receipt', 'payment'].includes(v_type)) {
            cashAcc = db.cash_accounts.find(c => c.id === v_cash_id && c.currency === v_currency);
            if (!cashAcc) return { data: null, error: { message: 'الصندوق غير محدد أو عملته لا تطابق عملة المستند' } };
          }

          let subtotal = 0;
          const isLineDoc = ['sale', 'purchase', 'sale_return', 'purchase_return'].includes(v_type);
          if (isLineDoc) {
            if (!Array.isArray(p.lines) || !p.lines.length) return { data: null, error: { message: 'أضف بنداً واحداً على الأقل' } };
            for (const line of p.lines) {
              const prod = db.products.find(x => x.id === line.product_id);
              const unit = db.product_units.find(x => x.id === line.unit_id && x.product_id === line.product_id);
              if (!prod || !unit) return { data: null, error: { message: 'صنف أو وحدة غير صالحة' } };
              const qBase = Number(line.quantity) * Number(unit.factor_to_base);
              const avail = db.stock_movements.filter(m => m.product_id === prod.id).reduce((s, m) => s + Number(m.quantity_in || 0) - Number(m.quantity_out || 0), 0);
              if (['sale', 'purchase_return'].includes(v_type) && avail < qBase) {
                return { data: null, error: { message: `المخزون غير كافٍ للصنف: ${prod.name} (المتاح: ${avail} ${prod.base_unit})` } };
              }
              subtotal += Number((Number(line.quantity) * Number(line.unit_price)).toFixed(4));
            }
          } else {
            subtotal = Number(p.amount || 0);
          }

          const discount = Number(p.discount || 0), tax = Number(p.tax || 0);
          const total = Number((subtotal - discount + tax).toFixed(4));
          if (total <= 0) return { data: null, error: { message: 'إجمالي المستند يجب أن يكون أكبر من صفر' } };

          const prefix = { sale: 'SAL', purchase: 'PUR', sale_return: 'SRT', purchase_return: 'PRT', expense: 'EXP', receipt: 'RCT', payment: 'PAY' }[v_type] || 'DOC';
          const docId = 'doc-' + Date.now();
          const docNo = `${prefix}-${v_date.replace(/-/g, '')}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
          db.documents.unshift({
            id: docId, doc_no: docNo, doc_type: v_type, party_id: v_party, document_date: v_date,
            currency: v_currency, exchange_rate: v_fx, settlement_method: v_method,
            cash_account_id: v_cash_id, expense_account_id: p.expense_account_id || null,
            subtotal, discount, tax, total, notes: p.notes || '', status: 'posted', created_at: new Date().toISOString()
          });

          let totalCostBase = 0;
          if (isLineDoc) {
            for (const line of p.lines) {
              const prod = db.products.find(x => x.id === line.product_id);
              const unit = db.product_units.find(x => x.id === line.unit_id);
              const qty = Number(line.quantity), price = Number(line.unit_price);
              const factor = Number(unit.factor_to_base);
              const qBase = Number((qty * factor).toFixed(6));
              const lineTotal = Number((qty * price).toFixed(4));
              const dlId = 'dl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
              db.document_lines.push({
                id: dlId, document_id: docId, product_id: prod.id, product_name: prod.name,
                unit_id: unit.id, unit_name: unit.unit_name, quantity: qty,
                factor_to_base: factor, quantity_base: qBase, unit_price: price, line_total: lineTotal
              });
              if (v_type === 'sale' && line.purchase_unit_price !== undefined && line.purchase_unit_price !== '') {
                db.document_line_private_costs.push({
                  document_line_id: dlId, purchase_unit_price: Number(line.purchase_unit_price), currency: v_currency
                });
              }
              const oldQty = db.stock_movements.filter(m => m.product_id === prod.id).reduce((s, m) => s + Number(m.quantity_in || 0) - Number(m.quantity_out || 0), 0);
              const avgCost = Number(prod.avg_cost_base || 0);

              if (v_type === 'sale') {
                db.stock_movements.push({
                  id: 'sm-' + Date.now() + Math.random(), product_id: prod.id, warehouse_id: 'wh-main',
                  document_id: docId, movement_type: 'sale', quantity_in: 0, quantity_out: qBase,
                  unit_cost_base: avgCost, created_at: new Date().toISOString()
                });
                totalCostBase += qBase * avgCost;
              } else if (v_type === 'sale_return') {
                db.stock_movements.push({
                  id: 'sm-' + Date.now() + Math.random(), product_id: prod.id, warehouse_id: 'wh-main',
                  document_id: docId, movement_type: 'adjustment_in', quantity_in: qBase, quantity_out: 0,
                  unit_cost_base: avgCost, created_at: new Date().toISOString()
                });
                totalCostBase += qBase * avgCost;
              } else if (v_type === 'purchase') {
                const buyCostBase = Number((price * v_fx / factor).toFixed(6));
                db.stock_movements.push({
                  id: 'sm-' + Date.now() + Math.random(), product_id: prod.id, warehouse_id: 'wh-main',
                  document_id: docId, movement_type: 'purchase', quantity_in: qBase, quantity_out: 0,
                  unit_cost_base: buyCostBase, created_at: new Date().toISOString()
                });
                prod.avg_cost_base = (oldQty + qBase) > 0
                  ? Number((((oldQty * avgCost) + (qBase * buyCostBase)) / (oldQty + qBase)).toFixed(6))
                  : buyCostBase;
              } else if (v_type === 'purchase_return') {
                const buyCostBase = Number((price * v_fx / factor).toFixed(6));
                db.stock_movements.push({
                  id: 'sm-' + Date.now() + Math.random(), product_id: prod.id, warehouse_id: 'wh-main',
                  document_id: docId, movement_type: 'adjustment_out', quantity_in: 0, quantity_out: qBase,
                  unit_cost_base: buyCostBase, created_at: new Date().toISOString()
                });
              }
            }
          }

          const jeId = 'je-' + Date.now();
          const jeNo = 'JE-' + v_date.replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
          const descMap = {
            sale: 'قيد فاتورة مبيعات ' + docNo,
            purchase: 'قيد فاتورة مشتريات ' + docNo,
            sale_return: 'قيد مرتجع مبيعات ' + docNo,
            purchase_return: 'قيد مرتجع مشتريات ' + docNo,
            expense: 'قيد مصروف ' + docNo,
            receipt: 'سند قبض ' + docNo,
            payment: 'سند صرف ' + docNo
          };
          db.journal_entries.unshift({
            id: jeId, entry_no: jeNo, entry_date: v_date, description: descMap[v_type] || docNo,
            document_id: docId, posted: true, created_at: new Date().toISOString()
          });

          const baseTotal = Number((total * v_fx).toFixed(4));
          const revBase = Number(((subtotal - discount) * v_fx).toFixed(4));
          const taxBase = Number((tax * v_fx).toFixed(4));
          const addLine = (account_id, debit_base, credit_base, foreign_amount, memo) => {
            db.journal_lines.push({
              id: 'jl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
              entry_id: jeId, account_id, debit_base: Number(debit_base.toFixed(4)),
              credit_base: Number(credit_base.toFixed(4)), currency: v_currency,
              foreign_amount: Number(foreign_amount.toFixed(4)), party_id: v_party, memo
            });
          };

          if (v_type === 'sale') {
            addLine(v_method === 'cash' ? cashAcc.account_id : 'acc-1100', baseTotal, 0, total, 'إثبات قيمة البيع');
            if (revBase > 0) addLine('acc-4000', 0, revBase, subtotal - discount, 'إيراد المبيعات');
            if (taxBase > 0) addLine('acc-2100', 0, taxBase, tax, 'الضريبة المستحقة');
            if (totalCostBase > 0) {
              addLine('acc-5000', totalCostBase, 0, 0, 'تكلفة البضاعة المباعة');
              addLine('acc-1200', 0, totalCostBase, 0, 'تخفيض المخزون');
            }
          } else if (v_type === 'sale_return') {
            if (revBase > 0) addLine('acc-4100', revBase, 0, subtotal - discount, 'مردودات المبيعات');
            if (taxBase > 0) addLine('acc-2100', taxBase, 0, tax, 'عكس ضريبة المبيعات');
            addLine(v_method === 'cash' ? cashAcc.account_id : 'acc-1100', 0, baseTotal, total, 'رد قيمة المرتجع للعميل');
            if (totalCostBase > 0) {
              addLine('acc-1200', totalCostBase, 0, 0, 'إعادة المرتجع للمخزون');
              addLine('acc-5000', 0, totalCostBase, 0, 'عكس تكلفة البضاعة المباعة');
            }
          } else if (v_type === 'purchase') {
            addLine('acc-1200', baseTotal, 0, total, 'إضافة مشتريات للمخزون');
            addLine(v_method === 'cash' ? cashAcc.account_id : 'acc-2000', 0, baseTotal, total, 'مقابل المشتريات');
          } else if (v_type === 'purchase_return') {
            addLine(v_method === 'cash' ? cashAcc.account_id : 'acc-2000', baseTotal, 0, total, 'تخفيض ذمة المورد / استرداد نقدي');
            addLine('acc-1200', 0, baseTotal, total, 'مرتجع مشتريات من المخزون');
          } else if (v_type === 'expense') {
            const expAcc = p.expense_account_id || 'acc-5100';
            addLine(expAcc, baseTotal, 0, total, 'إثبات المصروف التشغيلي');
            addLine(v_method === 'cash' ? cashAcc.account_id : 'acc-2000', 0, baseTotal, total, 'سداد المصروف');
          } else if (v_type === 'receipt') {
            addLine(cashAcc.account_id, baseTotal, 0, total, 'قبض من عميل');
            addLine('acc-1100', 0, baseTotal, total, 'تخفيض ذمم العملاء');
          } else if (v_type === 'payment') {
            addLine('acc-2000', baseTotal, 0, total, 'تخفيض ذمم الموردين');
            addLine(cashAcc.account_id, 0, baseTotal, total, 'صرف لمورد');
          }
          saveDemoDB();
          return { data: docId, error: null };
        }

        return { data: null, error: { message: 'إجراء غير معروف: ' + fnName } };
      } catch (err) {
        return { data: null, error: { message: err.message || String(err) } };
      }
    }
  };
}

/* ============================================================================
   UI HELPERS & CORE NAVIGATION
   ============================================================================ */
function toast(message, bad = false) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    document.body.append(el);
  }
  el.textContent = message;
  el.style.background = bad ? 'var(--red)' : 'var(--g)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3200);
}

function showLoading(text = 'جاري تحميل البيانات المحاسبية…') {
  return `<div class="loading">${escapeHtml(text)}</div>`;
}

function btn(text, action, cls = '', extraAttrs = '') {
  return `<button class="btn ${cls}" type="button" data-action="${action}" ${extraAttrs}>${text}</button>`;
}

function table(headers, rows, tableId = '') {
  return `<div class="table-wrap"><table ${tableId ? `id="${tableId}"` : ''}><thead><tr>${headers.map(x => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td class="empty" colspan="${headers.length}">لا توجد سجلات مطابقة حالياً</td></tr>`}</tbody></table></div>`;
}

function field(label, name, value = '', type = 'text', opts = {}) {
  return `<div class="field ${opts.full ? 'full' : ''}"><label>${label}</label><input class="control" name="${name}" type="${type}" value="${escapeHtml(value)}" ${opts.required ? 'required' : ''} ${opts.step ? `step="${opts.step}"` : ''} ${opts.min !== undefined ? `min="${opts.min}"` : ''} ${opts.readonly ? 'readonly' : ''} ${opts.placeholder ? `placeholder="${escapeHtml(opts.placeholder)}"` : ''} ${opts.attrs || ''}></div>`;
}

function selectField(label, name, options, value = '', full = false, disabled = false) {
  return `<div class="field ${full ? 'full' : ''}"><label>${label}</label><select class="control" name="${name}" ${disabled ? 'disabled' : ''}>${options.map(o => `<option value="${escapeHtml(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select></div>`;
}

function modal(title, body, wide = false) {
  let el = $('#modal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'modal';
    el.className = 'modal hidden';
    el.innerHTML = '<div class="modal-card"><div class="modal-head"><h2 id="modal-title"></h2><button class="x" type="button" data-action="close-modal">×</button></div><div id="modal-body"></div></div>';
    document.body.append(el);
  }
  const card = $('#modal .modal-card');
  if (card) card.classList.toggle('invoice-modal-card', wide);
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  el.classList.remove('hidden');
}

function closeModal() {
  $('#modal')?.classList.add('hidden');
}

function setPage(t) {
  if (isPersistentOfflineSession() && t !== 'items') {
    toast('هذه الشاشة تحتاج إلى اتصال بالخادم. يمكنك إدارة الأصناف المحفوظة محلياً ثم مزامنتها عند عودة الإنترنت.', true);
    t = 'items';
  }
  currentPage = t;
  $$('[data-page]').forEach(x => x.classList.toggle('active', x.dataset.page === t));
  renderPage();
}

function roleLabel(r) {
  return ({ manager: 'مدير النظام', accountant: 'محاسب مالي', cashier: 'كاشير مبيعات' }[r] || r);
}

function canFinance() {
  return ['manager', 'accountant'].includes(profile?.role);
}

function canManage() {
  return profile?.role === 'manager';
}

function toggleTheme() {
  const html = document.documentElement;
  const next = html.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  try { localStorage.setItem('shaibani_theme', next); } catch (_e) {}
  const btnEl = $('#theme-toggle-btn');
  if (btnEl) btnEl.textContent = next === 'dark' ? '☀️ نهاري' : '🌙 ليلي';
}

function docTypeLabel(t) {
  return ({
    sale: 'فاتورة مبيعات',
    purchase: 'فاتورة مشتريات',
    sale_return: 'مرتجع مبيعات',
    purchase_return: 'مرتجع مشتريات',
    expense: 'سند مصروف',
    receipt: 'سند قبض',
    payment: 'سند صرف'
  }[t] || t);
}

function docBadgeClass(t) {
  return ({
    sale: '',
    purchase: 'blue',
    sale_return: 'red',
    purchase_return: 'warn',
    expense: 'warn',
    receipt: 'gold',
    payment: 'blue'
  }[t] || '');
}

/* ============================================================================
   AUTHENTICATION & INTERACTIVE DEMO LAUNCHER
   ============================================================================ */
function startDemoSession(role = 'manager') {
  isDemoMode = true;
  offlineSessionActive = false;
  supabase = createDemoSupabaseClient();
  const db = loadDemoDB();
  const found = db.profiles.find(p => p.role === role) || db.profiles[0];
  profile = { ...found, role };
  session = { user: { id: profile.id, email: `${role}@shaibani-erp.com` }, access_token: 'demo-token' };
  cachedProducts = [];
  cachedParties = [];
  cachedCash = [];
  if (role === 'cashier' && !['dashboard', 'pos', 'sales', 'items', 'customers'].includes(currentPage)) {
    currentPage = 'pos';
  }
  buildShell();
  renderPage();
  toast(`تم تفعيل وضع المحاكاة الفورية بدور: ${roleLabel(role)}`);
}

function showConfig() {
  markAppReady();
  showLogin('يمكنك الدخول فوراً في وضع النموذج التفاعلي المتكامل أو ربط مشروع Supabase في config.js');
}

function showLogin(message = '') {
  markAppReady();
  app.innerHTML = `
    <div class="auth-shell">
      <div class="auth-container">
        <div class="auth-hero">
          <div>
            <span class="auth-hero-badge">✦ الإصدار 2.1.0</span>
            <h2>نظام الشيباني المحاسبي والإداري المتكامل</h2>
            <p>منظومة ERP محاسبية ومخزنية متكاملة مصممة خصيصاً لمحلات الشيباني للبهارات والأعشاب الطبيعية — تدعم تعدد الوحدات، تعدد العملات، نقطة البيع السريعة، الجرد، والميزانية الختامية.</p>
            <div class="auth-features">
              <div class="auth-feature-item"><span class="auth-feature-icon">▣</span><div><b>نقطة بيع تفاعلية وفاتورة ذكية</b><br><span style="opacity:.8">جدول بنود قابل للتعديل، وحدات مرنة، وسعر شراء داخلي محمي</span></div></div>
              <div class="auth-feature-item"><span class="auth-feature-icon">⇄</span><div><b>وظائف محاسبية قائمة على القيد المزدوج</b><br><span style="opacity:.8">مبيعات، مشتريات، مرتجعات، تسويات جرد، وتحويلات صناديق</span></div></div>
              <div class="auth-feature-item"><span class="auth-feature-icon">▥</span><div><b>تقارير ختامية وكشوف حسابات</b><br><span style="opacity:.8">ميزان مراجعة، قائمة دخل، مركز مالي، وطباعة حرارية 80mm وA4</span></div></div>
            </div>
          </div>
          <div style="font-size:11.5px;color:#ebd197;border-top:1px solid rgba(255,255,255,.14);padding-top:12px">
            اليمن - عدن - الشيخ عثمان - شارع طرابلس · واتساب: 773837930 / 772533727 · هاتف: 02 383280
          </div>
        </div>
        <div class="auth-card">
          <img class="brand-logo" src="${LOGO_SRC}" alt="شعار محلات الشيباني">
          <h1>محلات الشيباني</h1>
          <div class="muted">بوابة الدخول للنظام المحاسبي والمخزني</div>
          ${message ? `<div class="alert error" style="margin-top:12px">${escapeHtml(message)}</div>` : ''}
          <form id="login-form" style="margin-top:14px">
            <div class="field">
              <label>البريد الإلكتروني (حساب Supabase)</label>
              <input class="control" name="email" type="email" required autocomplete="username" placeholder="manager@shaibani.com">
            </div>
            <div class="field">
              <label>كلمة المرور</label>
              <input class="control" name="password" type="password" required autocomplete="current-password" placeholder="••••••••">
            </div>
            <button class="btn full" type="submit" style="margin-top:6px;padding:11px">🔐 تسجيل الدخول لقاعدة البيانات</button>
            <button class="btn light full" type="button" data-action="start-offline" style="margin-top:8px">📴 فتح بيانات هذا الجهاز دون اتصال</button>
            <small class="hint">يتطلب جلسة Supabase سابقة ما زالت صالحة على هذا الجهاز. وضع عدم الاتصال مخصص مؤقتاً لإدارة دليل الأصناف والأرصدة المخزنة محلياً.</small>
          </form>
          <div class="demo-launch-box">
            <strong>🚀 تجربة النموذج التفاعلي الحديث (بدون اتصال خارجي)</strong>
            <div class="hint">استعرض كافة النوافذ الـ 14 والتصميمات الجديدة والدورة المحاسبية الكاملة ببيانات محلات الشيباني:</div>
            <div class="demo-role-grid">
              <button class="btn gold" type="button" data-action="start-demo" data-role="manager">دخول كمدير نظام</button>
              <button class="btn" type="button" data-action="start-demo" data-role="accountant">دخول كمحاسب</button>
              <button class="btn light" type="button" data-action="start-demo" data-role="cashier">دخول ككاشير</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  const form = $('#login-form');
  if (form) form.onsubmit = login;
}

async function login(e) {
  e.preventDefault();
  if (!configured) {
    toast('لم يتم ضبط اتصال Supabase الحي؛ يمكنك استخدام وضع المحاكاة الفورية أدناه', true);
    return;
  }
  isDemoMode = false;
  supabase = await createSupabaseLiveClient(cfg.SUPABASE_URL, supabaseApiKey, {
    db: { schema: cfg.SUPABASE_SCHEMA || 'shaibani_erp' },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  const d = Object.fromEntries(new FormData(e.target));
  const b = $('button[type=submit]', e.target);
  b.disabled = true;
  b.textContent = 'جارٍ التحقق من الحساب…';
  const { error } = await supabase.auth.signInWithPassword({ email: d.email, password: d.password });
  if (error) {
    showLogin(error.message);
    return;
  }
  await afterLogin();
}

async function afterLogin() {
  const { data: { session: s } } = await supabase.auth.getSession();
  session = s;
  if (!s) {
    showLogin();
    return;
  }
  const { data: p, error } = await supabase.from('profiles').select('id,full_name,role,is_active').eq('id', s.user.id).maybeSingle();
  if (error) {
    const cached = await getCachedProfile();
    const locallyValidSession = getValidStoredAuthSession(cached?.id);
    if (!navigator.onLine && cached?.id === s.user.id && cached.is_active && locallyValidSession) {
      session = { user: locallyValidSession.user, access_token: locallyValidSession.access_token };
      profile = { id: cached.id, full_name: cached.full_name, role: cached.role, is_active: true };
      offlineSessionActive = true;
      currentPage = 'items';
      cachedProducts = await getCachedProducts();
      buildShell();
      await renderPage();
      await refreshOfflineBadge();
      return;
    }
    await supabase.auth.signOut();
    session = null;
    showLogin('تعذر قراءة ملف الموظف من مخطط ' + (cfg.SUPABASE_SCHEMA || 'shaibani_erp') + ': ' + error.message);
    return;
  }
  if (!p || !p.is_active) {
    await supabase.auth.signOut();
    session = null;
    showLogin('الحساب غير مفعّل أو لا يملك ملف موظف في النظام. اطلب من مدير النظام مراجعة حسابك.');
    return;
  }
  profile = p;
  offlineSessionActive = false;
  await cacheProfile(profile);
  cachedProducts = [];
  cachedParties = [];
  cachedCash = [];
  buildShell();
  await renderPage();
  // ابدأ بناء النسخة المحلية فور الدخول حتى تتوفر البيانات عند انقطاع الاتصال لاحقاً.
  try { await loadProducts(); await loadInventorySummary(); } catch (err) { console.warn('تعذر إكمال التخزين المحلي الأولي:', err); }
  subscribeRealtime();
  await refreshOfflineBadge();
  if (navigator.onLine) await syncOfflineQueue(false);
}

function buildShell() {
  markAppReady();
  const groups = [
    {
      label: 'التشغيل ونقطة البيع',
      items: [
        ['dashboard', '📊', 'لوحة التحكم'],
        ['pos', '🛒', 'نقطة البيع السريعة'],
        ['sales', '🧾', 'فواتير المبيعات'],
        ['purchases', '📦', 'فواتير المشتريات']
      ]
    },
    {
      label: 'المخزون والأطراف',
      items: [
        ['items', '🌿', 'الأصناف والمخزون'],
        ['customers', '👥', 'العملاء والذمم'],
        ['suppliers', '🚛', 'الموردون والذمم']
      ]
    },
    {
      label: 'المالية والمحاسبة',
      items: [
        ['cash', '🏦', 'الصناديق والسندات'],
        ['expenses', '💸', 'المصروفات'],
        ['journal', '📘', 'القيود ودليل الحسابات'],
        ['reports', '📈', 'التقارير والميزانية']
      ]
    },
    {
      label: 'الإدارة والنظام',
      items: [
        ['users', '🛡️', 'الموظفون والصلاحيات'],
        ['settings', '⚙️', 'الإعدادات والعملات']
      ]
    }
  ];

  const isAllowed = (id) => {
    if (profile.role === 'cashier') return ['dashboard', 'pos', 'sales', 'items', 'customers'].includes(id);
    if (profile.role === 'accountant') return id !== 'users' && id !== 'settings';
    return true;
  };

  const navHtml = groups.map(g => {
    const visible = g.items.filter(([id]) => isAllowed(id));
    if (!visible.length) return '';
    return `<div class="nav-group-label">${g.label}</div><div class="nav">${visible.map(([id, ic, label]) =>
      `<button type="button" data-page="${id}" class="${id === currentPage ? 'active' : ''}"><span class="nav-ic">${ic}</span><span>${label}</span></button>`
    ).join('')}</div>`;
  }).join('');

  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  app.innerHTML = `
    <div class="layout">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <img class="brand-logo side-logo" src="${LOGO_SRC}" alt="شعار الشيباني">
          <div>
            <strong>محلات الشيباني</strong>
            <small>للبهارات والأعشاب الطبيعية</small>
          </div>
        </div>
        ${navHtml}
        <div class="side-bottom">
          <b>فرع الشيخ عثمان الرئيسي</b>
          عدن - شارع طرابلس<br>
          واتساب: 773837930 · 772533727<br>
          هاتف: 02 383280
        </div>
      </aside>
      <main class="main">
        ${isDemoMode ? `
        <div class="demo-banner">
          <div><b>✨ وضع النموذج التفاعلي المتكامل:</b> جميع العمليات المحاسبية والمخزنية والقيود تعمل فورياً. يمكنك تبديل الدور لتجربة صلاحيات كل موظف:</div>
          <div class="demo-banner-controls">
            <button type="button" class="role-pill-btn ${profile.role === 'manager' ? 'active' : ''}" data-action="switch-demo-role" data-role="manager">مدير النظام</button>
            <button type="button" class="role-pill-btn ${profile.role === 'accountant' ? 'active' : ''}" data-action="switch-demo-role" data-role="accountant">محاسب</button>
            <button type="button" class="role-pill-btn ${profile.role === 'cashier' ? 'active' : ''}" data-action="switch-demo-role" data-role="cashier">كاشير</button>
            <button type="button" class="role-pill-btn" data-action="open-design-showcase">🎨 دليل التصميم والاختبارات</button>
            <button type="button" class="role-pill-btn" data-action="reset-demo-data">↺ استعادة البيانات الافتراضية</button>
          </div>
        </div>` : ''}
        <header class="topbar">
          <button class="menu-toggle" type="button" data-action="toggle-menu">☰</button>
          <div>
            <h1 id="page-title">${escapeHtml(pageNames[currentPage] || 'نظام الشيباني')}</h1>
            <div class="muted" id="page-subtitle">محلات الشيباني للبهارات والأعشاب الطبيعية · ${roleLabel(profile.role)}</div>
          </div>
          <div class="top-actions">
            <button class="btn gold" type="button" data-action="new-sale">＋ فاتورة بيع</button>
            <button class="btn light" type="button" id="theme-toggle-btn" data-action="toggle-theme">${isDark ? '☀️ نهاري' : '🌙 ليلي'}</button>
            <button class="btn light offline-sync-btn" type="button" data-action="sync-now" title="مزامنة العمليات المحفوظة محلياً">⇅ مزامنة</button>
            <span class="status" id="connection-status">${isDemoMode ? '● محاكاة محلية' : (offlineSessionActive || !navigator.onLine ? '● دون اتصال' : '● متصل')}</span>
            <span class="user-chip">${escapeHtml(profile.full_name || session?.user?.email || '')}</span>
            <button class="btn light" type="button" data-action="logout">${isDemoMode ? 'شاشة الدخول' : 'خروج'}</button>
          </div>
        </header>
        <section id="page-content">${showLoading()}</section>
      </main>
    </div>`;
}

function subscribeRealtime() {
  if (isDemoMode || !supabase?.channel) return;
  if (realtimeChannel) supabase.removeChannel(realtimeChannel);
  let channel = supabase.channel('shaibani-live')
    .on('postgres_changes', { event: '*', schema: (cfg.SUPABASE_SCHEMA || 'shaibani_erp'), table: 'documents' }, () => {
      if (['dashboard', 'sales', 'purchases', 'expenses', 'cash', 'reports', 'items', 'pos'].includes(currentPage)) renderPage();
    })
    .on('postgres_changes', { event: '*', schema: (cfg.SUPABASE_SCHEMA || 'shaibani_erp'), table: 'product_catalog_events' }, () => {
      cachedProducts = [];
      if (['items', 'pos'].includes(currentPage)) renderPage();
    })
    .on('postgres_changes', { event: '*', schema: (cfg.SUPABASE_SCHEMA || 'shaibani_erp'), table: 'parties' }, () => {
      cachedParties = [];
      if (['customers', 'suppliers', 'pos'].includes(currentPage)) renderPage();
    });
  if (canFinance()) {
    channel = channel.on('postgres_changes', { event: '*', schema: (cfg.SUPABASE_SCHEMA || 'shaibani_erp'), table: 'stock_movements' }, () => {
      if (['dashboard', 'items', 'reports'].includes(currentPage)) renderPage();
    });
  }
  realtimeChannel = channel.subscribe((status) => {
    const el = $('#connection-status');
    if (el) el.textContent = status === 'SUBSCRIBED' ? '● مزامنة مباشرة' : '● جارٍ الاتصال';
  });
}

async function queryOrThrow(q) {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

async function loadProducts() {
  if (cachedProducts.length) return cachedProducts;
  if (!isPersistentOfflineSession() && supabase) {
    try {
      const [p, u] = await Promise.all([
        queryOrThrow(supabase.from('v_products').select('*').order('name')),
        queryOrThrow(supabase.from('v_product_units').select('*'))
      ]);
      const serverProducts = p.map(x => ({ ...x, units: u.filter(a => a.product_id === x.id) }));
      await cacheProducts(serverProducts);
      // احتفظ بالأصناف التي ما زالت معلّقة محلياً ولا تخفها عند نجاح قراءة الخادم.
      const localRows = await getCachedProducts();
      const merged = new Map(serverProducts.map(product => [String(product.id), product]));
      for (const localProduct of localRows) {
        if (localProduct.local_sync_state === 'pending' || String(localProduct.id).startsWith('local-')) {
          merged.set(String(localProduct.id), localProduct);
        }
      }
      cachedProducts = [...merged.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ar'));
      return cachedProducts;
    } catch (err) {
      console.warn('تعذر تحميل الأصناف من الخادم؛ سيتم استخدام النسخة المحلية.', err);
    }
  }
  cachedProducts = await getCachedProducts();
  return cachedProducts;
}

async function loadParties() {
  if (cachedParties.length) return cachedParties;
  if (!isPersistentOfflineSession() && supabase) {
    try {
      const cols = canFinance() ? '*' : 'id,party_type,name,phone,address,active,created_at,updated_at';
      cachedParties = await queryOrThrow(supabase.from('parties').select(cols).eq('active', true).order('name'));
      await setSnapshot('parties', cachedParties);
      return cachedParties;
    } catch (_e) { /* Fallback to last cached list */ }
  }
  cachedParties = (await getSnapshot('parties')) || [];
  return cachedParties;
}

async function loadCash() {
  if (cachedCash.length) return cachedCash;
  if (!isPersistentOfflineSession() && supabase) {
    try {
      cachedCash = await queryOrThrow(supabase.from('cash_accounts').select('id,name,currency,account_id').eq('active', true).order('name'));
      await setSnapshot('cash-accounts', cachedCash);
      return cachedCash;
    } catch (_e) { /* Fallback to last cached list */ }
  }
  cachedCash = (await getSnapshot('cash-accounts')) || [];
  return cachedCash;
}

async function loadPartyBalancesMap() {
  if (!canFinance()) return new Map();
  try {
    const rows = await queryOrThrow(supabase.from('v_party_balances').select('id,net_balance_base'));
    return new Map(rows.map(r => [r.id, Number(r.net_balance_base || 0)]));
  } catch (_e) {
    try {
      const lines = await queryOrThrow(supabase.from('journal_lines').select('party_id,debit_base,credit_base'));
      const map = new Map();
      lines.forEach(l => {
        if (l.party_id) map.set(l.party_id, (map.get(l.party_id) || 0) + Number(l.debit_base || 0) - Number(l.credit_base || 0));
      });
      return map;
    } catch (_e2) {
      return new Map();
    }
  }
}

async function renderPage() {
  if (!profile) return;
  const title = $('#page-title');
  if (title) title.textContent = pageNames[currentPage] || 'نظام الشيباني';
  const out = $('#page-content');
  if (!out) return;
  out.innerHTML = showLoading();
  try {
    let html = '';
    switch (currentPage) {
      case 'dashboard': html = await dashboardPage(); break;
      case 'pos': html = await posPage(); break;
      case 'sales': html = await documentsPage('sale'); break;
      case 'purchases': html = await documentsPage('purchase'); break;
      case 'items': html = await itemsPage(); break;
      case 'customers': html = await partiesPage('customer'); break;
      case 'suppliers': html = await partiesPage('supplier'); break;
      case 'expenses': html = await moneyDocumentsPage('expense'); break;
      case 'cash': html = await cashPage(); break;
      case 'journal': html = await journalPage(); break;
      case 'reports': html = await reportsPage(); break;
      case 'users': html = await usersPage(); break;
      case 'settings': html = await settingsPage(); break;
      default: html = '<div class="panel">القسم غير موجود</div>';
    }
    if ($('#page-content')) $('#page-content').innerHTML = html;
    if (currentPage === 'pos') bindPosEvents();
  } catch (err) {
    if ($('#page-content')) {
      $('#page-content').innerHTML = `<div class="alert error">تعذر تحميل الصفحة: ${escapeHtml(err.message || err)}</div><div style="margin-top:10px">${btn('إعادة المحاولة', 'refresh')}</div>`;
    }
  }
}

/* ============================================================================
   WINDOW 2: EXECUTIVE DASHBOARD
   ============================================================================ */
async function dashboardPage() {
  const monthStart = new Date().toISOString().slice(0, 7) + '-01';
  const isFin = canFinance();
  const [sales, purchases, expenses, products, stock, low, recent, cashBalances] = await Promise.all([
    queryOrThrow(supabase.from('documents').select('id,total,currency,exchange_rate').eq('doc_type', 'sale').gte('document_date', monthStart)),
    isFin ? queryOrThrow(supabase.from('documents').select('id,total,currency,exchange_rate').eq('doc_type', 'purchase').gte('document_date', monthStart)) : Promise.resolve([]),
    isFin ? queryOrThrow(supabase.from('documents').select('id,total,currency,exchange_rate').eq('doc_type', 'expense').gte('document_date', monthStart)) : Promise.resolve([]),
    queryOrThrow(supabase.from('v_products').select('id')),
    queryOrThrow(supabase.from('v_inventory_summary').select('quantity,inventory_value_base')),
    queryOrThrow(supabase.from('v_inventory_summary').select('id,name,quantity,reorder_level').gt('reorder_level', 0)),
    queryOrThrow(supabase.from('documents').select('id,doc_no,doc_type,document_date,total,currency,status').order('created_at', { ascending: false }).limit(8)),
    queryOrThrow(supabase.from('v_cash_balances').select('id,name,currency,foreign_balance'))
  ]);

  const totalsByCurrency = (rows) => ['YER', 'SAR', 'USD'].map(c => ({
    c,
    total: rows.filter(x => x.currency === c).reduce((a, x) => a + Number(x.total || 0), 0)
  })).filter(x => x.total !== 0);

  const summary = (rows) => totalsByCurrency(rows).map(x =>
    `<div class="currency-line"><span>${currencyName(x.c)}</span><b>${money(x.total)} ${x.c}</b></div>`
  ).join('') || '<span class="muted" style="display:block;margin-top:10px">لا توجد عمليات مسجلة هذا الشهر</span>';

  const lowItems = low.filter(x => Number(x.quantity) <= Number(x.reorder_level));
  const lowRows = lowItems.map(x =>
    `<tr><td><b>${escapeHtml(x.name)}</b></td><td>${money(x.quantity)}</td><td>${money(x.reorder_level)}</td><td><span class="badge warn">بحاجة لتموين</span></td></tr>`
  ).join('');

  const invValue = isFin ? money(stock.reduce((a, x) => a + Number(x.inventory_value_base || 0), 0)) + ' ر.ي' : '—';
  const recentRows = recent.map(x => `
    <tr>
      <td><b>${escapeHtml(x.doc_no)}</b></td>
      <td><span class="badge ${docBadgeClass(x.doc_type)}">${docTypeLabel(x.doc_type)}</span></td>
      <td>${escapeHtml(x.document_date)}</td>
      <td><b>${money(x.total)} ${x.currency}</b></td>
      <td><button class="mini" type="button" data-action="view-doc" data-id="${x.id}">عرض / طباعة</button></td>
    </tr>`).join('');

  const salesBase = sales.reduce((s, x) => s + Number(x.total || 0) * Number(x.exchange_rate || 1), 0);
  const purchBase = purchases.reduce((s, x) => s + Number(x.total || 0) * Number(x.exchange_rate || 1), 0);
  const expBase = expenses.reduce((s, x) => s + Number(x.total || 0) * Number(x.exchange_rate || 1), 0);
  const maxBar = Math.max(salesBase, purchBase, expBase, 1);

  return `
    <div class="cards">
      <div class="card metric">
        <div class="metric-head"><small>مبيعات الشهر (حسب العملة)</small><span class="metric-icon">🧾</span></div>
        ${summary(sales)}
      </div>
      ${isFin ? `
      <div class="card metric gold-top">
        <div class="metric-head"><small>مشتريات الشهر (حسب العملة)</small><span class="metric-icon">📦</span></div>
        ${summary(purchases)}
      </div>` : `
      <div class="card metric gold-top">
        <div class="metric-head"><small>نقطة البيع المباشرة</small><span class="metric-icon">🛒</span></div>
        <strong>جاهزة</strong>
        <em>اضغط لبدء البيع السريع</em>
      </div>`}
      <div class="card metric blue-top">
        <div class="metric-head"><small>الأصناف المسجلة</small><span class="metric-icon">🌿</span></div>
        <strong>${money(products.length)}</strong>
        <em>صنف فعال · ${lowItems.length} تحت حد الطلب</em>
      </div>
      <div class="card metric ${lowItems.length ? 'red-top' : ''}">
        <div class="metric-head"><small>قيمة المخزون الدفترية</small><span class="metric-icon">🏦</span></div>
        <strong>${invValue}</strong>
        <em>${isFin ? 'بتكلفة المتوسط المرجح' : 'الأرصدة الكمية متاحة في المخزون'}</em>
      </div>
    </div>

    <div class="grid-two" style="margin-top:16px">
      <div class="panel">
        <div class="section-head" style="margin-top:0">
          <div>
            <h2>أحدث المستندات والعمليات المرحلة</h2>
            <div class="hint">اضغط على «عرض / طباعة» لمعاينة أي فاتورة أو سند ومشاركته عبر واتساب.</div>
          </div>
          <div class="toolbar">
            ${btn('🛒 نقطة البيع', 'go-pos', 'gold')}
            ${btn('＋ فاتورة بيع', 'new-sale')}
          </div>
        </div>
        ${table(['رقم المستند', 'النوع', 'التاريخ', 'الإجمالي', 'إجراء'], recentRows)}
      </div>

      <div class="stack">
        ${isFin ? `
        <div class="panel">
          <h2>مؤشر الأداء المالي للشهر (بالعملة الأساسية)</h2>
          <div class="chart-bars">
            <div class="chart-bar-col">
              <span class="chart-bar-val">${money(salesBase)}</span>
              <div class="chart-bar" style="height:${Math.max(8, Math.round((salesBase / maxBar) * 100))}%"></div>
              <span class="chart-bar-lbl">المبيعات</span>
            </div>
            <div class="chart-bar-col">
              <span class="chart-bar-val">${money(purchBase)}</span>
              <div class="chart-bar gold" style="height:${Math.max(8, Math.round((purchBase / maxBar) * 100))}%"></div>
              <span class="chart-bar-lbl">المشتريات</span>
            </div>
            <div class="chart-bar-col">
              <span class="chart-bar-val">${money(expBase)}</span>
              <div class="chart-bar" style="background:var(--red);height:${Math.max(8, Math.round((expBase / maxBar) * 100))}%"></div>
              <span class="chart-bar-lbl">المصروفات</span>
            </div>
          </div>
        </div>` : ''}

        <div class="panel">
          <h2>أرصدة الصناديق الحية</h2>
          ${cashBalances.map(c => `
            <div class="currency-line">
              <span>${escapeHtml(c.name)}</span>
              <b>${money(c.foreign_balance)} ${escapeHtml(c.currency)}</b>
            </div>
          `).join('')}
        </div>

        <div class="panel">
          <div class="section-head" style="margin-top:0">
            <h2>تنبيهات إعادة الطلب (${lowItems.length})</h2>
            ${isFin ? btn('＋ فاتورة شراء', 'new-purchase', 'light') : ''}
          </div>
          ${table(['الصنف', 'المتوفر', 'حد الطلب', 'الحالة'], lowRows)}
        </div>
      </div>
    </div>`;
}

/* ============================================================================
   WINDOW 3: INTERACTIVE POINT-OF-SALE (POS) WORKSPACE
   ============================================================================ */
async function posPage() {
  const [products, parties, cash, inv] = await Promise.all([
    loadProducts(),
    loadParties(),
    loadCash(),
    queryOrThrow(supabase.from('v_inventory_summary').select('id,quantity'))
  ]);
  activeSaleProducts = products;
  activeSaleInventory = new Map(inv.map(x => [x.id, Number(x.quantity || 0)]));
  const categories = ['all', ...new Set(products.map(p => p.category || 'عام').filter(Boolean))];
  const customers = parties.filter(p => p.party_type === 'customer' || p.party_type === 'both');
  const cashForCurr = cash.filter(c => c.currency === posCurrency);

  return `
    <div class="pos-workspace">
      <div class="pos-catalog-panel">
        <div class="section-head" style="margin-top:0">
          <div>
            <h2>كتالوج الأصناف السريع (نقطة البيع)</h2>
            <div class="hint">انقر على أي صنف لإضافته مباشرة إلى سلة البيع، أو ابحث بالاسم أو الباركود.</div>
          </div>
          <button class="btn light" type="button" data-action="new-sale">🗔 فتح نافذة الفاتورة المفصلة</button>
        </div>
        <input class="control" id="pos-search-input" value="${escapeHtml(posSearch)}" placeholder="🔍 ابحث باسم البهار أو العشب أو رقم الباركود (SKU)…">
        <div class="pos-cats" id="pos-cats-bar">
          ${categories.map(c => `<button type="button" class="pos-cat-btn ${posCategory === c ? 'active' : ''}" data-pos-cat="${escapeHtml(c)}">${c === 'all' ? 'الكل (' + products.length + ')' : escapeHtml(c)}</button>`).join('')}
        </div>
        <div class="pos-grid" id="pos-products-grid"></div>
      </div>

      <div class="pos-cart-panel">
        <div class="pos-cart-head">
          <div>
            <h2 style="margin:0;color:var(--g2)">🧾 سلة البيع المباشر</h2>
            <small class="muted" id="pos-cart-count">0 صنف في السلة</small>
          </div>
          <button class="mini red" type="button" data-action="clear-pos-cart">تفريغ السلة</button>
        </div>

        <div class="form-grid" style="gap:8px">
          <div class="field" style="margin:4px 0">
            <label>العميل (نقدي أو مسجل)</label>
            <input class="control" id="pos-customer-input" list="pos-customer-datalist" value="${escapeHtml(posCustomerName)}" placeholder="عميل نقدي / اختر من القائمة">
            <datalist id="pos-customer-datalist">${customers.map(c => `<option value="${escapeHtml(c.name)}"></option>`).join('')}</datalist>
          </div>
          <div class="field" style="margin:4px 0">
            <label>واتساب العميل</label>
            <input class="control" id="pos-phone-input" value="${escapeHtml(posCustomerPhone)}" placeholder="+9677xxxxxxxx">
          </div>
          <div class="field" style="margin:4px 0">
            <label>طريقة السداد</label>
            <select class="control" id="pos-settlement-select">
              <option value="cash" ${posSettlement === 'cash' ? 'selected' : ''}>نقدي (صندوق)</option>
              <option value="credit" ${posSettlement === 'credit' ? 'selected' : ''}>آجل (ذمم عملاء)</option>
            </select>
          </div>
          <div class="field" style="margin:4px 0">
            <label>الصندوق (${posCurrency})</label>
            <select class="control" id="pos-cash-select" ${posSettlement === 'credit' ? 'disabled' : ''}>
              ${cashForCurr.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="pos-cart-items" id="pos-cart-items"></div>

        <div class="sale-totals" style="margin-top:10px">
          <div><span>المجموع الفرعي</span><b id="pos-subtotal-val">0</b></div>
          <div class="sale-adjust"><label>الخصم</label><input class="control" id="pos-discount-input" type="number" min="0" step="0.01" value="${posDiscount}"></div>
          <div class="sale-grand-total"><span>الصافي للدفع (${posCurrency})</span><strong id="pos-total-val">0</strong></div>
        </div>

        <div class="form-actions" style="margin-top:12px">
          <button class="btn gold full" type="button" id="pos-checkout-btn" data-action="submit-pos-sale" style="padding:13px;font-size:14px">⚡ ترحيل الفاتورة وطباعة الإيصال</button>
        </div>
      </div>
    </div>`;
}

function renderPosCatalog() {
  const grid = $('#pos-products-grid');
  if (!grid) return;
  const q = posSearch.trim().toLowerCase();
  const filtered = activeSaleProducts.filter(p => {
    const matchCat = posCategory === 'all' || (p.category || 'عام') === posCategory;
    const matchQ = !q || p.name.toLowerCase().includes(q) || String(p.sku || '').toLowerCase().includes(q);
    return matchCat && matchQ;
  });
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">لا توجد أصناف مطابقة للبحث</div>';
    return;
  }
  grid.innerHTML = filtered.map(p => {
    const baseU = p.units.find(u => u.is_base) || p.units[0];
    const stock = activeSaleInventory.get(p.id) || 0;
    const low = stock <= Number(p.reorder_level || 0);
    return `
      <button type="button" class="pos-item-card" data-pos-add="${p.id}">
        <div>
          <div class="pos-sku">${escapeHtml(p.sku || 'بدون رمز')} · ${escapeHtml(p.category || 'عام')}</div>
          <strong>${escapeHtml(p.name)}</strong>
        </div>
        <div class="pos-item-foot">
          <span class="pos-price-tag">${money(baseU?.sale_price || 0)} ${baseU?.currency || 'YER'}</span>
          <span class="badge ${stock <= 0 ? 'red' : low ? 'warn' : ''}">${money(stock)} ${escapeHtml(p.base_unit)}</span>
        </div>
      </button>`;
  }).join('');
}

function renderPosCart() {
  const wrap = $('#pos-cart-items');
  if (!wrap) return;
  const countEl = $('#pos-cart-count');
  if (countEl) countEl.textContent = `${posCart.length} بند في السلة`;

  if (!posCart.length) {
    wrap.innerHTML = '<div class="empty" style="padding:20px">السلة فارغة — انقر على الأصناف لإضافتها</div>';
  } else {
    wrap.innerHTML = posCart.map(item => {
      const prod = activeSaleProducts.find(p => p.id === item.product_id);
      const units = prod?.units || [];
      return `
        <div class="pos-cart-row" data-pos-key="${item.key}">
          <div>
            <b style="display:block;font-size:12px">${escapeHtml(item.product_name)}</b>
            <select class="control pos-unit-select" style="margin-top:4px;padding:4px 6px;font-size:11px">
              ${units.map(u => `<option value="${u.id}" ${u.id === item.unit_id ? 'selected' : ''}>${escapeHtml(u.unit_name)} (${money(u.sale_price)})</option>`).join('')}
            </select>
          </div>
          <div class="qty-stepper">
            <button type="button" data-pos-step="-1">−</button>
            <input type="number" class="pos-qty-input" value="${item.quantity}" min="0.01" step="0.25">
            <button type="button" data-pos-step="1">+</button>
          </div>
          <div>
            <input type="number" class="control pos-price-input" value="${item.unit_price}" style="padding:5px 7px;font-size:11.5px" title="سعر الوحدة">
            <small class="muted" style="display:block;margin-top:2px">= <b>${money(item.quantity * item.unit_price)}</b></small>
          </div>
          <button type="button" class="mini red" data-pos-remove="${item.key}">×</button>
        </div>`;
    }).join('');
  }

  const subtotal = posCart.reduce((s, x) => s + Number(x.quantity || 0) * Number(x.unit_price || 0), 0);
  const total = Math.max(0, subtotal - Number(posDiscount || 0) + Number(posTax || 0));
  if ($('#pos-subtotal-val')) $('#pos-subtotal-val').textContent = money(subtotal);
  if ($('#pos-total-val')) $('#pos-total-val').textContent = money(total) + ' ' + posCurrency;
}

function bindPosEvents() {
  renderPosCatalog();
  renderPosCart();

  $('#pos-search-input')?.addEventListener('input', e => {
    posSearch = e.target.value;
    renderPosCatalog();
  });

  $('#pos-cats-bar')?.addEventListener('click', e => {
    const b = e.target.closest('[data-pos-cat]');
    if (!b) return;
    posCategory = b.dataset.posCat;
    $$('#pos-cats-bar .pos-cat-btn').forEach(x => x.classList.toggle('active', x === b));
    renderPosCatalog();
  });

  $('#pos-products-grid')?.addEventListener('click', e => {
    const card = e.target.closest('[data-pos-add]');
    if (!card) return;
    const prod = activeSaleProducts.find(p => p.id === card.dataset.posAdd);
    if (!prod) return;
    const baseU = prod.units.find(u => u.is_base) || prod.units[0];
    if (!baseU) { toast('الصنف لا يملك وحدة معرفة', true); return; }
    const existing = posCart.find(x => x.product_id === prod.id && x.unit_id === baseU.id);
    if (existing) {
      existing.quantity = Number((existing.quantity + 1).toFixed(4));
    } else {
      posCart.push({
        key: 'pos-' + (++saleLineSequence),
        product_id: prod.id,
        product_name: prod.name,
        unit_id: baseU.id,
        unit_name: baseU.unit_name,
        factor_to_base: Number(baseU.factor_to_base || 1),
        quantity: 1,
        unit_price: Number(baseU.sale_price || 0),
        purchase_price: canFinance() ? Number(baseU.purchase_price || prod.avg_cost_base || 0) : ''
      });
    }
    renderPosCart();
  });

  $('#pos-cart-items')?.addEventListener('click', e => {
    const rem = e.target.closest('[data-pos-remove]');
    if (rem) {
      posCart = posCart.filter(x => x.key !== rem.dataset.posRemove);
      renderPosCart();
      return;
    }
    const stepBtn = e.target.closest('[data-pos-step]');
    if (stepBtn) {
      const row = stepBtn.closest('[data-pos-key]');
      const item = posCart.find(x => x.key === row?.dataset.posKey);
      if (!item) return;
      const delta = Number(stepBtn.dataset.posStep);
      item.quantity = Math.max(0.25, Number((item.quantity + delta).toFixed(4)));
      renderPosCart();
    }
  });

  $('#pos-cart-items')?.addEventListener('change', e => {
    const row = e.target.closest('[data-pos-key]');
    const item = posCart.find(x => x.key === row?.dataset.posKey);
    if (!item) return;
    if (e.target.classList.contains('pos-unit-select')) {
      const prod = activeSaleProducts.find(p => p.id === item.product_id);
      const u = prod?.units.find(x => x.id === e.target.value);
      if (u) {
        item.unit_id = u.id;
        item.unit_name = u.unit_name;
        item.factor_to_base = Number(u.factor_to_base);
        item.unit_price = Number(u.sale_price || 0);
        item.purchase_price = canFinance() ? Number(u.purchase_price || 0) : '';
      }
      renderPosCart();
    }
  });

  $('#pos-cart-items')?.addEventListener('input', e => {
    const row = e.target.closest('[data-pos-key]');
    const item = posCart.find(x => x.key === row?.dataset.posKey);
    if (!item) return;
    if (e.target.classList.contains('pos-qty-input')) item.quantity = Math.max(0.0001, Number(e.target.value || 0));
    if (e.target.classList.contains('pos-price-input')) item.unit_price = Math.max(0, Number(e.target.value || 0));
    const subtotal = posCart.reduce((s, x) => s + Number(x.quantity || 0) * Number(x.unit_price || 0), 0);
    const total = Math.max(0, subtotal - Number(posDiscount || 0) + Number(posTax || 0));
    if ($('#pos-subtotal-val')) $('#pos-subtotal-val').textContent = money(subtotal);
    if ($('#pos-total-val')) $('#pos-total-val').textContent = money(total) + ' ' + posCurrency;
  });

  $('#pos-customer-input')?.addEventListener('input', e => {
    posCustomerName = e.target.value;
    const match = salePartyMatches(posCustomerName, cachedParties);
    posPartyId = match?.id || '';
    if (match && match.phone) {
      posCustomerPhone = match.phone;
      if ($('#pos-phone-input')) $('#pos-phone-input').value = match.phone;
    }
  });

  $('#pos-phone-input')?.addEventListener('input', e => { posCustomerPhone = e.target.value; });
  $('#pos-settlement-select')?.addEventListener('change', e => {
    posSettlement = e.target.value;
    if ($('#pos-cash-select')) $('#pos-cash-select').disabled = posSettlement === 'credit';
  });
  $('#pos-discount-input')?.addEventListener('input', e => {
    posDiscount = Number(e.target.value || 0);
    renderPosCart();
  });
}

async function submitPosSale() {
  if (!posCart.length) { toast('السلة فارغة — أضف صنفاً واحداً على الأقل', true); return; }
  if (posSettlement === 'credit' && !posPartyId) {
    toast('للبيع الآجل يرجى اختيار عميل مسجل من القائمة', true);
    return;
  }
  const cashId = $('#pos-cash-select')?.value || null;
  const notes = [
    posCustomerName ? `اسم العميل: ${posCustomerName}` : '',
    posCustomerPhone ? `هاتف العميل: ${posCustomerPhone}` : '',
    'نقطة البيع المباشرة POS'
  ].filter(Boolean).join('\n');

  const payload = {
    doc_type: 'sale',
    document_date: new Date().toISOString().slice(0, 10),
    currency: posCurrency,
    exchange_rate: 1,
    settlement_method: posSettlement,
    cash_account_id: posSettlement === 'credit' ? null : cashId,
    party_id: posPartyId || null,
    discount: Number(posDiscount || 0),
    tax: Number(posTax || 0),
    notes,
    lines: posCart.map(l => ({
      product_id: l.product_id,
      unit_id: l.unit_id,
      quantity: Number(l.quantity),
      unit_price: Number(l.unit_price),
      ...(canFinance() && l.purchase_price !== '' ? { purchase_unit_price: Number(l.purchase_price) } : {})
    }))
  };

  const btnEl = $('#pos-checkout-btn');
  if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'جارٍ الترحيل…'; }
  const { data: docId, error } = await supabase.rpc('post_document', { p_payload: payload });
  if (btnEl) { btnEl.disabled = false; btnEl.textContent = '⚡ ترحيل الفاتورة وطباعة الإيصال'; }
  if (error) { toast(error.message, true); return; }

  posCart = [];
  posDiscount = 0;
  posCustomerName = '';
  posCustomerPhone = '';
  posPartyId = '';
  cachedProducts = [];
  toast('تم ترحيل فاتورة نقطة البيع بنجاح');
  await renderPage();
  await viewDocument(docId);
}

/* ============================================================================
   WINDOWS 4 & 6: SALES & PURCHASES DOCUMENTS + RETURNS
   ============================================================================ */
async function documentsPage(type) {
  const types = type === 'sale' ? ['sale', 'sale_return'] : ['purchase', 'purchase_return'];
  let docs = [];
  try {
    docs = await queryOrThrow(supabase.from('documents').select('id,doc_no,doc_type,document_date,party_id,total,currency,settlement_method,status,notes,parties(name)').in('doc_type', types).order('created_at', { ascending: false }).limit(200));
  } catch (_e) {
    docs = await queryOrThrow(supabase.from('documents').select('id,doc_no,doc_type,document_date,party_id,total,currency,settlement_method,status,notes,parties(name)').eq('doc_type', type).order('created_at', { ascending: false }).limit(200));
  }

  const rows = docs.map(x => `
    <tr data-doc-type="${x.doc_type}" data-settlement="${x.settlement_method}">
      <td><b>${escapeHtml(x.doc_no)}</b></td>
      <td><span class="badge ${docBadgeClass(x.doc_type)}">${docTypeLabel(x.doc_type)}</span></td>
      <td>${escapeHtml(x.document_date)}</td>
      <td>${escapeHtml(x.parties?.name || noteField(x.notes, 'اسم العميل') || (type === 'sale' ? 'عميل نقدي' : '—'))}</td>
      <td><span class="badge ${x.settlement_method === 'cash' ? '' : 'gold'}">${x.settlement_method === 'cash' ? 'نقدي' : 'آجل'}</span></td>
      <td><b>${money(x.total)} ${x.currency}</b></td>
      <td><button class="mini" type="button" data-action="view-doc" data-id="${x.id}">تفاصيل / طباعة</button></td>
    </tr>`).join('');

  return `
    <div class="section-head">
      <div>
        <h2>سجل ${type === 'sale' ? 'فواتير المبيعات ومرتجعاتها' : 'فواتير المشتريات ومرتجعاتها'}</h2>
        <div class="hint">كل فاتورة أو مرتجع يُرحّل ذرياً إلى المخزون ودفتر القيود المزدوجة في عملية واحدة.</div>
      </div>
      <div class="toolbar">
        <input class="control" id="table-search" placeholder="🔍 بحث برقم الفاتورة أو اسم الطرف…">
        ${type === 'sale'
          ? `${btn('↩ مرتجع مبيعات', 'new-sale-return', 'light')}${btn('＋ فاتورة مبيعات جديدة', 'new-sale', 'gold')}`
          : `${btn('↩ مرتجع مشتريات', 'new-purchase-return', 'light')}${btn('＋ فاتورة مشتريات جديدة', 'new-purchase')}`}
      </div>
    </div>
    <div id="data-table">${table(['رقم المستند', 'نوع العملية', 'التاريخ', type === 'sale' ? 'العميل' : 'المورد', 'طريقة السداد', 'الإجمالي', 'إجراء'], rows)}</div>`;
}

/* ============================================================================
   WINDOW 7: ITEMS, MULTI-UNITS, STOCK CARD & INVENTORY ADJUSTMENTS
   ============================================================================ */
async function itemsPage() {
  const p = await loadProducts();
  const inv = await loadInventorySummary();
  const qty = new Map(inv.map(x => [x.id, Number(x.quantity || 0)]));

  const desktopRows = p.map(x => {
    const q = qty.get(x.id) || 0;
    const isLow = q <= Number(x.reorder_level || 0);
    const unitsSummary = (x.units || []).map(u => `${u.unit_name} (${money(u.sale_price)})`).join(' · ');
    return `
      <tr>
        <td><b>${escapeHtml(x.sku || '—')}</b></td>
        <td><b>${escapeHtml(x.name)}</b><br><small class="muted">${escapeHtml(unitsSummary)}</small></td>
        <td>${escapeHtml(x.category || '—')}</td>
        <td>${escapeHtml(x.base_unit)}</td>
        <td>
          <b>${money(q)} ${escapeHtml(x.base_unit)}</b>
          ${canFinance() ? `<button class="mini" type="button" data-action="open-stock-qty-modal" data-id="${escapeHtml(x.id)}">📦 تعديل الكمية</button>` : ''}
        </td>
        ${canFinance() ? `<td>${money(x.avg_cost_base)}</td><td><b>${money(q * Number(x.avg_cost_base || 0))}</b></td>` : ''}
        <td><span class="badge ${q <= 0 ? 'red' : isLow ? 'warn' : ''}">${q <= 0 ? 'نافد' : isLow ? 'منخفض' : 'متوفر'}</span></td>
        <td class="actions">
          <button class="mini" type="button" data-action="view-stock-card" data-id="${escapeHtml(x.id)}">كارت الصنف</button>
          ${canFinance() ? `<button class="mini gold" type="button" data-action="edit-product" data-id="${escapeHtml(x.id)}">تعديل</button>` : ''}
        </td>
      </tr>`;
  }).join('');

  const mobileCards = p.map(x => {
    const q = qty.get(x.id) || 0;
    const isLow = q <= Number(x.reorder_level || 0);
    const status = q <= 0 ? 'نافد' : isLow ? 'منخفض' : 'متوفر';
    const statusClass = q <= 0 ? 'red' : isLow ? 'warn' : '';
    const units = (x.units || []).map(u => `${u.unit_name} (${money(u.sale_price)})`).join(' · ');
    const searchable = [x.sku, x.name, x.category, x.base_unit, units].filter(Boolean).join(' ');
    return `
      <article class="item-mobile-card" data-item-card data-search="${escapeHtml(searchable)}">
        <div class="item-mobile-main">
          <div class="item-mobile-copy">
            <strong class="item-mobile-name">${escapeHtml(x.name)}</strong>
            <div class="item-mobile-meta">
              <span>${escapeHtml(x.base_unit || '—')}</span>
              ${x.category ? `<span>${escapeHtml(x.category)}</span>` : ''}
              ${x.sku ? `<span class="item-mobile-sku">${escapeHtml(x.sku)}</span>` : ''}
            </div>
            ${units ? `<div class="item-mobile-units">${escapeHtml(units)}</div>` : ''}
          </div>
          <div class="item-mobile-stock">
            <b>${money(q)}</b>
            <small>${escapeHtml(x.base_unit || 'وحدة')}</small>
            <span class="badge ${statusClass}">${status}</span>
          </div>
        </div>
        <div class="item-mobile-actions">
          ${canFinance() ? `<button class="mini" type="button" data-action="open-stock-qty-modal" data-id="${escapeHtml(x.id)}">📦 الكمية</button>` : ''}
          <button class="mini" type="button" data-action="view-stock-card" data-id="${escapeHtml(x.id)}">▤ حركة الصنف</button>
          ${canFinance() ? `<button class="mini gold" type="button" data-action="edit-product" data-id="${escapeHtml(x.id)}">✎ تعديل</button>` : ''}
        </div>
      </article>`;
  }).join('');

  return `
    <div class="items-page">
      <div class="section-head items-section-head">
        <div class="items-heading">
          <h2>الأصناف والمخزون</h2>
          <div class="hint">${canFinance() ? 'إدارة الأصناف والوحدات والأسعار والأرصدة.' : 'استعراض الأصناف والوحدات والأرصدة المتاحة.'}</div>
        </div>
        <div class="items-toolbar">
          <label class="items-search-wrap" for="table-search">
            <span aria-hidden="true">🔍</span>
            <input class="control items-search" id="table-search" type="search" autocomplete="off" placeholder="ابحث باسم الصنف أو الباركود أو التصنيف…" aria-label="البحث في الأصناف">
          </label>
          ${canFinance() ? `
            <div class="items-actions" aria-label="إجراءات الأصناف">
              <button class="btn" type="button" data-action="new-product">＋ إضافة صنف</button>
              <button class="btn gold" type="button" data-action="import-items">⇧ استيراد ملف</button>
              <button class="btn light" type="button" data-action="download-items-template">⬇ قالب الاستيراد</button>
              <button class="btn light" type="button" data-action="new-stock-adjustment">⚖️ تسوية الجرد</button>
            </div>
          ` : ''}
        </div>
      </div>
      <div id="data-table" class="items-data-region">
        <div class="items-desktop-table">${table(
          canFinance()
            ? ['الرمز / SKU', 'الصنف والوحدات المسعرة', 'التصنيف', 'الوحدة الأساسية', 'الرصيد الحالي', 'متوسط التكلفة', 'قيمة المخزون', 'الحالة', 'إجراءات']
            : ['الرمز / SKU', 'الصنف والوحدات المسعرة', 'التصنيف', 'الوحدة الأساسية', 'الرصيد الحالي', 'الحالة', 'إجراءات'],
          desktopRows
        )}</div>
        <div class="items-mobile-list" aria-label="قائمة الأصناف على الهاتف">
          ${mobileCards || '<div class="items-empty">لا توجد أصناف مسجلة حالياً.</div>'}
          <div class="items-no-results" hidden>لا توجد أصناف تطابق عبارة البحث.</div>
        </div>
      </div>
    </div>`;
}

async function openStockCard(productId) {
  if (isPersistentOfflineSession()) { toast('كارت الحركات التفصيلي غير مخزن محلياً حالياً؛ ستتوفر بياناته بعد الاتصال.', true); return; }
  const products = await loadProducts();
  const prod = products.find(p => p.id === productId);
  if (!prod) return;
  let movements = [];
  try {
    movements = await queryOrThrow(supabase.from('stock_movements').select('*').eq('product_id', productId).order('created_at', { ascending: true }));
  } catch (_e) {
    toast('لا تملك صلاحية قراءة الحركات التفصيلية أو تعذر التحميل', true);
    return;
  }
  let running = 0;
  const rows = movements.map(m => {
    const qIn = Number(m.quantity_in || 0), qOut = Number(m.quantity_out || 0);
    running += qIn - qOut;
    const typeLbl = { purchase: 'توريد مشتريات', sale: 'صرف مبيعات', adjustment_in: 'إدخال / افتتاحي / مرتجع', adjustment_out: 'إخراج / تسوية عجز' }[m.movement_type] || m.movement_type;
    return `
      <tr>
        <td>${escapeHtml(String(m.created_at || '').slice(0, 10))}</td>
        <td><span class="badge ${qIn > 0 ? '' : 'warn'}">${typeLbl}</span></td>
        <td>${qIn > 0 ? '+' + money(qIn, 4) : '—'}</td>
        <td>${qOut > 0 ? '-' + money(qOut, 4) : '—'}</td>
        <td>${canFinance() ? money(m.unit_cost_base, 2) : '—'}</td>
        <td><b>${money(running, 4)} ${escapeHtml(prod.base_unit)}</b></td>
      </tr>`;
  }).join('');

  modal(`كارت حركة الصنف: ${prod.name}`, `
    <div class="cards" style="grid-template-columns:repeat(3,1fr);margin-bottom:14px">
      <div class="card metric"><small>الوحدة الأساسية</small><strong>${escapeHtml(prod.base_unit)}</strong></div>
      <div class="card metric gold-top"><small>الرصيد الدفتري الحالي</small><strong>${money(running, 4)}</strong></div>
      <div class="card metric blue-top"><small>متوسط التكلفة</small><strong>${canFinance() ? money(prod.avg_cost_base) + ' ر.ي' : 'محمي'}</strong></div>
    </div>
    ${table(['التاريخ', 'نوع الحركة', 'وارد (+)', 'صادر (-)', 'تكلفة الوحدة', 'الرصيد التراكمي'], rows)}
    <div class="form-actions"><button class="btn light" type="button" data-action="close-modal">إغلاق</button></div>
  `);
}

async function openStockAdjustment() {
  if (!canFinance()) return;
  const products = await loadProducts();
  if (!products.length) { toast('أضف الأصناف أولاً', true); return; }
  modal('تسوية جرد مخزني (فائض / عجز أو تالف)', `
    <form id="stock-adj-form" class="form-grid">
      ${selectField('الصنف', 'product_id', products.map(p => ({ value: p.id, label: `${p.name} (${p.base_unit})` })), products[0].id, true)}
      ${selectField('نوع التسوية', 'direction', [
        { value: 'in', label: '➕ إضافة للمخزون (فائض جرد)' },
        { value: 'out', label: '➖ خصم من المخزون (عجز جرد / تالف)' }
      ], 'in')}
      ${field('الكمية (بالوحدة الأساسية)', 'quantity_base', '1', 'number', { step: '0.0001', min: '0.0001', required: true })}
      ${field('تكلفة الوحدة الأساسية (ريال يمني)', 'unit_cost_base', products[0].avg_cost_base || 0, 'number', { step: '0.01', min: '0.01', required: true })}
      ${field('بيان وسبب التسوية', 'notes', 'تسوية جرد مخزني دوري', 'text', { required: true })}
      <div class="field full"><div class="hint">ينشئ النظام حركة مخزنية وقيداً محاسبياً مزدوجاً بين حساب المخزون (1200) وحساب فروقات وتسويات الجرد (5200).</div></div>
      <div class="field full form-actions">
        <button class="btn" type="submit">حفظ وترحيل التسوية</button>
        <button class="btn light" type="button" data-action="close-modal">إلغاء</button>
      </div>
    </form>`);
  const form = $('#stock-adj-form');
  form.elements.product_id.addEventListener('change', () => {
    const p = products.find(x => x.id === form.elements.product_id.value);
    if (p) form.elements.unit_cost_base.value = p.avg_cost_base || 0;
  });
  form.onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    const { error } = await supabase.rpc('post_stock_adjustment', { p_payload: d });
    if (error) { toast(error.message, true); return; }
    closeModal();
    cachedProducts = [];
    toast('تم ترحيل تسوية الجرد المخزني والقيد المحاسبي بنجاح');
    await renderPage();
  };
}

/* ============================================================================
   WINDOWS 8 & 9: CUSTOMERS, SUPPLIERS & PARTY ACCOUNT STATEMENT
   ============================================================================ */
async function partiesPage(kind) {
  const [all, balMap] = await Promise.all([loadParties(), loadPartyBalancesMap()]);
  const p = all.filter(x => x.party_type === kind || x.party_type === 'both');
  const rows = p.map(x => {
    const netBase = balMap.get(x.id) || 0;
    const statusText = netBase > 0.01 ? `${money(netBase)} ر.ي (عليه / مدين)` : netBase < -0.01 ? `${money(Math.abs(netBase))} ر.ي (له / دائن)` : '0 (مسدد)';
    return `
      <tr>
        <td><b>${escapeHtml(x.name)}</b></td>
        <td>${escapeHtml(x.phone || '—')}</td>
        <td>${escapeHtml(x.address || '—')}</td>
        ${canFinance() ? `
          <td>${money(x.opening_balance)} ${escapeHtml(x.opening_currency || 'YER')}</td>
          <td><span class="badge ${netBase > 0.01 ? 'gold' : netBase < -0.01 ? 'blue' : ''}">${statusText}</span></td>
          <td class="actions">
            <button class="mini" type="button" data-action="view-party-statement" data-id="${x.id}">📄 كشف حساب</button>
            <button class="mini gold" type="button" data-action="edit-party" data-kind="${kind}" data-id="${x.id}">تعديل</button>
          </td>
        ` : ''}
      </tr>`;
  }).join('');

  const name = kind === 'customer' ? 'العملاء والذمم المدينة' : 'الموردون والذمم الدائنة';
  return `
    <div class="section-head">
      <div>
        <h2>${name}</h2>
        <div class="hint">${canFinance() ? 'متابعة الأرصدة الحية من دفتر الأستاذ واستخراج كشف حساب تفصيلي قابل للطباعة والمشاركة.' : 'دليل العملاء المعتمدين لنقطة البيع.'}</div>
      </div>
      <div class="toolbar">
        <input class="control" id="table-search" placeholder="🔍 بحث بالاسم أو الهاتف أو العنوان…">
        ${canFinance() ? `<button class="btn" type="button" data-action="new-party" data-kind="${kind}">＋ إضافة ${kind === 'customer' ? 'عميل' : 'مورد'}</button>` : ''}
      </div>
    </div>
    <div id="data-table">${table(
      canFinance()
        ? ['الاسم', 'رقم الهاتف', 'العنوان', 'الرصيد الافتتاحي', 'الرصيد الدفتري الحالي', 'إجراءات']
        : ['الاسم', 'رقم الهاتف', 'العنوان'],
      rows
    )}</div>`;
}

async function openPartyStatement(partyId) {
  const parties = await loadParties();
  const party = parties.find(p => p.id === partyId);
  if (!party) return;
  const lines = await queryOrThrow(supabase.from('journal_lines').select('*,journal_entries(entry_no,entry_date,description)').eq('party_id', partyId));
  lines.sort((a, b) => String(a.journal_entries?.entry_date || '').localeCompare(String(b.journal_entries?.entry_date || '')));

  let running = 0;
  let totalD = 0, totalC = 0;
  const rows = lines.map(l => {
    const d = Number(l.debit_base || 0), c = Number(l.credit_base || 0);
    totalD += d;
    totalC += c;
    running += d - c;
    return `
      <tr>
        <td>${escapeHtml(l.journal_entries?.entry_date || '—')}</td>
        <td><b>${escapeHtml(l.journal_entries?.entry_no || '—')}</b></td>
        <td>${escapeHtml(l.memo || l.journal_entries?.description || '')}</td>
        <td>${d > 0 ? money(d) : '—'}</td>
        <td>${c > 0 ? money(c) : '—'}</td>
        <td><b>${money(running)} ر.ي</b></td>
      </tr>`;
  }).join('');

  modal(`كشف حساب: ${party.name}`, `
    <div class="saved-invoice" id="party-statement-printable">
      <div class="saved-invoice-head">
        <div>
          <b>محلات الشيباني للبهارات والأعشاب الطبيعية</b>
          <h2>كشف حساب تفصيلي (${party.party_type === 'supplier' ? 'مورد' : 'عميل'})</h2>
          <small>${escapeHtml(party.name)} · الهاتف: ${escapeHtml(party.phone || '—')}</small>
        </div>
        <img src="${LOGO_SRC}" alt="شعار الشيباني">
      </div>
      <div class="saved-invoice-meta">
        <div><small>إجمالي المدين (عليه)</small><b>${money(totalD)} ر.ي</b></div>
        <div><small>إجمالي الدائن (له)</small><b>${money(totalC)} ر.ي</b></div>
        <div><small>الرصيد الختامي الصافي</small><b>${money(running)} ر.ي</b></div>
        <div><small>حالة الذمة</small><b>${running > 0.01 ? 'مستحق لنا (مدين)' : running < -0.01 ? 'مستحق علينا (دائن)' : 'مسدد بالكامل'}</b></div>
      </div>
      ${table(['التاريخ', 'رقم القيد', 'البيان والتفاصيل', 'مدين (ر.ي)', 'دائن (ر.ي)', 'الرصيد التراكمي'], rows)}
    </div>
    <div class="saved-invoice-actions">
      <button class="btn" type="button" data-action="print-current-modal">🖨️ طباعة كشف الحساب</button>
      <button class="btn light" type="button" data-action="close-modal">إغلاق</button>
    </div>
  `, true);
}

/* ============================================================================
   WINDOW 10 & 11: EXPENSES, CASH BOXES, VOUCHERS & TRANSFERS
   ============================================================================ */
async function moneyDocumentsPage(type) {
  const docs = await queryOrThrow(supabase.from('documents').select('id,doc_no,document_date,total,currency,settlement_method,notes,parties(name)').eq('doc_type', type).order('created_at', { ascending: false }).limit(200));
  const rows = docs.map(x => `
    <tr>
      <td><b>${escapeHtml(x.doc_no)}</b></td>
      <td>${escapeHtml(x.document_date)}</td>
      <td>${escapeHtml(x.notes || '—')}</td>
      <td><span class="badge ${x.settlement_method === 'cash' ? '' : 'gold'}">${x.settlement_method === 'cash' ? 'نقدي' : 'آجل'}</span></td>
      <td><b>${money(x.total)} ${x.currency}</b></td>
      <td>${escapeHtml(x.parties?.name || 'مصروف مباشر')}</td>
      <td><button class="mini" type="button" data-action="view-doc" data-id="${x.id}">عرض / طباعة السند</button></td>
    </tr>`).join('');

  return `
    <div class="section-head">
      <div>
        <h2>سجل المصروفات التشغيلية والإدارية</h2>
        <div class="hint">تسجيل المصروف ينشئ قيداً مديناً على حساب المصروف المحدد ودائناً على الصندوق أو ذمة المورد.</div>
      </div>
      <div class="toolbar">
        <input class="control" id="table-search" placeholder="🔍 بحث في المصروفات…">
        ${btn('＋ تسجيل مصروف جديد', 'new-expense')}
      </div>
    </div>
    <div id="data-table">${table(['رقم السند', 'التاريخ', 'البيان', 'طريقة السداد', 'المبلغ', 'الطرف', 'إجراء'], rows)}</div>`;
}

async function cashPage() {
  const [cash, docs, balances] = await Promise.all([
    loadCash(),
    queryOrThrow(supabase.from('documents').select('id,doc_no,doc_type,document_date,total,currency,party_id,notes,parties(name)').in('doc_type', ['receipt', 'payment']).order('created_at', { ascending: false }).limit(100)),
    queryOrThrow(supabase.from('v_cash_balances').select('id,foreign_balance'))
  ]);

  return `
    <div class="section-head">
      <div>
        <h2>الصناديق وسندات القبض والصرف والتحويلات</h2>
        <div class="hint">إدارة السيولة النقدية متعددة العملات، سندات القبض من العملاء، سندات الصرف للموردين، والتحويل بين الصناديق.</div>
      </div>
      <div class="toolbar">
        ${btn('رصيد افتتاحي', 'opening-cash', 'light')}
        ${btn('⇄ تحويل بين الصناديق', 'new-cash-transfer', 'outline')}
        ${btn('＋ سند قبض', 'new-receipt')}
        ${btn('＋ سند صرف', 'new-payment', 'gold')}
      </div>
    </div>
    <div class="cards" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      ${cash.map(x => {
        const a = balances.find(z => z.id === x.id);
        return `
          <div class="card metric">
            <div class="metric-head"><small>${escapeHtml(x.name)}</small><span class="metric-icon">🏦</span></div>
            <div class="summary">${money(a?.foreign_balance || 0)} ${x.currency}</div>
            <span class="hint">الرصيد الفعلي المطابق لدفتر الأستاذ</span>
          </div>`;
      }).join('')}
    </div>
    <div class="section-head">
      <h2>سجل سندات القبض والصرف</h2>
      <input class="control" id="table-search" style="max-width:260px" placeholder="🔍 بحث برقم السند أو الطرف…">
    </div>
    <div id="data-table">${table(['رقم السند', 'نوع السند', 'التاريخ', 'الطرف (العميل / المورد)', 'البيان', 'المبلغ', 'إجراء'],
      docs.map(x => `
        <tr>
          <td><b>${escapeHtml(x.doc_no)}</b></td>
          <td><span class="badge ${docBadgeClass(x.doc_type)}">${docTypeLabel(x.doc_type)}</span></td>
          <td>${escapeHtml(x.document_date)}</td>
          <td>${escapeHtml(x.parties?.name || '—')}</td>
          <td>${escapeHtml(x.notes || '—')}</td>
          <td><b>${money(x.total)} ${x.currency}</b></td>
          <td><button class="mini" type="button" data-action="view-doc" data-id="${x.id}">عرض / طباعة السند</button></td>
        </tr>`).join('')
    )}</div>`;
}

async function openCashTransfer() {
  const cash = await loadCash();
  if (cash.length < 2) { toast('يتطلب التحويل وجود صندوقين على الأقل', true); return; }
  modal('تحويل سيولة بين الصناديق / مصارفة عملات', `
    <form id="cash-transfer-form" class="form-grid">
      ${selectField('من صندوق (سحب دائن)', 'from_cash_id', cash.map(c => ({ value: c.id, label: `${c.name} (${c.currency})` })), cash[0].id)}
      ${selectField('إلى صندوق (إيداع مدين)', 'to_cash_id', cash.map(c => ({ value: c.id, label: `${c.name} (${c.currency})` })), cash[1]?.id || cash[0].id)}
      ${field('المبلغ المسحوب (بعملة صندوق المصدر)', 'from_amount', '100', 'number', { step: '0.01', min: '0.01', required: true })}
      ${field('المبلغ المودع (بعملة صندوق الوجهة)', 'to_amount', '53800', 'number', { step: '0.01', min: '0.01', required: true })}
      ${field('القيمة المعادلة بالعملة الأساسية (YER)', 'base_amount', '53800', 'number', { step: '0.01', min: '0.01', required: true })}
      ${field('البيان والملاحظات', 'notes', 'تحويل سيولة / مصارفة بين الصناديق', 'text', { required: true })}
      <div class="field full"><div class="hint">ينشئ النظام قيداً يومياً متوازناً يخفض رصيد الصندوق المصدر ويزيد رصيد الصندوق المستلم.</div></div>
      <div class="field full form-actions">
        <button class="btn" type="submit">حفظ وترحيل التحويل</button>
        <button class="btn light" type="button" data-action="close-modal">إلغاء</button>
      </div>
    </form>`);
  $('#cash-transfer-form').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const { error } = await supabase.rpc('post_cash_transfer', { p_payload: d });
    if (error) { toast(error.message, true); return; }
    closeModal();
    toast('تم ترحيل التحويل بين الصناديق بنجاح');
    await renderPage();
  };
}

async function openCashOpening() {
  const cash = await loadCash();
  modal('إدخال رصيد افتتاحي للصندوق', `
    <form id="opening-cash-form" class="form-grid">
      ${selectField('الصندوق', 'cash_account_id', cash.map(x => ({ value: x.id, label: `${x.name} · ${x.currency}` })), cash[0]?.id || '')}
      ${field('المبلغ الافتتاحي', 'amount', '', 'number', { step: '0.01', min: 0, required: true })}
      <div class="field full"><div class="hint">يُرحّل المبلغ كمدين على الصندوق ودائن على رأس المال.</div></div>
      <div class="field full form-actions"><button class="btn" type="submit">حفظ وترحيل الرصيد</button></div>
    </form>`);
  $('#opening-cash-form').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const r = await supabase.rpc('set_opening_cash_balance', { p_cash_account_id: d.cash_account_id, p_amount: Number(d.amount) });
    if (r.error) { toast(r.error.message, true); return; }
    closeModal();
    toast('تم ترحيل رصيد الصندوق الافتتاحي');
    await renderPage();
  };
}

/* ============================================================================
   WINDOW 12: JOURNAL ENTRIES, MANUAL JOURNAL & CHART OF ACCOUNTS + LEDGER
   ============================================================================ */
async function journalPage() {
  const [entries, accounts] = await Promise.all([
    queryOrThrow(supabase.from('journal_entries').select('id,entry_no,entry_date,description,document_id').order('created_at', { ascending: false }).limit(150)),
    queryOrThrow(supabase.from('accounts').select('id,code,name,account_type,normal_side,is_system,active').order('code'))
  ]);

  return `
    <div class="section-head">
      <div>
        <h2>دفتر القيود اليومية ودليل الحسابات الشجري</h2>
        <div class="hint">تُرحّل القيود آلياً من الفواتير والسندات، كما يمكن للمدير والمحاسب إثبات قيود التسوية اليومية اليدوية المتوازنة.</div>
      </div>
      <div class="toolbar">
        ${canFinance() ? btn('＋ قيد يومية يدوي متوازن', 'new-manual-journal', 'gold') : ''}
        ${canManage() ? btn('＋ إضافة حساب للدليل', 'new-account') : ''}
      </div>
    </div>
    <div class="grid-two">
      <div class="panel">
        <div class="section-head" style="margin-top:0">
          <h2>دفتر القيود اليومية (${entries.length})</h2>
          <input class="control" id="table-search" style="max-width:220px" placeholder="🔍 بحث برقم القيد أو البيان…">
        </div>
        <div id="data-table">${table(['رقم القيد', 'التاريخ', 'البيان المحاسبي', 'إجراء'],
          entries.map(x => `
            <tr>
              <td><b>${escapeHtml(x.entry_no)}</b></td>
              <td>${escapeHtml(x.entry_date)}</td>
              <td>${escapeHtml(x.description)}</td>
              <td><button class="mini" type="button" data-action="view-journal" data-id="${x.id}">عرض القيد</button></td>
            </tr>`).join('')
        )}</div>
      </div>

      <div class="panel">
        <h2>دليل الحسابات المعتمد</h2>
        <div style="margin-top:12px">${table(['الرمز', 'اسم الحساب', 'التصنيف', 'الطبيعة', 'إجراءات'],
          accounts.map(x => `
            <tr>
              <td><b>${escapeHtml(x.code)}</b></td>
              <td>${escapeHtml(x.name)} ${x.is_system ? '<span class="badge">أساسي</span>' : ''}</td>
              <td>${({ asset: 'أصول', liability: 'التزامات', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات' }[x.account_type] || x.account_type)}</td>
              <td>${x.normal_side === 'debit' ? 'مدين' : 'دائن'}</td>
              <td class="actions">
                <button class="mini" type="button" data-action="view-account-ledger" data-id="${x.id}">دفتر الأستاذ</button>
                ${canManage() && !x.is_system ? `<button class="mini gold" type="button" data-action="edit-account" data-id="${x.id}">تعديل</button>` : ''}
              </td>
            </tr>`).join('')
        )}</div>
      </div>
    </div>`;
}

async function openManualJournal() {
  if (!canFinance()) return;
  const accounts = await queryOrThrow(supabase.from('accounts').select('id,code,name').eq('active', true).order('code'));
  const accOpts = accounts.map(a => `<option value="${a.id}">${escapeHtml(a.code + ' - ' + a.name)}</option>`).join('');

  modal('إثبات قيد يومية يدوي متوازن', `
    <form id="manual-journal-form">
      <div class="form-grid">
        ${field('تاريخ القيد', 'entry_date', new Date().toISOString().slice(0, 10), 'date', { required: true })}
        ${field('بيان القيد اليومي', 'description', '', 'text', { required: true, placeholder: 'مثال: تسوية عهدة / قيد إقفال أو تصحيح' })}
      </div>
      <div class="section-head">
        <h3>سطور القيد (بالعملة الأساسية YER)</h3>
        <button class="btn light" type="button" id="add-mje-line-btn">＋ إضافة سطر قيد</button>
      </div>
      <div class="table-wrap">
        <table id="mje-lines-table">
          <thead><tr><th>الحساب المحاسبي</th><th>مدين (Debit)</th><th>دائن (Credit)</th><th>البيان الفرعي</th><th></th></tr></thead>
          <tbody id="mje-lines-body">
            <tr>
              <td><select class="control mje-acc">${accOpts}</select></td>
              <td><input class="control mje-debit" type="number" min="0" step="0.01" value="10000"></td>
              <td><input class="control mje-credit" type="number" min="0" step="0.01" value="0"></td>
              <td><input class="control mje-memo" placeholder="بيان السطر"></td>
              <td></td>
            </tr>
            <tr>
              <td><select class="control mje-acc">${accOpts}</select></td>
              <td><input class="control mje-debit" type="number" min="0" step="0.01" value="0"></td>
              <td><input class="control mje-credit" type="number" min="0" step="0.01" value="10000"></td>
              <td><input class="control mje-memo" placeholder="بيان السطر"></td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="total-box">
        <span id="mje-totals-label">إجمالي المدين: 10,000 · إجمالي الدائن: 10,000</span>
        <strong id="mje-balance-badge">متوازن ✓</strong>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">حفظ وترحيل القيد اليومي</button>
        <button class="btn light" type="button" data-action="close-modal">إلغاء</button>
      </div>
    </form>`, true);

  const recalcMje = () => {
    let d = 0, c = 0;
    $$('#mje-lines-body tr').forEach(tr => {
      d += Number($('.mje-debit', tr)?.value || 0);
      c += Number($('.mje-credit', tr)?.value || 0);
    });
    $('#mje-totals-label').textContent = `إجمالي المدين: ${money(d)} · إجمالي الدائن: ${money(c)} · الفرق: ${money(Math.abs(d - c))}`;
    const balanced = d > 0 && Math.abs(d - c) < 0.01;
    $('#mje-balance-badge').textContent = balanced ? 'متوازن ✓' : 'غير متوازن ⚠️';
    $('#mje-balance-badge').style.color = balanced ? 'var(--green)' : 'var(--red)';
  };

  $('#add-mje-line-btn').onclick = () => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><select class="control mje-acc">${accOpts}</select></td>
      <td><input class="control mje-debit" type="number" min="0" step="0.01" value="0"></td>
      <td><input class="control mje-credit" type="number" min="0" step="0.01" value="0"></td>
      <td><input class="control mje-memo" placeholder="بيان السطر"></td>
      <td><button type="button" class="mini red mje-del">×</button></td>`;
    $('#mje-lines-body').append(tr);
  };

  $('#mje-lines-body').addEventListener('input', recalcMje);
  $('#mje-lines-body').addEventListener('click', e => {
    if (e.target.classList.contains('mje-del')) {
      e.target.closest('tr').remove();
      recalcMje();
    }
  });

  $('#manual-journal-form').onsubmit = async e => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const lines = [];
    $$('#mje-lines-body tr').forEach(tr => {
      const debit_base = Number($('.mje-debit', tr).value || 0);
      const credit_base = Number($('.mje-credit', tr).value || 0);
      if (debit_base > 0 || credit_base > 0) {
        lines.push({
          account_id: $('.mje-acc', tr).value,
          debit_base,
          credit_base,
          memo: $('.mje-memo', tr).value
        });
      }
    });
    const { error } = await supabase.rpc('post_manual_journal_entry', {
      p_payload: { entry_date: fd.entry_date, description: fd.description, lines }
    });
    if (error) { toast(error.message, true); return; }
    closeModal();
    toast('تم حفظ وترحيل القيد اليومي بنجاح');
    await renderPage();
  };
}

async function openAccountLedger(accountId) {
  const accs = await queryOrThrow(supabase.from('accounts').select('*').eq('id', accountId));
  const acc = accs[0];
  if (!acc) return;
  const lines = await queryOrThrow(supabase.from('journal_lines').select('*,journal_entries(entry_no,entry_date,description),parties(name)').eq('account_id', accountId));
  lines.sort((a, b) => String(a.journal_entries?.entry_date || '').localeCompare(String(b.journal_entries?.entry_date || '')));

  let running = 0;
  const rows = lines.map(l => {
    const d = Number(l.debit_base || 0), c = Number(l.credit_base || 0);
    running += acc.normal_side === 'debit' ? (d - c) : (c - d);
    return `
      <tr>
        <td>${escapeHtml(l.journal_entries?.entry_date || '—')}</td>
        <td><b>${escapeHtml(l.journal_entries?.entry_no || '—')}</b></td>
        <td>${escapeHtml(l.memo || l.journal_entries?.description || '')}</td>
        <td>${escapeHtml(l.parties?.name || '—')}</td>
        <td>${d > 0 ? money(d) : '—'}</td>
        <td>${c > 0 ? money(c) : '—'}</td>
        <td><b>${money(running)} ر.ي</b></td>
      </tr>`;
  }).join('');

  modal(`دفتر الأستاذ العام: ${acc.code} - ${acc.name}`, `
    ${table(['التاريخ', 'رقم القيد', 'البيان', 'الطرف المرتبط', 'مدين (ر.ي)', 'دائن (ر.ي)', 'الرصيد التراكمي'], rows)}
    <div class="total-box"><span>طبيعة الحساب: ${acc.normal_side === 'debit' ? 'مدين' : 'دائن'}</span><strong>الرصيد الختامي: ${money(running)} ر.ي</strong></div>
    <div class="form-actions"><button class="btn" type="button" data-action="print-current-modal">🖨️ طباعة كشف الحساب</button><button class="btn light" type="button" data-action="close-modal">إغلاق</button></div>
  `, true);
}

async function openAccountForm(id = null) {
  if (!canManage()) return;
  let old = null;
  if (id) {
    const r = await supabase.from('accounts').select('*').eq('id', id).single();
    if (r.error) { toast(r.error.message, true); return; }
    old = r.data;
    if (old.is_system) { toast('الحسابات الأساسية للنظام محمية ولا يمكن تعديلها هنا', true); return; }
  }
  const parents = await queryOrThrow(supabase.from('accounts').select('id,code,name').eq('active', true).order('code'));
  const opts = [{ value: '', label: 'بدون حساب رئيسي' }, ...parents.filter(x => x.id !== id).map(x => ({ value: x.id, label: `${x.code} - ${x.name}` }))];
  modal(id ? 'تعديل حساب محاسبي' : 'إضافة حساب جديد للدليل', `
    <form id="account-form" class="form-grid">
      ${field('رمز الحساب', 'code', old?.code || '', 'text', { required: true })}
      ${field('اسم الحساب', 'name', old?.name || '', 'text', { required: true })}
      ${selectField('نوع الحساب', 'account_type', [
        { value: 'asset', label: 'أصول' },
        { value: 'liability', label: 'التزامات' },
        { value: 'equity', label: 'حقوق ملكية' },
        { value: 'revenue', label: 'إيرادات' },
        { value: 'expense', label: 'مصروفات' }
      ], old?.account_type || 'asset')}
      ${selectField('الطبيعة', 'normal_side', [{ value: 'debit', label: 'مدين' }, { value: 'credit', label: 'دائن' }], old?.normal_side || 'debit')}
      ${selectField('الحساب الرئيسي', 'parent_id', opts, old?.parent_id || '')}
      ${selectField('الحالة', 'active', [{ value: 'true', label: 'فعال' }, { value: 'false', label: 'موقوف' }], String(old?.active ?? true))}
      <div class="field full form-actions">
        <button class="btn" type="submit">حفظ الحساب</button>
        <button class="btn light" type="button" data-action="close-modal">إلغاء</button>
      </div>
    </form>`);
  $('#account-form').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const payload = { code: d.code.trim(), name: d.name.trim(), account_type: d.account_type, normal_side: d.normal_side, parent_id: d.parent_id || null, active: d.active === 'true' };
    const r = id ? await supabase.from('accounts').update(payload).eq('id', id) : await supabase.from('accounts').insert(payload);
    if (r.error) { toast(r.error.message, true); return; }
    closeModal();
    await renderPage();
    toast('تم حفظ الحساب المحاسبي');
  };
}

async function viewJournal(id) {
  const { data, error } = await supabase.from('journal_entries').select('*,journal_lines(*,accounts(code,name),parties(name))').eq('id', id).single();
  if (error) { toast(error.message, true); return; }
  const lines = data.journal_lines || [];
  const debit = lines.reduce((s, x) => s + Number(x.debit_base), 0);
  const credit = lines.reduce((s, x) => s + Number(x.credit_base), 0);
  modal(`سند قيد يومية: ${data.entry_no}`, `
    <p class="hint">${escapeHtml(data.description)} · التاريخ: ${escapeHtml(data.entry_date)}</p>
    ${table(['الحساب', 'الطرف المرتبط', 'مدين (ر.ي)', 'دائن (ر.ي)', 'العملة الأصلية', 'البيان'],
      lines.map(x => `
        <tr>
          <td><b>${escapeHtml(x.accounts?.code || '')} - ${escapeHtml(x.accounts?.name || '')}</b></td>
          <td>${escapeHtml(x.parties?.name || '—')}</td>
          <td>${money(x.debit_base)}</td>
          <td>${money(x.credit_base)}</td>
          <td>${escapeHtml(x.currency || 'YER')}</td>
          <td>${escapeHtml(x.memo || '')}</td>
        </tr>`).join('')
    )}
    <div class="total-box">
      <span>إجمالي المدين: ${money(debit)} ر.ي · إجمالي الدائن: ${money(credit)} ر.ي</span>
      <strong>${Math.abs(debit - credit) < 0.01 ? 'متوازن ✓' : 'غير متوازن'}</strong>
    </div>
    <div class="form-actions">
      <button class="btn" type="button" data-action="print-current-modal">🖨️ طباعة سند القيد</button>
      <button class="btn light" type="button" data-action="close-modal">إغلاق</button>
    </div>`, true);
}

/* ============================================================================
   WINDOW 13: COMPREHENSIVE FINANCIAL REPORTS & BALANCE SHEET
   ============================================================================ */
async function reportsPage() {
  const [tb, pl, inv] = await Promise.all([
    queryOrThrow(supabase.from('v_trial_balance').select('*').order('code')),
    queryOrThrow(supabase.from('v_profit_loss').select('*').order('code')),
    queryOrThrow(supabase.from('v_inventory_summary').select('*').order('name'))
  ]);

  const d = tb.reduce((s, x) => s + Number(x.debit), 0);
  const c = tb.reduce((s, x) => s + Number(x.credit), 0);
  const rev = pl.filter(x => x.account_type === 'revenue').reduce((s, x) => s + Number(x.net_amount), 0);
  const exp = pl.filter(x => x.account_type === 'expense').reduce((s, x) => s + Number(x.net_amount), 0);
  const netProfit = rev - exp;

  const assets = tb.filter(x => x.account_type === 'asset');
  const liabilities = tb.filter(x => x.account_type === 'liability');
  const equity = tb.filter(x => x.account_type === 'equity');
  const totalAssets = assets.reduce((s, x) => s + Number(x.net_balance), 0);
  const totalLiab = liabilities.reduce((s, x) => s + Number(x.credit - x.debit), 0);
  const totalEq = equity.reduce((s, x) => s + Number(x.credit - x.debit), 0) + netProfit;

  let tabContent = '';
  if (currentReportTab === 'trial_balance') {
    tabContent = `
      <div class="panel">
        <div class="section-head" style="margin-top:0">
          <h2>ميزان المراجعة العام (بالعملة الأساسية YER)</h2>
          <span class="badge ${Math.abs(d - c) < 0.01 ? '' : 'red'}">الفرق: ${money(d - c)} (متوازن ✓)</span>
        </div>
        ${table(['رمز الحساب', 'اسم الحساب', 'التصنيف', 'إجمالي المدين', 'إجمالي الدائن', 'الرصيد الصافي'],
          tb.map(x => `
            <tr>
              <td><b>${escapeHtml(x.code)}</b></td>
              <td>${escapeHtml(x.name)}</td>
              <td>${({ asset: 'أصول', liability: 'التزامات', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات' }[x.account_type] || x.account_type)}</td>
              <td>${money(x.debit)}</td>
              <td>${money(x.credit)}</td>
              <td><b>${money(x.net_balance)}</b></td>
            </tr>`).join('')
        )}
      </div>`;
  } else if (currentReportTab === 'income_statement') {
    tabContent = `
      <div class="panel">
        <div class="section-head" style="margin-top:0">
          <h2>قائمة الدخل والأرباح والخسائر</h2>
          <span class="badge ${netProfit >= 0 ? '' : 'red'}">${netProfit >= 0 ? 'صافي ربح: ' : 'صافي خسارة: '}${money(netProfit)} ر.ي</span>
        </div>
        ${table(['رمز الحساب', 'اسم الحساب', 'التصنيف', 'صافي الرصيد (ر.ي)'],
          pl.map(x => `
            <tr>
              <td><b>${escapeHtml(x.code)}</b></td>
              <td>${escapeHtml(x.name)}</td>
              <td><span class="badge ${x.account_type === 'revenue' ? '' : 'warn'}">${x.account_type === 'revenue' ? 'إيراد' : 'مصروف / تكلفة'}</span></td>
              <td><b>${money(x.net_amount)}</b></td>
            </tr>`).join('')
        )}
        <div class="total-box"><span>إجمالي الإيرادات: ${money(rev)} · إجمالي التكاليف والمصروفات: ${money(exp)}</span><strong>صافي الربح: ${money(netProfit)} ر.ي</strong></div>
      </div>`;
  } else if (currentReportTab === 'balance_sheet') {
    tabContent = `
      <div class="grid-equal">
        <div class="panel">
          <h2>الأصول والممتلكات (Assets)</h2>
          <div style="margin-top:10px">${table(['الرمز', 'الحساب', 'الرصيد الفعلي (ر.ي)'],
            assets.map(a => `<tr><td><b>${escapeHtml(a.code)}</b></td><td>${escapeHtml(a.name)}</td><td><b>${money(a.net_balance)}</b></td></tr>`).join('')
          )}</div>
          <div class="total-box"><span>إجمالي الأصول</span><strong>${money(totalAssets)} ر.ي</strong></div>
        </div>
        <div class="panel">
          <h2>الالتزامات وحقوق الملكية (Liabilities & Equity)</h2>
          <div style="margin-top:10px">${table(['الرمز', 'الحساب', 'الرصيد الفعلي (ر.ي)'],
            [
              ...liabilities.map(l => `<tr><td><b>${escapeHtml(l.code)}</b></td><td>${escapeHtml(l.name)} (التزام)</td><td><b>${money(l.credit - l.debit)}</b></td></tr>`),
              ...equity.map(eq => `<tr><td><b>${escapeHtml(eq.code)}</b></td><td>${escapeHtml(eq.name)} (ملكية)</td><td><b>${money(eq.credit - eq.debit)}</b></td></tr>`),
              `<tr><td><b>—</b></td><td><b>صافي أرباح الفترة الجارية</b></td><td><b>${money(netProfit)}</b></td></tr>`
            ].join('')
          )}</div>
          <div class="total-box"><span>إجمالي الالتزامات وحقوق الملكية</span><strong>${money(totalLiab + totalEq)} ر.ي</strong></div>
        </div>
      </div>`;
  } else {
    const invTotal = inv.reduce((s, x) => s + Number(x.inventory_value_base || 0), 0);
    tabContent = `
      <div class="panel">
        <div class="section-head" style="margin-top:0">
          <h2>تقرير تقييم المخزون السلعي</h2>
          <span class="badge gold">إجمالي قيمة المخزون: ${money(invTotal)} ر.ي</span>
        </div>
        ${table(['الرمز', 'اسم الصنف', 'الوحدة الأساسية', 'الكمية المتوفرة', 'متوسط التكلفة', 'إجمالي القيمة الدفترية'],
          inv.map(x => `
            <tr>
              <td><b>${escapeHtml(x.sku || '—')}</b></td>
              <td>${escapeHtml(x.name)}</td>
              <td>${escapeHtml(x.base_unit)}</td>
              <td>${money(x.quantity)}</td>
              <td>${money(x.avg_cost_base)}</td>
              <td><b>${money(x.inventory_value_base)} ر.ي</b></td>
            </tr>`).join('')
        )}
      </div>`;
  }

  return `
    <div class="cards">
      <div class="card metric"><small>إجمالي المدين (ميزان المراجعة)</small><strong>${money(d)} ر.ي</strong></div>
      <div class="card metric"><small>إجمالي الدائن (ميزان المراجعة)</small><strong>${money(c)} ر.ي</strong></div>
      <div class="card metric gold-top"><small>صافي المبيعات والإيرادات</small><strong>${money(rev)} ر.ي</strong></div>
      <div class="card metric blue-top"><small>صافي الربح المحاسبي</small><strong>${money(netProfit)} ر.ي</strong></div>
    </div>

    <div class="section-head">
      <div class="tab-bar">
        <button type="button" class="tab-btn ${currentReportTab === 'trial_balance' ? 'active' : ''}" data-action="switch-report-tab" data-tab="trial_balance">1. ميزان المراجعة</button>
        <button type="button" class="tab-btn ${currentReportTab === 'income_statement' ? 'active' : ''}" data-action="switch-report-tab" data-tab="income_statement">2. قائمة الدخل</button>
        <button type="button" class="tab-btn ${currentReportTab === 'balance_sheet' ? 'active' : ''}" data-action="switch-report-tab" data-tab="balance_sheet">3. المركز المالي (الميزانية)</button>
        <button type="button" class="tab-btn ${currentReportTab === 'inventory_val' ? 'active' : ''}" data-action="switch-report-tab" data-tab="inventory_val">4. تقييم المخزون</button>
      </div>
      <div class="toolbar">
        <button class="btn light" type="button" data-action="export-report-csv">⬇ تصدير CSV</button>
        <button class="btn" type="button" data-action="print-page-report">🖨️ طباعة التقرير</button>
      </div>
    </div>
    <div id="report-printable-area">${tabContent}</div>`;
}

/* ============================================================================
   WINDOW 14: USERS, SETTINGS & DESIGN / USABILITY TESTING SHOWCASE
   ============================================================================ */
async function usersPage() {
  if (!canManage()) return '<div class="alert error">لا تملك صلاحية إدارة المستخدمين.</div>';
  const users = await queryOrThrow(supabase.from('profiles').select('*').order('created_at', { ascending: false }));
  return `
    <div class="section-head">
      <div>
        <h2>إدارة الموظفين والصلاحيات والأدوار</h2>
        <div class="hint">المدير ينشئ حساب الموظف عبر دعوة بريد إلكتروني ثم يحدد دوره وصلاحياته داخل النظام.</div>
      </div>
      ${btn('＋ دعوة موظف جديد', 'invite-user')}
    </div>
    ${table(['الاسم الكامل', 'الدور الوظيفي', 'الحالة', 'تاريخ الإنشاء', 'إجراء'],
      users.map(x => `
        <tr>
          <td><b>${escapeHtml(x.full_name || '—')}</b></td>
          <td><span class="badge gold">${roleLabel(x.role)}</span></td>
          <td>${x.is_active ? '<span class="badge">مفعّل</span>' : '<span class="badge warn">موقوف</span>'}</td>
          <td>${escapeHtml(String(x.created_at || '').slice(0, 10))}</td>
          <td><button class="mini" type="button" data-action="edit-user" data-id="${x.id}">تعديل الصلاحية</button></td>
        </tr>`).join('')
    )}`;
}

async function settingsPage() {
  if (!canManage()) return '<div class="alert error">هذه الصفحة متاحة لمدير النظام فقط.</div>';
  const [s, r, ca, ac] = await Promise.all([
    queryOrThrow(supabase.from('settings').select('*').eq('id', 1).single()),
    queryOrThrow(supabase.from('exchange_rates').select('*').order('effective_date', { ascending: false })),
    loadCash(),
    queryOrThrow(supabase.from('accounts').select('id,code,name,account_type').order('code'))
  ]);

  return `
    <div class="grid-two">
      <div class="panel">
        <h2>بيانات المنشأة والعملة الأساسية</h2>
        <form id="settings-form" class="form-grid">
          ${field('اسم المنشأة', 'store_name', s.store_name)}
          ${selectField('العملة الأساسية', 'base_currency', [
            { value: 'YER', label: 'ريال يمني (YER)' },
            { value: 'SAR', label: 'ريال سعودي (SAR)' },
            { value: 'USD', label: 'دولار أمريكي (USD)' }
          ], s.base_currency)}
          ${field('نسبة الضريبة الافتراضية %', 'tax_rate', s.tax_rate, 'number', { step: '0.01' })}
          <div class="field full"><button class="btn" type="submit">حفظ إعدادات المنشأة</button></div>
        </form>
      </div>
      <div class="panel">
        <h2>إضافة / تحديث سعر صرف معتمد</h2>
        <form id="rate-form" class="form-grid">
          ${selectField('من عملة', 'from_currency', [{ value: 'SAR', label: 'ريال سعودي' }, { value: 'USD', label: 'دولار أمريكي' }, { value: 'YER', label: 'ريال يمني' }], 'SAR')}
          ${selectField('إلى عملة', 'to_currency', [{ value: 'YER', label: 'ريال يمني' }, { value: 'SAR', label: 'ريال سعودي' }, { value: 'USD', label: 'دولار أمريكي' }], 'YER')}
          ${field('سعر الصرف للوحدة الواحدة', 'rate', '538', 'number', { step: '0.0001' })}
          ${field('تاريخ السريان', 'effective_date', new Date().toISOString().slice(0, 10), 'date')}
          <div class="field full"><button class="btn gold" type="submit">حفظ سعر الصرف</button></div>
        </form>
      </div>
    </div>
    <div class="section-head"><h2>أسعار الصرف المعتمدة في النظام</h2></div>
    ${table(['من عملة', 'إلى عملة', 'سعر الصرف', 'تاريخ السريان'],
      r.map(x => `<tr><td><b>${x.from_currency}</b></td><td><b>${x.to_currency}</b></td><td>${money(x.rate, 4)}</td><td>${x.effective_date}</td></tr>`).join('')
    )}
    <div class="section-head"><h2>حسابات الصناديق النقدية المرتبطة بدليل الحسابات</h2></div>
    ${table(['اسم الصندوق', 'العملة', 'رمز الحساب في الدليل'],
      ca.map(x => {
        const a = ac.find(z => z.id === x.account_id);
        return `<tr><td><b>${escapeHtml(x.name)}</b></td><td><span class="badge">${x.currency}</span></td><td>${escapeHtml(a?.code || '')} - ${escapeHtml(a?.name || '')}</td></tr>`;
      }).join('')
    )}`;
}

/* ============================================================================
   UNIFIED MODERN INVOICE MODAL (SALES, PURCHASES, RETURNS) - BUG-FREE
   ============================================================================ */
function noteField(notes, label) {
  const line = String(notes || '').split(/\r?\n/).find(x => x.startsWith(label + ':'));
  return line ? line.slice(label.length + 1).trim() : '';
}

function salePartyMatches(name, parties) {
  const q = String(name || '').trim().toLocaleLowerCase('ar');
  return q ? parties.find(p => String(p.name || '').trim().toLocaleLowerCase('ar') === q) : null;
}

function saleFindProduct(name) {
  const q = String(name || '').trim().toLocaleLowerCase('ar');
  return q ? activeSaleProducts.find(p => [p.name, p.sku].filter(Boolean).some(v => String(v).trim().toLocaleLowerCase('ar') === q)) : null;
}

function saleEntryProduct() {
  const id = $('#sale-entry-product-id')?.value;
  return activeSaleProducts.find(p => p.id === id) || null;
}

function saleCurrentCurrency() {
  return activeSaleCurrency || $('#sale-form')?.elements.currency?.value || 'YER';
}

function saleDefaultPurchasePrice(product, unit) {
  if (!canFinance()) return '';
  const currency = saleCurrentCurrency();
  if (unit && unit.currency === currency && Number(unit.purchase_price) > 0) return Number(unit.purchase_price);
  const fx = Number($('#sale-form')?.elements.exchange_rate?.value || 1);
  const avg = Number(product?.avg_cost_base || 0), factor = Number(unit?.factor_to_base || 0);
  return avg > 0 && factor > 0 && fx > 0 ? Number((avg * factor / fx).toFixed(4)) : '';
}

function renderDraftNewProductUnitsSelect() {
  const select = $('#sale-entry-unit');
  if (!select) return;
  const presetOptions = PACKAGING_PRESETS.map(p =>
    `<option value="preset:${escapeHtml(p.id)}" ${p.pack_unit === draftNewProductConfig.selected_unit_name ? 'selected' : ''}>📦 ${escapeHtml(p.label)}</option>`
  ).join('');
  const customUnits = draftNewProductConfig.units.filter(u => !PACKAGING_PRESETS.some(p => p.pack_unit === u.unit_name));
  const customOptions = customUnits.map(u =>
    `<option value="custom:${escapeHtml(u.unit_name)}" ${u.unit_name === draftNewProductConfig.selected_unit_name ? 'selected' : ''}>⚙️ ${escapeHtml(u.unit_name)} (تحتوي على ${u.factor_to_base} ${escapeHtml(draftNewProductConfig.base_unit)})</option>`
  ).join('');
  select.innerHTML = `<optgroup label="وحدات وعبوات جاهزة (تُنشأ تلقائياً مع الصنف)">${presetOptions}</optgroup>${customOptions ? `<optgroup label="وحدات مخصصة مضافة يدوياً">${customOptions}</optgroup>` : ''}`;
  select.disabled = false;
}

function renderDraftUnitsTableInPanel() {
  const wrap = $('#draft-units-table-wrap');
  if (!wrap) return;
  const product = saleEntryProduct();
  if (product) {
    // Existing product units table with inline manual edit button
    const rows = (product.units || []).map(u => `
      <tr>
        <td><b>${escapeHtml(u.unit_name)}</b> ${u.is_base ? '<span class="badge">أساسية</span>' : ''}</td>
        <td>${u.is_base ? '1 (الوحدة المرجعية)' : `تحتوي على <b>${money(u.factor_to_base, 4)}</b> ${escapeHtml(product.base_unit)}`}</td>
        <td>${money(u.purchase_price || 0)}</td>
        <td>${money(u.sale_price || 0)}</td>
        <td>${!u.is_base ? `<button type="button" class="mini gold" data-action="load-unit-to-edit" data-unit-name="${escapeHtml(u.unit_name)}" data-factor="${u.factor_to_base}" data-buy="${u.purchase_price || 0}" data-sell="${u.sale_price || 0}">تعديل</button>` : '<small class="muted">مرجعية</small>'}</td>
      </tr>`).join('');
    wrap.innerHTML = `<div style="margin-top:10px"><small class="muted" style="display:block;margin-bottom:4px">الوحدات المسجلة حالياً للصنف «${escapeHtml(product.name)}» (اضغط تعديل لتحديث أي وحدة أو أضف وحدة جديدة أعلاه):</small>${table(['الوحدة', 'المحتوى / التحويل', 'سعر الشراء', 'سعر البيع', 'إجراء'], rows)}</div>`;
    return;
  }

  // New product draft units table (editable manually before creation)
  const rows = draftNewProductConfig.units.map((u, idx) => `
    <tr data-draft-unit-idx="${idx}">
      <td><input class="control sheet-input draft-u-name" value="${escapeHtml(u.unit_name)}" ${u.is_base ? 'readonly' : ''}></td>
      <td>${u.is_base ? '<span class="badge">1 (الوحدة الصغرى/الأساسية)</span>' : `<input class="control sheet-input draft-u-factor" type="number" min="0.0001" step="0.0001" value="${u.factor_to_base}">`}</td>
      <td><button type="button" class="mini ${draftNewProductConfig.selected_unit_name === u.unit_name ? 'gold' : ''}" data-action="select-draft-unit" data-unit-name="${escapeHtml(u.unit_name)}">${draftNewProductConfig.selected_unit_name === u.unit_name ? '✓ مختارة للفاتورة' : 'اختيار للفاتورة'}</button></td>
      <td>${!u.is_base ? `<button type="button" class="mini red" data-action="remove-draft-unit" data-idx="${idx}">حذف</button>` : ''}</td>
    </tr>`).join('');
  wrap.innerHTML = `
    <div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;flex-wrap:wrap;gap:6px">
        <small style="font-weight:800;color:var(--g2)">جدول وحدات الصنف الجديد (الوحدة الأساسية الصغرى: <input id="draft-base-unit-input" class="control" style="display:inline-block;width:110px;padding:3px 8px;height:28px;font-size:12px" value="${escapeHtml(draftNewProductConfig.base_unit)}">)</small>
        <small class="muted">يمكنك تعديل أسماء الوحدات ومحتواها يدوياً أو إضافة وحدات جديدة أعلاه</small>
      </div>
      ${table(['اسم الوحدة / العبوة', `المحتوى (كم ${escapeHtml(draftNewProductConfig.base_unit)} داخلها؟)`, 'وحدة الفاتورة الحالية', ''], rows)}
    </div>`;

  $('#draft-base-unit-input')?.addEventListener('input', e => {
    const val = e.target.value.trim() || 'كيلو';
    const oldBase = draftNewProductConfig.base_unit;
    draftNewProductConfig.base_unit = val;
    const baseObj = draftNewProductConfig.units.find(u => u.is_base);
    if (baseObj) {
      if (draftNewProductConfig.selected_unit_name === baseObj.unit_name) draftNewProductConfig.selected_unit_name = val;
      baseObj.unit_name = val;
    }
    const baseSubInput = $('#sale-new-unit-base-label');
    if (baseSubInput) baseSubInput.value = val;
    renderDraftNewProductUnitsSelect();
  });

  $$('#draft-units-table-wrap tr[data-draft-unit-idx]').forEach(tr => {
    const idx = Number(tr.dataset.draftUnitIdx);
    $('.draft-u-name', tr)?.addEventListener('input', e => {
      const oldName = draftNewProductConfig.units[idx].unit_name;
      draftNewProductConfig.units[idx].unit_name = e.target.value.trim();
      if (draftNewProductConfig.selected_unit_name === oldName) {
        draftNewProductConfig.selected_unit_name = draftNewProductConfig.units[idx].unit_name;
      }
      renderDraftNewProductUnitsSelect();
    });
    $('.draft-u-factor', tr)?.addEventListener('input', e => {
      draftNewProductConfig.units[idx].factor_to_base = Math.max(0.0001, Number(e.target.value || 1));
      renderDraftNewProductUnitsSelect();
    });
  });
}

function setSaleEntryProduct(product, typedName = '') {
  const id = $('#sale-entry-product-id');
  if (id) id.value = product?.id || '';
  const units = product?.units || [];
  const select = $('#sale-entry-unit');
  const isPurchaseSide = ['purchase', 'purchase_return'].includes(activeInvoiceDocType);
  const canAutoCreate = canFinance() && (isPurchaseSide || activeInvoiceDocType === 'sale');

  if (product) {
    if (select) {
      select.innerHTML = units.map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.unit_name)}${u.is_base ? ' · أساسية' : ` (${u.factor_to_base} ${product.base_unit})`}</option>`).join('');
      select.disabled = !units.length;
      const base = units.find(u => u.is_base) || units.find(u => u.unit_name === product?.base_unit) || units[0];
      if (base) select.value = base.id;
    }
    const unit = units.find(u => u.id === select?.value);
    const currency = saleCurrentCurrency();
    const price = $('#sale-entry-price');
    if (price) {
      const defaultVal = isPurchaseSide ? unit?.purchase_price : unit?.sale_price;
      price.value = unit && unit.currency === currency && Number(defaultVal) > 0 ? defaultVal : '';
    }
    const cost = $('#sale-entry-purchase-price');
    if (cost) cost.value = saleDefaultPurchasePrice(product, unit);
    const stock = activeSaleInventory.get(product.id);
    const status = $('#sale-entry-status');
    if (status) {
      status.className = 'sale-field-hint sale-product-status is-found';
      status.textContent = `✓ الصنف مسجل في الدليل (${product.units.length} وحدات متاحة)`;
    }
    const stockEl = $('#sale-entry-stock');
    if (stockEl) stockEl.textContent = stock === undefined ? 'سيتم التحقق من المخزون عند الترحيل' : `المتاح حالياً: ${money(stock, 4)} ${product.base_unit || ''}`;
    const baseLbl = $('#sale-new-unit-base-label');
    if (baseLbl) { baseLbl.value = product.base_unit || 'كيلو'; baseLbl.readOnly = true; }
  } else if (typedName && canAutoCreate) {
    // New unregistered product typed! Enable auto-creation & packaging selector
    renderDraftNewProductUnitsSelect();
    const status = $('#sale-entry-status');
    if (status) {
      status.className = 'sale-field-hint sale-product-status is-new';
      status.textContent = `✨ صنف جديد («${typedName}») — سيتم إضافته تلقائياً إلى دليل الأصناف مع وحداته عند الإضافة للفاتورة`;
    }
    const stockEl = $('#sale-entry-stock');
    if (stockEl) stockEl.textContent = `الوحدة الصغرى/الأساسية: ${draftNewProductConfig.base_unit} · وحدة الفاتورة: ${draftNewProductConfig.selected_unit_name} (اضغط «＋ وحدة / العبوات» لتخصيص الوحدات يدوياً)`;
    const baseLbl = $('#sale-new-unit-base-label');
    if (baseLbl) { baseLbl.value = draftNewProductConfig.base_unit; baseLbl.readOnly = false; }
  } else {
    if (select) {
      select.innerHTML = '<option value="">اختر الصنف أو اكتب اسم صنف جديد…</option>';
      select.disabled = true;
    }
    const status = $('#sale-entry-status');
    if (status) {
      status.className = 'sale-field-hint sale-product-status';
      status.textContent = canAutoCreate ? 'اكتب اسم صنف موجود أو اكتب اسم صنف جديد لإضافته تلقائياً للأصناف' : 'اختر صنفاً مسجلاً من القائمة';
    }
    const stockEl = $('#sale-entry-stock');
    if (stockEl) stockEl.textContent = 'اختر صنفاً لعرض رصيده أو تحديد عبواته';
  }

  const unitBtn = $('#sale-add-unit-toggle');
  if (unitBtn) unitBtn.disabled = !canFinance();
  renderDraftUnitsTableInPanel();
}

function updateSaleEntryUnitDefaults({ keepSalePrice = false } = {}) {
  const product = saleEntryProduct();
  if (!product) {
    // New product unit/preset selected
    const val = $('#sale-entry-unit')?.value || '';
    if (val.startsWith('preset:')) {
      applyPresetToDraftNewProduct(val.slice(7));
    } else if (val.startsWith('custom:')) {
      draftNewProductConfig.selected_unit_name = val.slice(7);
    }
    const stockEl = $('#sale-entry-stock');
    if (stockEl) stockEl.textContent = `الوحدة الأساسية: ${draftNewProductConfig.base_unit} · وحدة الفاتورة المختارة: ${draftNewProductConfig.selected_unit_name}`;
    renderDraftUnitsTableInPanel();
    return;
  }
  const unit = product.units.find(u => u.id === $('#sale-entry-unit')?.value);
  const currency = saleCurrentCurrency();
  const isPurchaseSide = ['purchase', 'purchase_return'].includes(activeInvoiceDocType);
  const price = $('#sale-entry-price');
  if (price && !keepSalePrice) {
    const defaultVal = isPurchaseSide ? unit?.purchase_price : unit?.sale_price;
    price.value = unit && unit.currency === currency && Number(defaultVal) > 0 ? defaultVal : '';
  }
  const cost = $('#sale-entry-purchase-price');
  if (cost) cost.value = saleDefaultPurchasePrice(product, unit);
}

function renderSaleLines() {
  const body = $('#sale-lines-body');
  if (!body) return;
  const showInternalCost = false;
  const count = $('#sale-lines-count');
  if (count) count.textContent = `${activeSaleLines.length} بند`;
  if (!activeSaleLines.length) {
    body.innerHTML = `<tr><td colspan="${showInternalCost ? 9 : 7}" class="empty">لم تتم إضافة أصناف بعد. اختر الصنف والوحدة والكمية ثم اضغط «إضافة إلى الفاتورة».</td></tr>`;
    const tfoot = $('#sale-lines-tfoot');
    if (tfoot) tfoot.innerHTML = '';
    renderSaleTotals();
    return;
  }
  body.innerHTML = activeSaleLines.map((line, index) => {
    const product = activeSaleProducts.find(p => p.id === line.product_id);
    const units = (product?.units || []).map(u => `<option value="${escapeHtml(u.id)}" ${u.id === line.unit_id ? 'selected' : ''}>${escapeHtml(u.unit_name)}</option>`).join('');
    const profit = showInternalCost && line.purchase_price !== '' ? (Number(line.unit_price) - Number(line.purchase_price)) * Number(line.quantity) : null;
    return `
      <tr data-line-key="${line.key}">
        <td style="text-align:center;font-weight:900;color:var(--g2)">${index + 1}</td>
        <td><b>${escapeHtml(line.product_name)}</b><small class="sheet-sub">${escapeHtml(line.sku || '')}</small></td>
        <td><select class="control sheet-input sale-edit-unit">${units}</select></td>
        <td><input class="control sheet-input sale-edit-price" type="number" min="0.0001" step="0.0001" value="${line.unit_price}"></td>
        <td><input class="control sheet-input sale-edit-qty" type="number" min="0.0001" step="0.0001" value="${line.quantity}"></td>
        ${showInternalCost ? `<td class="internal-cost-cell"><input class="control sheet-input sale-edit-cost" type="number" min="0" step="0.0001" value="${line.purchase_price}"><small>داخلي</small></td><td class="internal-profit">${profit === null ? '—' : money(profit, 4)}</td>` : ''}
        <td><b class="sale-line-total">${money(line.quantity * line.unit_price, 4)}</b></td>
        <td><button type="button" class="mini red" data-action="remove-sale-line">حذف</button></td>
      </tr>`;
  }).join('');
  renderSaleTotals();
}

function renderSaleTotals() {
  const subtotal = activeSaleLines.reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unit_price || 0), 0);
  const discount = Number($('#sale-discount')?.value || 0);
  const tax = Number($('#sale-tax')?.value || 0);
  const total = Math.max(0, subtotal - discount + tax);
  if ($('#sale-subtotal')) $('#sale-subtotal').textContent = money(subtotal, 4);
  if ($('#sale-total')) $('#sale-total').textContent = money(total, 4);
  const currencyCaption = $('#sale-currency-caption');
  if (currencyCaption) currencyCaption.textContent = currencyName(saleCurrentCurrency());
  const totalQty = activeSaleLines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  const showInternalCost = false;
  const tfoot = $('#sale-lines-tfoot');
  if (tfoot) {
    if (activeSaleLines.length) {
      tfoot.innerHTML = `<tr style="background:var(--emerald-soft);font-weight:900;border-top:2px solid var(--g)">
        <td colspan="4" style="color:var(--g)">المجموع الكلي للأصناف (${activeSaleLines.length} أصناف)</td>
        <td style="color:var(--g)">${money(totalQty, 4)}</td>
        ${showInternalCost ? '<td colspan="2"></td>' : ''}
        <td style="font-size:14px;color:var(--g2)">${money(subtotal, 4)} ${escapeHtml(saleCurrentCurrency())}</td>
        <td></td>
      </tr>`;
    } else {
      tfoot.innerHTML = '';
    }
  }
  const entryTotal = $('#sale-entry-line-preview');
  if (entryTotal) {
    const q = Number($('#sale-entry-qty')?.value || 0), p = Number($('#sale-entry-price')?.value || 0);
    entryTotal.textContent = money(q * p, 4);
  }
}

async function autoCreateProductForInvoiceLine(typedName, enteredUnitPrice, currency) {
  const selUnitObj = draftNewProductConfig.units.find(u => u.unit_name === draftNewProductConfig.selected_unit_name) || draftNewProductConfig.units[0];
  const factor = Number(selUnitObj?.factor_to_base || 1);
  const isPurchaseSide = ['purchase', 'purchase_return'].includes(activeInvoiceDocType);
  const baseUnitBuy = isPurchaseSide ? Number((enteredUnitPrice / factor).toFixed(4)) : Number(((enteredUnitPrice * 0.8) / factor).toFixed(4));
  const baseUnitSell = isPurchaseSide ? Number(((enteredUnitPrice * 1.25) / factor).toFixed(4)) : Number((enteredUnitPrice / factor).toFixed(4));
  const fx = Number($('#sale-form')?.elements.exchange_rate?.value || 1);
  const avgCostBase = Number((baseUnitBuy * fx).toFixed(6));

  const extraUnits = draftNewProductConfig.units
    .filter(u => !u.is_base && u.unit_name !== draftNewProductConfig.base_unit)
    .map(u => ({
      unit_name: u.unit_name,
      factor_to_base: Number(u.factor_to_base),
      purchase_price: Number((baseUnitBuy * Number(u.factor_to_base)).toFixed(4)),
      sale_price: Number((baseUnitSell * Number(u.factor_to_base)).toFixed(4))
    }));

  const payload = {
    id: null,
    name: typedName,
    sku: 'SH-' + Date.now().toString().slice(-4),
    category: draftNewProductConfig.category || 'عام',
    base_unit: draftNewProductConfig.base_unit || 'كيلو',
    purchase_price: baseUnitBuy,
    sale_price: baseUnitSell,
    currency,
    avg_cost_base: avgCostBase,
    reorder_level: 5,
    description: 'أضيف تلقائياً من نافذة الفواتير',
    units: extraUnits
  };

  const res = await supabase.rpc('save_product', { p_payload: payload });
  if (res.error) throw new Error('تعذر إنشاء الصنف تلقائياً: ' + res.error.message);
  const newProductId = res.data;
  cachedProducts = [];
  activeSaleProducts = await loadProducts();
  // Refresh datalist in invoice
  const dl = $('#sale-product-options');
  if (dl) {
    dl.innerHTML = activeSaleProducts.flatMap(p => [p.name, p.sku].filter(Boolean)).map(v => `<option value="${escapeHtml(v)}"></option>`).join('');
  }
  return activeSaleProducts.find(p => p.id === newProductId) || activeSaleProducts.find(p => p.name === typedName);
}

async function addSaleLine() {
  let product = saleEntryProduct();
  const typedName = String($('#sale-entry-name')?.value || '').trim();
  const quantity = Number($('#sale-entry-qty')?.value || 0);
  const unitPrice = Number($('#sale-entry-price')?.value || 0);
  const purchaseRaw = $('#sale-entry-purchase-price')?.value;
  const purchasePrice = purchaseRaw === '' || purchaseRaw === undefined ? '' : Number(purchaseRaw);

  if (quantity <= 0 || !Number.isFinite(quantity)) { toast('أدخل كمية أكبر من صفر', true); return; }
  if (unitPrice <= 0 || !Number.isFinite(unitPrice)) {
    toast('أدخل سعر الوحدة (أكبر من صفر) قبل إضافة الصنف', true);
    $('#sale-entry-price')?.focus();
    return;
  }

  let unit = null;
  if (!product) {
    if (!typedName) {
      toast('اكتب اسم الصنف أو اختره من القائمة أولاً', true);
      $('#sale-entry-name')?.focus();
      return;
    }
    if (!canFinance()) {
      toast('الصنف غير مسجل؛ إضافة الأصناف الجديدة متاحة للمدير والمحاسب فقط', true);
      return;
    }
    const addBtn = $('[data-action="add-sale-line"]');
    if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'جارٍ تسجيل الصنف الجديد…'; }
    try {
      product = await autoCreateProductForInvoiceLine(typedName, unitPrice, saleCurrentCurrency());
      if (!product) throw new Error('لم يتم العثور على الصنف بعد إنشائه');
      unit = product.units.find(u => u.unit_name === draftNewProductConfig.selected_unit_name)
        || product.units.find(u => u.is_base)
        || product.units[0];
      toast(`✨ تم تسجيل الصنف الجديد «${product.name}» ووحداته تلقائياً في دليل الأصناف!`);
    } catch (err) {
      toast(err.message || 'تعذر إضافة الصنف الجديد', true);
      if (addBtn) { addBtn.disabled = false; addBtn.textContent = '＋ إضافة إلى الفاتورة'; }
      return;
    }
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = '＋ إضافة إلى الفاتورة'; }
  } else {
    unit = product.units.find(u => u.id === $('#sale-entry-unit')?.value) || product.units[0];
  }

  if (!unit) { toast('اختر وحدة صحيحة للصنف', true); return; }

  activeSaleLines.push({
    key: `sl-${++saleLineSequence}`,
    product_id: product.id,
    product_name: product.name,
    sku: product.sku || '',
    unit_id: unit.id,
    unit_name: unit.unit_name,
    factor_to_base: Number(unit.factor_to_base),
    quantity,
    unit_price: unitPrice,
    purchase_price: canFinance() && activeInvoiceDocType === 'sale' ? purchasePrice : ''
  });
  renderSaleLines();
  $('#sale-entry-qty').value = '1';
  $('#sale-entry-name').value = '';
  $('#sale-add-unit-panel')?.classList.add('hidden');
  setSaleEntryProduct(null);
  $('#sale-entry-name')?.focus();
}

function toggleSaleUnitPanel(force) {
  const panel = $('#sale-add-unit-panel');
  if (!panel) return;
  const shouldShow = force === undefined ? panel.classList.contains('hidden') : Boolean(force);
  panel.classList.toggle('hidden', !shouldShow);
  if (shouldShow) {
    renderDraftUnitsTableInPanel();
    $('#sale-new-unit-name')?.focus();
  }
}

function applyQuickPresetInInvoicePanel(presetId) {
  const preset = PACKAGING_PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  const product = saleEntryProduct();
  if (!product) {
    // Apply to new product draft
    applyPresetToDraftNewProduct(presetId);
    if ($('#sale-new-unit-name')) $('#sale-new-unit-name').value = preset.pack_unit;
    if ($('#sale-new-unit-factor')) $('#sale-new-unit-factor').value = preset.factor;
    if ($('#sale-new-unit-base-label')) $('#sale-new-unit-base-label').value = preset.base_unit;
    renderDraftNewProductUnitsSelect();
    renderDraftUnitsTableInPanel();
    toast(`تم ضبط القالب: ${preset.label} (الوحدة الأساسية: ${preset.base_unit})`);
  } else {
    // Apply to existing product form fields
    if ($('#sale-new-unit-name')) $('#sale-new-unit-name').value = preset.pack_unit;
    if ($('#sale-new-unit-factor')) $('#sale-new-unit-factor').value = preset.factor;
    const baseU = product.units.find(u => u.is_base) || product.units[0];
    if (baseU) {
      if ($('#sale-new-unit-purchase')) $('#sale-new-unit-purchase').value = Number((Number(baseU.purchase_price || 0) * preset.factor).toFixed(2));
      if ($('#sale-new-unit-sale')) $('#sale-new-unit-sale').value = Number((Number(baseU.sale_price || 0) * preset.factor).toFixed(2));
    }
    toast(`تم تعبئة بيانات العبوة «${preset.pack_unit}» — اضغط حفظ لإضافتها للصنف`);
  }
}

async function saveSaleUnitFromInvoice() {
  if (!canFinance()) { toast('إضافة وتعديل الوحدات متاحة للمدير والمحاسب فقط', true); return; }
  const product = saleEntryProduct();
  const unitName = String($('#sale-new-unit-name')?.value || '').trim();
  const factor = Number($('#sale-new-unit-factor')?.value || 0);
  const purchase = Number($('#sale-new-unit-purchase')?.value || 0);
  const sale = Number($('#sale-new-unit-sale')?.value || 0);
  const baseUnitTyped = String($('#sale-new-unit-base-label')?.value || 'كيلو').trim() || 'كيلو';

  if (!unitName || factor <= 0 || purchase < 0 || sale < 0) {
    toast('أدخل اسم الوحدة/العبوة والمحتوى (أكبر من صفر) والأسعار بشكل صحيح', true);
    return;
  }

  // Case 1: Product is not yet created (New Product Draft in Invoice)
  if (!product) {
    draftNewProductConfig.base_unit = baseUnitTyped;
    const baseObj = draftNewProductConfig.units.find(u => u.is_base);
    if (baseObj) baseObj.unit_name = baseUnitTyped;
    else draftNewProductConfig.units.unshift({ unit_name: baseUnitTyped, factor_to_base: 1, is_base: true });

    const existingIdx = draftNewProductConfig.units.findIndex(u => u.unit_name.toLowerCase() === unitName.toLowerCase());
    if (existingIdx >= 0) {
      draftNewProductConfig.units[existingIdx].factor_to_base = factor;
    } else {
      draftNewProductConfig.units.push({ unit_name: unitName, factor_to_base: factor, is_base: false });
    }
    draftNewProductConfig.selected_unit_name = unitName;
    if (purchase > 0 && $('#sale-entry-price')) $('#sale-entry-price').value = purchase;
    renderDraftNewProductUnitsSelect();
    renderDraftUnitsTableInPanel();
    $('#sale-new-unit-name').value = '';
    toast(`تمت إضافة وتحديد الوحدة «${unitName} (${factor} ${baseUnitTyped})» للصنف الجديد`);
    return;
  }

  // Case 2: Existing Product — Save unit directly via RPC
  const currency = saleCurrentCurrency();
  const button = $('#sale-save-new-unit');
  button.disabled = true;
  button.textContent = 'جارٍ حفظ الوحدة…';
  const { data, error } = await supabase.rpc('add_product_unit_to_product', {
    p_product_id: product.id, p_unit_name: unitName, p_factor_to_base: factor,
    p_purchase_price: purchase, p_sale_price: sale, p_currency: currency
  });
  button.disabled = false;
  button.textContent = '💾 حفظ وإضافة / تحديث الوحدة';
  if (error) { toast(error.message || 'تعذر حفظ الوحدة', true); return; }
  const productId = product.id;
  cachedProducts = [];
  activeSaleProducts = await loadProducts();
  const refreshed = activeSaleProducts.find(p => p.id === productId);
  if (refreshed) {
    $('#sale-entry-name').value = refreshed.name;
    setSaleEntryProduct(refreshed);
    const newUnit = refreshed.units.find(u => u.id === data || u.unit_name === unitName);
    if (newUnit) $('#sale-entry-unit').value = newUnit.id;
    updateSaleEntryUnitDefaults();
  }
  $('#sale-new-unit-name').value = '';
  $('#sale-new-unit-factor').value = '';
  $('#sale-new-unit-purchase').value = '0';
  $('#sale-new-unit-sale').value = '0';
  renderDraftUnitsTableInPanel();
  toast('تم حفظ وتحديث الوحدة في دليل الأصناف بنجاح');
}

async function openUnifiedInvoice(docType = 'sale') {
  if (isPersistentOfflineSession()) {
    toast('يمكنك استعراض الأصناف وتسجيلها محلياً دون اتصال، أما ترحيل الفواتير والقيود المالية فيحتاج إلى اتصال بالخادم لضمان سلامة الأرصدة.');
    return;
  }
  try {
    activeInvoiceDocType = docType;
    const isPurchaseSide = ['purchase', 'purchase_return'].includes(docType);
    const isReturn = ['sale_return', 'purchase_return'].includes(docType);
    const showInternalCost = false;

    const [products, parties, cash, settings, inventory] = await Promise.all([
      loadProducts(), loadParties(), loadCash(),
      queryOrThrow(supabase.from('settings').select('base_currency,store_name,tax_rate').eq('id', 1).single()),
      supabase.from('v_inventory_summary').select('id,quantity')
    ]);
    if (!products.length && !canFinance()) {
      toast('لا توجد أصناف مسجلة. أضف الأصناف أولاً.', true);
      return;
    }
    activeSaleProducts = products;
    activeSaleInventory = new Map();
    (inventory.data || []).forEach(x => activeSaleInventory.set(x.id, (activeSaleInventory.get(x.id) || 0) + Number(x.quantity || 0)));
    applyPresetToDraftNewProduct('kilo_base');

    const eligibleParties = parties.filter(p => isPurchaseSide
      ? (p.party_type === 'supplier' || p.party_type === 'both')
      : (p.party_type === 'customer' || p.party_type === 'both'));

    activeSaleCurrency = settings.base_currency || 'YER';
    const cashOptions = cash.filter(x => x.currency === activeSaleCurrency).map(x => ({ value: x.id, label: `${x.name} · ${x.currency}` }));
    const partyDatalist = eligibleParties.map(p => `<option value="${escapeHtml(p.name)}"></option>`).join('');

    const titleMap = {
      sale: 'فاتورة مبيعات جديدة',
      sale_return: 'إشعار مرتجع مبيعات',
      purchase: 'فاتورة مشتريات وتوريد مخزني',
      purchase_return: 'إشعار مرتجع مشتريات لمورد'
    };
    const brandTheme = isReturn ? 'return-theme' : isPurchaseSide ? 'purchase-theme' : '';
    const partyLabel = isPurchaseSide ? 'المورد' : 'العميل';

    const presetChipsHtml = PACKAGING_PRESETS.slice(1, 8).map(p =>
      `<button type="button" class="preset-chip" data-action="apply-invoice-preset" data-preset="${p.id}">📦 ${escapeHtml(p.label)}</button>`
    ).join('');

    modal(titleMap[docType], `
      <form id="sale-form" class="sale-invoice-form">
        <div class="invoice-official-banner-wrap">
          <img src="${BANNER_SRC}" alt="ترويسة محلات الشيباني للبهارات والأعشاب الطبيعية" class="invoice-official-banner-img">
          <div class="invoice-official-title-bar ${brandTheme}">
            <span>📋 ${titleMap[docType]}</span>
            <span>التاريخ: <b id="invoice-header-date-display">${new Date().toISOString().slice(0, 10)}</b></span>
          </div>
        </div>

        <div class="sale-meta-grid">
          <div class="field"><label>تاريخ المستند</label><input class="control" name="document_date" type="date" value="${new Date().toISOString().slice(0, 10)}" required></div>
          <div class="field"><label>العملة</label><select class="control" name="currency"><option value="YER" ${activeSaleCurrency === 'YER' ? 'selected' : ''}>ريال يمني (YER)</option><option value="SAR" ${activeSaleCurrency === 'SAR' ? 'selected' : ''}>ريال سعودي (SAR)</option><option value="USD" ${activeSaleCurrency === 'USD' ? 'selected' : ''}>دولار أمريكي (USD)</option></select></div>
          <div class="field"><label>طريقة السداد</label><select class="control" name="settlement_method"><option value="cash">نقدي (صندوق)</option><option value="credit">آجل (ذمم)</option></select></div>
          <div class="field"><label>الصندوق</label><select class="control" name="cash_account_id">${cashOptions.map(x => `<option value="${x.value}">${escapeHtml(x.label)}</option>`).join('')}</select></div>
          <div class="field"><label>سعر الصرف إلى ${escapeHtml(currencyName(settings.base_currency))}</label><input class="control" name="exchange_rate" type="number" step="0.00000001" readonly value="1"></div>
        </div>

        <section class="sale-section">
          <div class="sale-section-heading">
            <div><h3>بيانات ${partyLabel}</h3><p>${isPurchaseSide ? 'اختر المورد المسجل لإثبات فاتورة الشراء أو المرتجع' : 'اكتب اسم العميل النقدي أو اختر عميلاً مسجلاً من القائمة'}</p></div>
            <span class="sale-section-icon">👥</span>
          </div>
          <div class="sale-customer-grid">
            <div class="field">
              <label>اسم ${partyLabel}</label>
              <input class="control" id="sale-customer-name" name="party_name" list="sale-customer-options" autocomplete="off" placeholder="${isPurchaseSide ? 'اختر المورد من القائمة…' : 'اسم العميل / عميل نقدي'}">
              <datalist id="sale-customer-options">${partyDatalist}</datalist>
              <input type="hidden" name="party_id" id="sale-party-id">
              <small class="sale-field-hint" id="sale-customer-hint">${isPurchaseSide ? 'يجب اختيار مورد مسجل.' : 'يمكن كتابة اسم عميل نقدي يدوياً. للفاتورة الآجلة اختر عميلاً مسجلاً.'}</small>
            </div>
            <div class="field">
              <label>رقم الهاتف / واتساب</label>
              <input class="control" id="sale-customer-phone" name="party_phone" type="tel" placeholder="+9677xxxxxxxx">
              <small class="sale-field-hint">يُستخدم لمشاركة الفاتورة مباشرة عبر واتساب.</small>
            </div>
          </div>
        </section>

        <section class="sale-section">
          <div class="sale-section-heading">
            <div>
              <h3>إضافة صنف إلى الجدول ${canFinance() ? '(يدعم الإضافة التلقائية للأصناف الجديدة)' : ''}</h3>
              <p>ابحث عن صنف مسجل أو اكتب اسم صنف جديد تماماً ليتم تسجيله تلقائياً في الأصناف مع تحديد عبوته ووحداته.</p>
            </div>
            <span class="sale-section-icon">＋</span>
          </div>
          <div class="sale-entry-grid">
            <div class="field sale-entry-product">
              <label for="sale-entry-name">الصنف (مسجل أو صنف جديد)</label>
              <input class="control" id="sale-entry-name" data-product-autocomplete list="sale-product-options" autocomplete="off" placeholder="اكتب اسم الصنف لعرض الأصناف المسجلة…">
              <div class="product-suggestions" data-suggestions-for="sale-entry-name" hidden></div>
              <datalist id="sale-product-options">${activeSaleProducts.flatMap(p => [p.name, p.sku].filter(Boolean)).map(v => `<option value="${escapeHtml(v)}"></option>`).join('')}</datalist>
              <input id="sale-entry-product-id" type="hidden">
              <small id="sale-entry-status" class="sale-field-hint">اكتب اسم صنف مسجل أو صنف جديد لإضافته تلقائياً</small>
              <small id="sale-entry-stock" class="sale-stock">اختر صنفاً لعرض رصيده أو تحديد عبوته</small>
            </div>
            <div class="field sale-entry-unit">
              <label for="sale-entry-unit">الوحدة / العبوة</label>
              <div class="unit-select-wrap">
                <select class="control" id="sale-entry-unit" disabled></select>
                ${canFinance() ? '<button class="mini unit-add-btn" id="sale-add-unit-toggle" type="button" data-action="toggle-sale-unit">＋ وحدة / عبوات</button>' : ''}
              </div>
            </div>
            <div class="field"><label for="sale-entry-qty">الكمية</label><input class="control" id="sale-entry-qty" type="number" min="0.0001" step="0.0001" value="1"></div>
            <div class="field"><label for="sale-entry-price">${isPurchaseSide ? 'سعر الشراء للوحدة' : 'سعر البيع للوحدة'}</label><input class="control" id="sale-entry-price" type="number" min="0.0001" step="0.0001" placeholder="السعر"></div>
            ${showInternalCost ? '<div class="field internal-cost-entry"><label for="sale-entry-purchase-price">سعر الشراء (داخلي)</label><input class="control" id="sale-entry-purchase-price" type="number" min="0" step="0.0001" placeholder="داخلي فقط"><small>لا يظهر في نسخة العميل أو الطباعة.</small></div>' : ''}
            <div class="sale-entry-add">
              <small>إجمالي السطر: <b id="sale-entry-line-preview">0</b></small>
              <button class="btn" type="button" data-action="add-sale-line">＋ إضافة إلى الفاتورة</button>
            </div>
          </div>

          ${canFinance() ? `
          <div id="sale-add-unit-panel" class="sale-add-unit-panel hidden">
            <div class="sale-add-unit-title">
              <b>📦 إدارة وتخصيص وحدات الصنف والعبوات (يدوياً أو بالقوالب الجاهزة)</b>
              <small>انقر على أي عبوة قياسية لتعبئتها تلقائياً، أو أدخل تفاصيل العبوة يدوياً بالأسفل:</small>
            </div>
            <div class="preset-chips">${presetChipsHtml}</div>
            <div class="sale-new-unit-grid" style="grid-template-columns:repeat(5,minmax(0,1fr));margin-top:8px">
              <div class="field">
                <label>اسم العبوة / الوحدة</label>
                <input class="control" id="sale-new-unit-name" list="common-pack-names" placeholder="مثلاً: كرتون / قطمة / كيس">
                <datalist id="common-pack-names">
                  <option value="كرتون"></option><option value="قطمة"></option><option value="كيس"></option>
                  <option value="درزن"></option><option value="باكت"></option><option value="علبة"></option>
                  <option value="نصف كيلو"></option><option value="ربع كيلو"></option><option value="أوقية"></option>
                </datalist>
              </div>
              <div class="field">
                <label>تحتوي على كم؟ (المحتوى)</label>
                <input class="control" id="sale-new-unit-factor" type="number" min="0.000001" step="0.000001" placeholder="مثلاً: 12 أو 25 أو 50">
              </div>
              <div class="field">
                <label>من الوحدة الأساسية (الصغرى)</label>
                <input class="control" id="sale-new-unit-base-label" list="common-base-names" value="كيلو" placeholder="علبة / كيلو / باكت / حبة">
                <datalist id="common-base-names">
                  <option value="كيلو"></option><option value="علبة"></option><option value="باكت"></option>
                  <option value="حبة"></option><option value="أوقية"></option><option value="قرص"></option>
                </datalist>
              </div>
              <div class="field"><label>سعر الشراء للعبوة</label><input class="control" id="sale-new-unit-purchase" type="number" min="0" step="0.01" value="0"></div>
              <div class="field"><label>سعر البيع للعبوة</label><input class="control" id="sale-new-unit-sale" type="number" min="0" step="0.01" value="0"></div>
            </div>
            <div class="sale-unit-actions">
              <button class="btn" type="button" id="sale-save-new-unit" data-action="save-sale-unit">💾 حفظ وإضافة / تحديث الوحدة</button>
              <button class="btn light" type="button" data-action="toggle-sale-unit">إغلاق اللوحة</button>
            </div>
            <div id="draft-units-table-wrap"></div>
          </div>` : ''}
        </section>

        <section class="sale-section sale-sheet-section">
          <div class="sale-section-heading">
            <div><h3>جدول بنود المستند (قابل للتعديل المباشر)</h3><p>يمكنك تعديل الوحدة والكمية والسعر مباشرة داخل الجدول قبل الحفظ والترحيل.</p></div>
            <span class="badge" id="sale-lines-count">0 بند</span>
          </div>
          <div class="table-wrap sale-sheet-wrap">
            <table class="sale-sheet-table">
              <thead><tr><th style="width:42px;text-align:center">م</th><th>الصنف</th><th>الوحدة</th><th>${isPurchaseSide ? 'سعر الشراء' : 'السعر'}</th><th>الكمية</th>${showInternalCost ? '<th>سعر الشراء الداخلي</th><th>الربح التقديري</th>' : ''}<th>المجموع</th><th>إجراء</th></tr></thead>
              <tbody id="sale-lines-body"></tbody>
              <tfoot id="sale-lines-tfoot"></tfoot>
            </table>
          </div>
        </section>

        <section class="sale-summary-grid">
          <div class="sale-notes">
            <label for="sale-notes">ملاحظات المستند</label>
            <textarea class="control" id="sale-notes" name="notes" rows="3" placeholder="ملاحظات إضافية…"></textarea>
          </div>
          <div class="sale-totals">
            <div><span>الإجمالي قبل الخصم والضريبة</span><b id="sale-subtotal">0</b></div>
            <div class="sale-adjust"><label for="sale-discount">الخصم (مبلغ)</label><input class="control" id="sale-discount" name="discount" type="number" min="0" step="0.01" value="0"></div>
            <div class="sale-adjust"><label for="sale-tax">الضريبة (مبلغ)</label><input class="control" id="sale-tax" name="tax" type="number" min="0" step="0.01" value="0"></div>
            <div class="sale-grand-total"><span>الإجمالي النهائي</span><strong id="sale-total">0</strong></div>
            <small class="sale-currency-caption" id="sale-currency-caption">${escapeHtml(currencyName(activeSaleCurrency))}</small>
          </div>
        </section>

        <div class="sale-form-actions">
          <button class="btn sale-save-btn" type="submit">💾 حفظ وترحيل ${titleMap[docType]}</button>
          <button class="btn light" type="button" data-action="close-modal">إلغاء</button>
        </div>
      </form>`, true);

    const form = $('#sale-form');
    activeSaleLines = [];
    saleLineSequence = 0;
    setSaleEntryProduct(null);
    renderSaleLines();

    const productInput = $('#sale-entry-name');
    const resolveEntryProduct = () => {
      const raw = productInput.value.trim();
      const product = saleFindProduct(raw);
      setSaleEntryProduct(product || null, raw);
    };
    productInput.addEventListener('input', resolveEntryProduct);
    productInput.addEventListener('change', resolveEntryProduct);
    $('#sale-entry-unit').addEventListener('change', () => { updateSaleEntryUnitDefaults(); renderSaleTotals(); });
    $('#sale-entry-qty').addEventListener('input', renderSaleTotals);
    $('#sale-entry-price').addEventListener('input', renderSaleTotals);
    $('#sale-entry-purchase-price')?.addEventListener('input', renderSaleTotals);

    $('#sale-lines-body').addEventListener('input', e => {
      const row = e.target.closest('tr[data-line-key]');
      if (!row) return;
      const line = activeSaleLines.find(x => x.key === row.dataset.lineKey);
      if (!line) return;
      if (e.target.classList.contains('sale-edit-qty')) line.quantity = Number(e.target.value || 0);
      if (e.target.classList.contains('sale-edit-price')) line.unit_price = Number(e.target.value || 0);
      if (e.target.classList.contains('sale-edit-cost')) line.purchase_price = e.target.value === '' ? '' : Number(e.target.value);
      const total = row.querySelector('.sale-line-total');
      if (total) total.textContent = money(line.quantity * line.unit_price, 4);
      const profit = row.querySelector('.internal-profit');
      if (profit) profit.textContent = line.purchase_price === '' ? '—' : money((line.unit_price - line.purchase_price) * line.quantity, 4);
      renderSaleTotals();
    });

    $('#sale-lines-body').addEventListener('change', e => {
      if (!e.target.classList.contains('sale-edit-unit')) return;
      const row = e.target.closest('tr[data-line-key]');
      const line = activeSaleLines.find(x => x.key === row?.dataset.lineKey);
      if (!line) return;
      const product = activeSaleProducts.find(x => x.id === line.product_id);
      const unit = product?.units.find(x => x.id === e.target.value);
      if (!unit) return;
      line.unit_id = unit.id;
      line.unit_name = unit.unit_name;
      line.factor_to_base = Number(unit.factor_to_base);
      const curr = saleCurrentCurrency();
      const defVal = isPurchaseSide ? unit.purchase_price : unit.sale_price;
      line.unit_price = unit.currency === curr && Number(defVal) > 0 ? Number(defVal) : line.unit_price;
      line.purchase_price = showInternalCost ? saleDefaultPurchasePrice(product, unit) : '';
      renderSaleLines();
    });

    const customerInput = $('#sale-customer-name');
    customerInput.addEventListener('input', () => {
      const person = salePartyMatches(customerInput.value, eligibleParties);
      $('#sale-party-id').value = person?.id || '';
      if (person) {
        $('#sale-customer-phone').value = person.phone || '';
        $('#sale-customer-hint').textContent = `تم الربط مع ${partyLabel} المسجل ✓`;
      } else {
        $('#sale-customer-hint').textContent = isPurchaseSide ? 'يرجى اختيار مورد مسجل من القائمة.' : 'اسم يدوي لعميل نقدي؛ الفاتورة الآجلة تتطلب اختيار عميل مسجل.';
      }
    });

    form.elements.settlement_method.addEventListener('change', () => {
      form.elements.cash_account_id.disabled = form.elements.settlement_method.value === 'credit';
    });

    form.elements.currency.addEventListener('change', async () => {
      const curr = form.elements.currency.value;
      if (activeSaleLines.length) {
        toast('لا يمكن تغيير العملة بعد إضافة البنود؛ احذف البنود أولاً إذا أردت تغييرها.', true);
        form.elements.currency.value = activeSaleCurrency;
        return;
      }
      activeSaleCurrency = curr;
      const eligible = cash.filter(x => x.currency === curr);
      form.elements.cash_account_id.innerHTML = eligible.map(x => `<option value="${x.id}">${escapeHtml(x.name)} · ${x.currency}</option>`).join('');
      form.elements.cash_account_id.disabled = form.elements.settlement_method.value === 'credit' || !eligible.length;
      $('#sale-currency-caption').textContent = currencyName(curr);
      await loadRateInto(form, curr);
      updateSaleEntryUnitDefaults();
      renderSaleTotals();
    });

    form.elements.document_date.addEventListener('change', () => loadRateInto(form, activeSaleCurrency));
    $('#sale-discount').addEventListener('input', renderSaleTotals);
    $('#sale-tax').addEventListener('input', renderSaleTotals);
    await loadRateInto(form, activeSaleCurrency);
    form.onsubmit = submitUnifiedInvoice;
  } catch (err) {
    toast(err.message || 'تعذر فتح نافذة الفاتورة', true);
  }
}

async function submitUnifiedInvoice(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form));
  if (!activeSaleLines.length) { toast('أضف صنفاً واحداً على الأقل إلى جدول الفاتورة', true); return; }
  const isPurchaseSide = ['purchase', 'purchase_return'].includes(activeInvoiceDocType);
  const showInternalCost = false;

  const lines = [];
  for (const line of activeSaleLines) {
    const quantity = Number(line.quantity || 0), unitPrice = Number(line.unit_price || 0);
    if (!line.product_id || !line.unit_id || quantity <= 0 || unitPrice <= 0) {
      toast(`تحقق من الكمية والسعر للصنف: ${line.product_name}`, true);
      return;
    }
    lines.push({
      product_id: line.product_id,
      unit_id: line.unit_id,
      quantity,
      unit_price: unitPrice,
      ...(showInternalCost && line.purchase_price !== '' ? { purchase_unit_price: Number(line.purchase_price) } : {})
    });
  }

  const settlement = data.settlement_method || 'cash';
  const partyId = data.party_id || null;
  if ((isPurchaseSide || settlement === 'credit') && !partyId) {
    toast(`يتطلب هذا المستند اختيار ${isPurchaseSide ? 'مورد' : 'عميل'} مسجل من القائمة`, true);
    return;
  }
  const cashAccountId = settlement === 'credit' ? null : (form.elements.cash_account_id?.value || data.cash_account_id);
  if (settlement === 'cash' && !cashAccountId) {
    toast('لا يوجد صندوق نشط بهذه العملة', true);
    return;
  }

  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0);
  const discount = Number(data.discount || 0), tax = Number(data.tax || 0);
  if (discount < 0 || tax < 0 || discount > subtotal || subtotal - discount + tax <= 0) {
    toast('تحقق من الخصم والضريبة والإجمالي', true);
    return;
  }

  const partyName = String(data.party_name || '').trim();
  const partyPhone = String(data.party_phone || '').trim();
  const notes = [
    partyName ? `اسم العميل: ${partyName}` : '',
    partyPhone ? `هاتف العميل: ${partyPhone}` : '',
    String(data.notes || '').trim()
  ].filter(Boolean).join('\n');

  const payload = {
    doc_type: activeInvoiceDocType,
    document_date: data.document_date,
    currency: activeSaleCurrency,
    exchange_rate: Number(form.elements.exchange_rate?.value || data.exchange_rate || 1),
    settlement_method: settlement,
    cash_account_id: cashAccountId,
    party_id: partyId,
    discount,
    tax,
    notes,
    lines
  };

  const submit = $('button[type=submit]', form);
  submit.disabled = true;
  submit.textContent = 'جارٍ الحفظ والترحيل…';
  const { data: docId, error } = await supabase.rpc('post_document', { p_payload: payload });
  if (error) {
    submit.disabled = false;
    submit.textContent = '💾 حفظ وترحيل المستند';
    toast(error.message, true);
    return;
  }
  activeSaleLines = [];
  closeModal();
  cachedProducts = [];
  cachedParties = [];
  toast('تم حفظ المستند وترحيله بنجاح');
  currentPage = isPurchaseSide ? 'purchases' : 'sales';
  await renderPage();
  await viewDocument(docId);
}

/* ============================================================================
   VOUCHERS MODAL (EXPENSE, RECEIPT, PAYMENT)
   ============================================================================ */
async function openDoc(type) {
  if (['sale', 'purchase', 'sale_return', 'purchase_return'].includes(type)) {
    return openUnifiedInvoice(type);
  }
  try {
    const [parties, cash, settings] = await Promise.all([
      loadParties(), loadCash(),
      queryOrThrow(supabase.from('settings').select('base_currency').eq('id', 1).single())
    ]);
    const partyKind = type === 'payment' || type === 'expense' ? 'supplier' : 'customer';
    const partyOptions = [
      { value: '', label: type === 'expense' ? '— مصروف نقدي مباشر بدون مورد —' : '— اختر الطرف —' },
      ...parties.filter(p => p.party_type === partyKind || p.party_type === 'both').map(p => ({ value: p.id, label: p.name }))
    ];
    const defaultCurrency = settings.base_currency || 'YER';
    const eligibleCash = cash.filter(x => x.currency === defaultCurrency);
    const expenseAccounts = type === 'expense'
      ? await queryOrThrow(supabase.from('accounts').select('id,code,name').eq('account_type', 'expense').order('code'))
      : [];

    const html = `
      <form id="doc-form">
        <div class="form-grid">
          ${selectField('العملة', 'currency', [{ value: 'YER', label: 'ريال يمني' }, { value: 'SAR', label: 'ريال سعودي' }, { value: 'USD', label: 'دولار أمريكي' }], defaultCurrency)}
          ${field('التاريخ', 'document_date', new Date().toISOString().slice(0, 10), 'date', { required: true })}
          ${selectField(type === 'payment' ? 'المورد' : type === 'receipt' ? 'العميل' : 'المورد (للمصروف الآجل)', 'party_id', partyOptions, '')}
          ${['receipt', 'payment'].includes(type) ? '<input type="hidden" name="settlement_method" value="cash">' : selectField('طريقة السداد', 'settlement_method', [{ value: 'cash', label: 'نقدي (من الصندوق)' }, { value: 'credit', label: 'آجل (على ذمة المورد)' }], 'cash')}
          ${selectField('الصندوق', 'cash_account_id', eligibleCash.map(x => ({ value: x.id, label: `${x.name} · ${x.currency}` })), eligibleCash[0]?.id || '')}
          ${type === 'expense' ? selectField('حساب المصروف', 'expense_account_id', expenseAccounts.map(a => ({ value: a.id, label: `${a.code} - ${a.name}` })), expenseAccounts[0]?.id || '') : ''}
          ${field('سعر الصرف إلى العملة الأساسية', 'exchange_rate', '1', 'number', { step: '0.00000001', required: true, readonly: true })}
          ${field('المبلغ', 'amount', '', 'number', { step: '0.01', min: '0.01', required: true })}
        </div>
        ${field('البيان والتفاصيل', 'notes', '', 'text', { full: true, required: true, placeholder: 'اكتب بيان السند بالتفصيل…' })}
        <div class="total-box"><span>إجمالي السند</span><strong id="doc-total">0</strong></div>
        <div class="form-actions">
          <button class="btn" type="submit">حفظ وترحيل ${docTypeLabel(type)}</button>
          <button class="btn light" type="button" data-action="close-modal">إلغاء</button>
        </div>
      </form>`;

    modal(docTypeLabel(type), html);
    const form = $('#doc-form');
    form.elements.settlement_method?.addEventListener('change', () => {
      form.elements.cash_account_id.disabled = form.elements.settlement_method.value === 'credit';
    });
    form.elements.currency.addEventListener('change', () => {
      const curr = form.elements.currency.value;
      const matching = cash.filter(x => x.currency === curr);
      form.elements.cash_account_id.innerHTML = matching.map(x => `<option value="${x.id}">${escapeHtml(x.name)} · ${x.currency}</option>`).join('');
      loadRateInto(form, curr);
    });
    form.elements.document_date.addEventListener('change', () => loadRateInto(form, form.elements.currency.value));
    form.elements.amount.addEventListener('input', () => {
      $('#doc-total').textContent = money(form.elements.amount.value || 0) + ' ' + form.elements.currency.value;
    });
    form.onsubmit = async e => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      const payload = {
        doc_type: type,
        document_date: d.document_date,
        currency: d.currency,
        exchange_rate: Number(form.elements.exchange_rate.value || 1),
        settlement_method: d.settlement_method || 'cash',
        cash_account_id: d.settlement_method === 'credit' ? null : form.elements.cash_account_id.value,
        party_id: d.party_id || null,
        expense_account_id: d.expense_account_id || null,
        notes: d.notes || '',
        amount: Number(d.amount || 0),
        lines: []
      };
      const submit = $('button[type=submit]', form);
      submit.disabled = true;
      submit.textContent = 'جارٍ الترحيل…';
      const { data: docId, error } = await supabase.rpc('post_document', { p_payload: payload });
      if (error) {
        submit.disabled = false;
        submit.textContent = 'حفظ وترحيل ' + docTypeLabel(type);
        toast(error.message, true);
        return;
      }
      closeModal();
      toast('تم حفظ السند وترحيله بنجاح');
      currentPage = type === 'expense' ? 'expenses' : 'cash';
      await renderPage();
      await viewDocument(docId);
    };
  } catch (e) {
    toast(e.message || 'تعذر فتح نموذج السند', true);
  }
}

async function loadRateInto(form, currency) {
  try {
    const s = await queryOrThrow(supabase.from('settings').select('base_currency').eq('id', 1).single());
    if (currency === s.base_currency) {
      form.elements.exchange_rate.value = '1';
      return;
    }
    const r = await supabase.from('exchange_rates').select('rate')
      .eq('from_currency', currency)
      .eq('to_currency', s.base_currency)
      .lte('effective_date', form.elements.document_date.value || new Date().toISOString().slice(0, 10))
      .order('effective_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (r.data) form.elements.exchange_rate.value = r.data.rate;
    else {
      form.elements.exchange_rate.value = '';
      toast('سجّل سعر صرف هذه العملة أولاً من الإعدادات', true);
    }
  } catch (_e) {
    form.elements.exchange_rate.value = '1';
  }
}

/* ============================================================================
   PRODUCT MODAL (WITH STRUCTURED MULTI-UNIT TABLE & SAFE EDIT LOCKS)
   ============================================================================ */
async function applyProductStockTarget(productId, currentQty, targetQty, unitCostBase, notes = 'تحديث الكمية المتوفرة من بطاقة الصنف') {
  const diff = Number((Number(targetQty || 0) - Number(currentQty || 0)).toFixed(6));
  if (Math.abs(diff) < 0.000001) return { ok: true };
  const safeCost = Number(unitCostBase) > 0 ? Number(unitCostBase) : 1;

  try {
    // First try set_opening_stock if currentQty === 0 and targetQty > 0
    if (Number(currentQty || 0) === 0 && targetQty > 0) {
      const opened = await supabase.rpc('set_opening_stock', {
        p_product_id: productId,
        p_quantity_base: Number(targetQty),
        p_unit_cost_base: safeCost
      });
      if (!opened.error) return { ok: true };
      // If set_opening_stock failed because prior movements exist, fall through to post_stock_adjustment
    }

    const adj = await supabase.rpc('post_stock_adjustment', {
      p_payload: {
        product_id: productId,
        direction: diff > 0 ? 'in' : 'out',
        quantity_base: Math.abs(diff),
        unit_cost_base: safeCost,
        notes
      }
    });
    if (adj.error) return { ok: false, error: adj.error.message || String(adj.error) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

async function openStockQtyModal(productId) {
  if (!canFinance()) return;
  const products = await loadProducts();
  const inventory = await loadInventorySummary();
  const prod = products.find(p => p.id === productId);
  if (!prod) { toast('الصنف غير موجود', true); return; }
  const currentQty = Number(inventory.find(x => String(x.id) === String(productId))?.quantity || 0);
  const baseUnitObj = (prod.units || []).find(u => u.is_base) || prod.units?.[0];
  const defaultCost = Number(prod.avg_cost_base || baseUnitObj?.purchase_price || 1);

  const unitOpts = (prod.units || [{ unit_name: prod.base_unit, factor_to_base: 1 }]).map(u =>
    `<option value="${u.factor_to_base}" ${u.is_base ? 'selected' : ''}>${escapeHtml(u.unit_name)} (تساوي ${u.factor_to_base} ${escapeHtml(prod.base_unit)})</option>`
  ).join('');

  modal(`📦 نافذة الكمية المتوفرة للصنف: ${prod.name}`, `
    <form id="quick-stock-qty-form" class="form-grid">
      <div class="field full">
        <div class="stock-qty-window-card">
          <div class="stock-qty-window-head">
            <div>
              <b>الرصيد المتوفر حالياً في المخزون</b>
              <div class="hint">حدد الكمية المتوفرة الجديدة بالوحدة الأساسية أو بالعبوة ليتم تحديث المخزون فوراً</div>
            </div>
            <span class="badge gold" style="font-size:14px;padding:7px 14px">${money(currentQty, 4)} ${escapeHtml(prod.base_unit)}</span>
          </div>
          <div class="form-grid" style="margin-top:10px">
            <div class="field">
              <label>طريقة إدخال الكمية</label>
              <select class="control" id="qsq-mode">
                <option value="set">تعيين إجمالي الكمية المتوفرة الفعلية</option>
                <option value="add">➕ إضافة كمية جديدة فوق الرصيد الحالي</option>
                <option value="sub">➖ خصم كمية من الرصيد الحالي</option>
              </select>
            </div>
            <div class="field">
              <label>الوحدة المستخدمة للإدخال</label>
              <select class="control" id="qsq-unit-factor">${unitOpts}</select>
            </div>
            <div class="field">
              <label id="qsq-qty-label">الكمية المتوفرة الفعلية</label>
              <input class="control" id="qsq-qty-input" type="number" step="0.0001" min="0" value="${currentQty}" required>
            </div>
            <div class="field">
              <label>تكلفة الوحدة الأساسية (${escapeHtml(prod.base_unit)})</label>
              <input class="control" id="qsq-cost-input" type="number" step="0.01" min="0.01" value="${defaultCost > 0 ? defaultCost : 1}" required>
            </div>
          </div>
          <div class="preset-chips" style="margin-top:8px">
            <button type="button" class="preset-chip" data-qsq-add="1">+1</button>
            <button type="button" class="preset-chip" data-qsq-add="5">+5</button>
            <button type="button" class="preset-chip" data-qsq-add="10">+10</button>
            <button type="button" class="preset-chip" data-qsq-add="25">+25</button>
            <button type="button" class="preset-chip" data-qsq-add="50">+50</button>
            <button type="button" class="preset-chip" data-qsq-set="0">تصفير (0)</button>
          </div>
          <div class="total-box" style="margin-top:10px">
            <span>الرصيد النهائي بعد الحفظ (بالوحدة الأساسية: ${escapeHtml(prod.base_unit)})</span>
            <strong id="qsq-final-preview">${money(currentQty, 4)} ${escapeHtml(prod.base_unit)}</strong>
          </div>
        </div>
      </div>
      <div class="field full form-actions">
        <button class="btn gold" type="submit">💾 حفظ وتحديث الكمية المتوفرة</button>
        <button class="btn light" type="button" data-action="close-modal">إلغاء</button>
      </div>
    </form>
  `);

  const calcPreview = () => {
    const mode = $('#qsq-mode').value;
    const factor = Number($('#qsq-unit-factor').value || 1);
    const val = Number($('#qsq-qty-input').value || 0) * factor;
    let target = val;
    if (mode === 'add') target = currentQty + val;
    if (mode === 'sub') target = Math.max(0, currentQty - val);
    $('#qsq-final-preview').textContent = `${money(target, 4)} ${prod.base_unit}`;
    return target;
  };

  $('#qsq-mode').addEventListener('change', () => {
    const mode = $('#qsq-mode').value;
    $('#qsq-qty-label').textContent = mode === 'set' ? 'الكمية المتوفرة الفعلية' : mode === 'add' ? 'الكمية المراد إضافتها (+)' : 'الكمية المراد خصمها (-)';
    if (mode !== 'set') $('#qsq-qty-input').value = '1';
    else $('#qsq-qty-input').value = String(currentQty);
    calcPreview();
  });
  $('#qsq-unit-factor').addEventListener('change', calcPreview);
  $('#qsq-qty-input').addEventListener('input', calcPreview);

  $('#quick-stock-qty-form').addEventListener('click', e => {
    const addBtn = e.target.closest('[data-qsq-add]');
    if (addBtn) {
      $('#qsq-qty-input').value = Number((Number($('#qsq-qty-input').value || 0) + Number(addBtn.dataset.qsqAdd)).toFixed(4));
      calcPreview();
    }
    const setBtn = e.target.closest('[data-qsq-set]');
    if (setBtn) {
      $('#qsq-mode').value = 'set';
      $('#qsq-qty-input').value = setBtn.dataset.qsqSet;
      calcPreview();
    }
  });

  $('#quick-stock-qty-form').onsubmit = async e => {
    e.preventDefault();
    const targetQty = calcPreview();
    const cost = Number($('#qsq-cost-input').value || defaultCost || 1);
    if (isPersistentOfflineSession()) {
      const localSave = await saveOfflineProduct({
        id: prod.id, name: prod.name, sku: prod.sku || null, category: prod.category || null,
        base_unit: prod.base_unit, purchase_price: Number(baseUnitObj?.purchase_price || 0),
        sale_price: Number(baseUnitObj?.sale_price || 0), currency: baseUnitObj?.currency || 'YER',
        avg_cost_base: Number(prod.avg_cost_base || cost), reorder_level: Number(prod.reorder_level || 0),
        description: prod.description || null,
        units: (prod.units || []).filter(u => !u.is_base).map(u => ({ unit_name: u.unit_name, factor_to_base: Number(u.factor_to_base), purchase_price: Number(u.purchase_price || 0), sale_price: Number(u.sale_price || 0) }))
      }, { currentQty, stockTarget: targetQty, unitCostBase: cost, notes: 'تعديل الكمية المتوفرة من نافذة الكمية' });
      if (!localSave.ok) { toast(localSave.message, true); return; }
      cachedProducts = await getCachedProducts();
      closeModal();
      await renderPage();
      await refreshOfflineBadge();
      toast(`حُفظ رصيد «${prod.name}» محلياً وسيُرحّل عند عودة الإنترنت.`);
      return;
    }
    const res = await applyProductStockTarget(productId, currentQty, targetQty, cost, 'تعديل الكمية المتوفرة من نافذة الكمية');
    if (!res.ok) {
      toast('تعذر تحديث الكمية: ' + res.error, true);
      return;
    }
    closeModal();
    cachedProducts = [];
    await loadInventorySummary();
    await renderPage();
    toast(`تم تحديث الكمية المتوفرة للصنف «${prod.name}» إلى ${money(targetQty, 4)} ${prod.base_unit}`);
  };
}

async function openProduct(id = null) {
  let old = null, baseUnitObj = null, extraUnits = [], currentQty = 0, hasMovements = false;
  if (id) {
    const pendingCachedProduct = (await getCachedProducts()).find(product => String(product.id) === String(id) && product.local_sync_state === 'pending');
    if (isPersistentOfflineSession() || pendingCachedProduct || String(id).startsWith('local-')) {
      const products = await loadProducts();
      old = pendingCachedProduct || products.find(x => String(x.id) === String(id));
      if (!old) { toast('الصنف غير موجود في النسخة المحلية. اتصل بالإنترنت لمزامنة دليل الأصناف.', true); return; }
      const units = old.units || [];
      baseUnitObj = units.find(x => x.is_base) || units.find(x => x.unit_name === old.base_unit) || units[0];
      extraUnits = units.filter(x => !x.is_base && x.id !== baseUnitObj?.id);
      const inventory = await loadInventorySummary();
      currentQty = Number(inventory.find(x => String(x.id) === String(id))?.quantity || 0);
      hasMovements = currentQty > 0;
    } else {
      const [productResult, unitsResult, invResult] = await Promise.all([
        supabase.from('v_products').select('*').eq('id', id).single(),
        supabase.from('v_product_units').select('*').eq('product_id', id),
        supabase.from('v_inventory_summary').select('quantity').eq('id', id).maybeSingle()
      ]);
      if (productResult.error || unitsResult.error) {
        toast(productResult.error?.message || unitsResult.error?.message, true);
        return;
      }
      old = productResult.data;
      const units = unitsResult.data || [];
      baseUnitObj = units.find(x => x.is_base) || units.find(x => x.unit_name === old.base_unit) || units[0];
      extraUnits = units.filter(x => !x.is_base && x.id !== baseUnitObj?.id);
      currentQty = Number(invResult.data?.quantity || 0);
      hasMovements = currentQty > 0;
    }
  }

  const unitRowsHtml = extraUnits.map(u => `
    <tr class="prod-unit-row">
      <td><input class="control pu-name" value="${escapeHtml(u.unit_name)}" placeholder="مثال: نصف كيلو"></td>
      <td><input class="control pu-factor" type="number" step="0.000001" min="0.000001" value="${u.factor_to_base}"></td>
      <td><input class="control pu-buy" type="number" step="0.01" min="0" value="${u.purchase_price || 0}"></td>
      <td><input class="control pu-sell" type="number" step="0.01" min="0" value="${u.sale_price || 0}"></td>
      <td><button type="button" class="mini red pu-del">حذف</button></td>
    </tr>`).join('');

  const productPresetChips = PACKAGING_PRESETS.slice(1, 8).map(p =>
    `<button type="button" class="preset-chip" data-prod-preset="${p.id}">📦 ${escapeHtml(p.label)}</button>`
  ).join('');

  const initialAvgCost = Number(old?.avg_cost_base || 0) > 0 ? Number(old.avg_cost_base) : Number(baseUnitObj?.purchase_price || 0);

  const body = `
    <form id="product-form" class="form-grid">
      ${field('اسم الصنف', 'name', old?.name || '', 'text', { required: true, attrs: 'id="product-name-input" data-product-autocomplete autocomplete="off" placeholder="ابدأ بكتابة اسم الصنف لعرض الأصناف المسجلة"' })}
      <div class="product-suggestions product-suggestions-modal" data-suggestions-for="product-name-input" hidden></div>
      ${field('رمز / باركود (SKU)', 'sku', old?.sku || '', 'text', { placeholder: 'SH-1009' })}
      ${field('التصنيف', 'category', old?.category || 'بهارات', 'text', { placeholder: 'بهارات / أعشاب / مبيدات / عسل' })}
      ${field('الوحدة الأساسية', 'base_unit', old?.base_unit || 'كيلو', 'text', { required: true, readonly: hasMovements })}
      ${field('سعر الشراء للوحدة الأساسية', 'purchase_price', baseUnitObj?.purchase_price || 0, 'number', { step: '0.01', min: 0 })}
      ${field('سعر البيع للوحدة الأساسية', 'sale_price', baseUnitObj?.sale_price || 0, 'number', { step: '0.01', min: 0 })}
      ${selectField('عملة الأسعار', 'currency', [{ value: 'YER', label: 'ريال يمني' }, { value: 'SAR', label: 'ريال سعودي' }, { value: 'USD', label: 'دولار أمريكي' }], baseUnitObj?.currency || 'YER')}
      ${field('حد إعادة الطلب', 'reorder_level', old?.reorder_level || 5, 'number', { step: '0.01', min: 0 })}

      <!-- نافذة / بطاقة الكمية المتوفرة في المخزون (تظهر عند الإضافة وعند تعديل الصنف) -->
      <div class="field full">
        <div class="stock-qty-window-card">
          <div class="stock-qty-window-head">
            <div>
              <b>📦 نافذة الكمية المتوفرة في المخزون</b>
              <div class="hint">${id ? `الرصيد المسجل حالياً: <b>${money(currentQty, 4)} ${escapeHtml(old?.base_unit || 'وحدة')}</b> — يمكنك تعديل الكمية المتوفرة مباشرة أو زيادتها بالأزرار السريعة:` : 'أدخل الكمية المتوفرة حالياً من هذا الصنف ليتم إثباتها في المخزون:'}</div>
            </div>
            <span class="badge gold" id="prod-modal-qty-badge">${money(currentQty, 4)} ${escapeHtml(old?.base_unit || 'كيلو')}</span>
          </div>
          <div class="form-grid" style="margin-top:10px;align-items:end">
            <div class="field" style="margin:0">
              <label>الكمية المتوفرة الفعلية (بالوحدة الأساسية)</label>
              <input class="control" id="prod-available-qty" name="available_qty" type="number" step="0.0001" min="0" value="${currentQty}">
            </div>
            <div class="field" style="margin:0">
              <label>متوسط التكلفة للوحدة الأساسية</label>
              <input class="control" id="prod-avg-cost-input" name="avg_cost_base" type="number" step="0.01" min="0" value="${initialAvgCost}" ${hasMovements ? 'readonly' : ''}>
            </div>
          </div>
          <div class="preset-chips" style="margin-top:10px;margin-bottom:0">
            <span class="muted" style="align-self:center;margin-left:4px">زيادة سريعة للكمية:</span>
            <button type="button" class="preset-chip" data-prod-qty-add="1">+1</button>
            <button type="button" class="preset-chip" data-prod-qty-add="5">+5</button>
            <button type="button" class="preset-chip" data-prod-qty-add="10">+10</button>
            <button type="button" class="preset-chip" data-prod-qty-add="12">+12 (درزن/كرتون)</button>
            <button type="button" class="preset-chip" data-prod-qty-add="25">+25</button>
            <button type="button" class="preset-chip" data-prod-qty-add="50">+50</button>
            <button type="button" class="preset-chip" data-prod-qty-set="0">تصفير (0)</button>
          </div>
        </div>
      </div>

      <div class="field full" style="margin-top:12px;background:var(--surface-2);padding:14px;border-radius:14px;border:1px solid var(--line)">
        <div class="section-head" style="margin:0 0 8px">
          <div>
            <label style="font-size:13.5px;font-weight:800;color:var(--g2)">📦 إدارة وحدات الصنف والعبوات الاحترافية (كرتون / قطمة / كيس / درزن / تجزئة)</label>
            <div class="hint">اختر قالباً جاهزاً بنقرة واحدة أو استخدم مُنشئ العبوات الذكي أو عدّل الجدول يدوياً:</div>
          </div>
          <button type="button" class="btn light" id="add-prod-unit-row">＋ إضافة سطر وحدة يدوي</button>
        </div>
        <div class="preset-chips" id="prod-preset-chips">${productPresetChips}</div>
        <div class="pack-builder-grid">
          <div class="field" style="margin:0">
            <label>اسم العبوة / الوحدة المضافة</label>
            <input class="control" id="pb-pack-name" placeholder="مثلاً: كرتون / قطمة / كيس / درزن">
          </div>
          <div class="field" style="margin:0">
            <label>تحتوي على كم؟ (العدد / الوزن)</label>
            <input class="control" id="pb-pack-factor" type="number" min="0.0001" step="0.0001" value="12">
          </div>
          <div class="field" style="margin:0">
            <label>من الوحدة الأساسية للصنف</label>
            <input class="control" id="pb-base-unit-mirror" value="${escapeHtml(old?.base_unit || 'كيلو')}" ${hasMovements ? 'readonly' : ''} placeholder="علبة / كيلو / باكت / حبة">
          </div>
          <div>
            <button type="button" class="btn gold" id="pb-generate-btn">＋ توليد وإضافة العبوة</button>
          </div>
        </div>
        <div class="table-wrap" style="margin-top:10px">
          <table>
            <thead><tr><th>اسم الوحدة / العبوة</th><th>المحتوى (كم وحدة أساسية داخلها؟)</th><th>سعر الشراء للعبوة</th><th>سعر البيع للعبوة</th><th></th></tr></thead>
            <tbody id="prod-units-tbody">${unitRowsHtml}</tbody>
          </table>
        </div>
        <small class="hint">أمثلة: كرتون يحتوي على 12 علبة (الأساسية: علبة، المحتوى: 12) · قطمة تحتوي على 25 كيلو (الأساسية: كيلو، المحتوى: 25) · نصف كيلو (المحتوى: 0.5).</small>
      </div>

      ${field('وصف وملاحظات الصنف', 'description', old?.description || '', 'text', { full: true })}
      <div class="field full form-actions">
        <button class="btn" type="submit">💾 حفظ الصنف والكمية والوحدات</button>
        <button class="btn light" type="button" data-action="close-modal">إلغاء</button>
      </div>
    </form>`;

  modal(id ? `تعديل بيانات الصنف: ${old.name}` : 'إضافة صنف جديد للدليل', body, true);

  // Sync purchase_price -> avg_cost_base automatically when avg_cost_base is 0 or untouched
  const formEl = $('#product-form');
  formEl.elements.purchase_price?.addEventListener('input', e => {
    if (!hasMovements) {
      const buyVal = Number(e.target.value || 0);
      if (buyVal > 0 && $('#prod-avg-cost-input')) {
        $('#prod-avg-cost-input').value = buyVal;
      }
    }
  });

  const updateQtyBadge = () => {
    const q = Number($('#prod-available-qty')?.value || 0);
    const bUnit = formEl.elements.base_unit?.value || 'وحدة';
    if ($('#prod-modal-qty-badge')) $('#prod-modal-qty-badge').textContent = `${money(q, 4)} ${bUnit}`;
  };
  $('#prod-available-qty')?.addEventListener('input', updateQtyBadge);

  formEl.addEventListener('click', e => {
    const addBtn = e.target.closest('[data-prod-qty-add]');
    if (addBtn) {
      const inp = $('#prod-available-qty');
      if (inp) {
        inp.value = Number((Number(inp.value || 0) + Number(addBtn.dataset.prodQtyAdd)).toFixed(4));
        updateQtyBadge();
      }
    }
    const setBtn = e.target.closest('[data-prod-qty-set]');
    if (setBtn) {
      const inp = $('#prod-available-qty');
      if (inp) {
        inp.value = setBtn.dataset.prodQtySet;
        updateQtyBadge();
      }
    }
  });

  const addUnitRowToProductModal = (uName, factor, customBuy = null, customSell = null) => {
    const baseBuy = Number($('#product-form').elements.purchase_price.value || 0);
    const baseSell = Number($('#product-form').elements.sale_price.value || 0);
    const f = Number(factor || 1);
    const buyVal = customBuy !== null ? customBuy : Number((baseBuy * f).toFixed(2));
    const sellVal = customSell !== null ? customSell : Number((baseSell * f).toFixed(2));
    const existingRow = [...$$('#prod-units-tbody .prod-unit-row')].find(r => $('.pu-name', r)?.value.trim() === uName);
    if (existingRow) {
      $('.pu-factor', existingRow).value = f;
      $('.pu-buy', existingRow).value = buyVal;
      $('.pu-sell', existingRow).value = sellVal;
      return;
    }
    const tr = document.createElement('tr');
    tr.className = 'prod-unit-row';
    tr.innerHTML = `
      <td><input class="control pu-name" value="${escapeHtml(uName)}" placeholder="اسم الوحدة / العبوة"></td>
      <td><input class="control pu-factor" type="number" step="0.000001" min="0.000001" value="${f}"></td>
      <td><input class="control pu-buy" type="number" step="0.01" min="0" value="${buyVal}"></td>
      <td><input class="control pu-sell" type="number" step="0.01" min="0" value="${sellVal}"></td>
      <td><button type="button" class="mini red pu-del">حذف</button></td>`;
    $('#prod-units-tbody').append(tr);
  };

  $('#pb-base-unit-mirror')?.addEventListener('input', e => {
    if (!hasMovements && $('#product-form').elements.base_unit) {
      $('#product-form').elements.base_unit.value = e.target.value;
      updateQtyBadge();
    }
  });
  $('#product-form').elements.base_unit?.addEventListener('input', e => {
    if ($('#pb-base-unit-mirror')) $('#pb-base-unit-mirror').value = e.target.value;
    updateQtyBadge();
  });

  $('#prod-preset-chips')?.addEventListener('click', e => {
    const btnEl = e.target.closest('[data-prod-preset]');
    if (!btnEl) return;
    const preset = PACKAGING_PRESETS.find(p => p.id === btnEl.dataset.prodPreset);
    if (!preset) return;
    if (!hasMovements) {
      $('#product-form').elements.base_unit.value = preset.base_unit;
      if ($('#pb-base-unit-mirror')) $('#pb-base-unit-mirror').value = preset.base_unit;
      updateQtyBadge();
    }
    if ($('#pb-pack-name')) $('#pb-pack-name').value = preset.pack_unit;
    if ($('#pb-pack-factor')) $('#pb-pack-factor').value = preset.factor;
    addUnitRowToProductModal(preset.pack_unit, preset.factor);
    for (const su of (preset.sub_units || [])) {
      addUnitRowToProductModal(su.unit_name, su.factor_to_base);
    }
    toast(`تمت إضافة قالب «${preset.label}» إلى جدول وحدات الصنف`);
  });

  $('#pb-generate-btn')?.addEventListener('click', () => {
    const pName = String($('#pb-pack-name')?.value || '').trim();
    const pFactor = Number($('#pb-pack-factor')?.value || 0);
    const bName = String($('#pb-base-unit-mirror')?.value || '').trim() || 'كيلو';
    if (!pName || pFactor <= 0) {
      toast('أدخل اسم العبوة (مثلاً: كرتون / قطمة) والمحتوى (أكبر من صفر)', true);
      return;
    }
    if (!hasMovements) {
      $('#product-form').elements.base_unit.value = bName;
      updateQtyBadge();
    }
    const fullLabel = pName.includes(String(pFactor)) ? pName : `${pName} (${pFactor} ${bName})`;
    addUnitRowToProductModal(fullLabel, pFactor);
    $('#pb-pack-name').value = '';
    toast(`تمت إضافة «${fullLabel}» إلى جدول وحدات الصنف`);
  });

  $('#add-prod-unit-row').onclick = () => {
    const baseBuy = Number($('#product-form').elements.purchase_price.value || 0);
    const baseSell = Number($('#product-form').elements.sale_price.value || 0);
    const tr = document.createElement('tr');
    tr.className = 'prod-unit-row';
    tr.innerHTML = `
      <td><input class="control pu-name" placeholder="نصف كيلو / ربع كيلو"></td>
      <td><input class="control pu-factor" type="number" step="0.000001" min="0.000001" value="0.5"></td>
      <td><input class="control pu-buy" type="number" step="0.01" min="0" value="${(baseBuy * 0.5).toFixed(2)}"></td>
      <td><input class="control pu-sell" type="number" step="0.01" min="0" value="${(baseSell * 0.5).toFixed(2)}"></td>
      <td><button type="button" class="mini red pu-del">حذف</button></td>`;
    $('#prod-units-tbody').append(tr);
  };

  $('#prod-units-tbody').addEventListener('click', e => {
    if (e.target.classList.contains('pu-del')) e.target.closest('tr').remove();
  });

  $('#prod-units-tbody').addEventListener('input', e => {
    if (e.target.classList.contains('pu-factor')) {
      const tr = e.target.closest('tr');
      const f = Number(e.target.value || 0);
      const baseBuy = Number($('#product-form').elements.purchase_price.value || 0);
      const baseSell = Number($('#product-form').elements.sale_price.value || 0);
      if (f > 0) {
        if ($('.pu-buy', tr)) $('.pu-buy', tr).value = Number((baseBuy * f).toFixed(2));
        if ($('.pu-sell', tr)) $('.pu-sell', tr).value = Number((baseSell * f).toFixed(2));
      }
    }
  });

  $('#product-form').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const units = [];
    const names = new Set([d.base_unit.trim()]);
    for (const tr of $$('#prod-units-tbody .prod-unit-row')) {
      const unitName = String($('.pu-name', tr)?.value || '').trim();
      const factor = Number($('.pu-factor', tr)?.value || 0);
      const uBuy = Number($('.pu-buy', tr)?.value || 0);
      const uSell = Number($('.pu-sell', tr)?.value || 0);
      if (!unitName) continue;
      if (factor <= 0 || names.has(unitName)) {
        toast(`تحقق من اسم الوحدة الفرعية وعامل التحويل: ${unitName}`, true);
        return;
      }
      names.add(unitName);
      units.push({ unit_name: unitName, factor_to_base: factor, purchase_price: uBuy, sale_price: uSell });
    }

    const effectiveCost = Number(d.avg_cost_base) > 0 ? Number(d.avg_cost_base) : (Number(d.purchase_price) > 0 ? Number(d.purchase_price) : 0);

    const payload = {
      id: id || null,
      name: d.name.trim(),
      sku: d.sku ? d.sku.trim() : null,
      category: d.category || null,
      base_unit: d.base_unit.trim(),
      purchase_price: Number(d.purchase_price || 0),
      sale_price: Number(d.sale_price || 0),
      currency: d.currency,
      avg_cost_base: effectiveCost,
      reorder_level: Number(d.reorder_level || 0),
      description: d.description || null,
      units
    };

    const duplicate = findDuplicateProduct(await loadProducts(), payload, payload.id || undefined);
    if (duplicate) {
      toast(`الصنف «${duplicate.name}» موجود مسبقاً. اختره من اقتراحات البحث أو افتح سجله للتعديل.`, true);
      $('#product-name-input')?.focus();
      return;
    }

    const targetQty = Number(d.available_qty ?? currentQty);
    const cachedForEdit = payload.id ? (await getCachedProducts()).find(product => String(product.id) === String(payload.id)) : null;
    const hasPendingLocalChanges = Boolean(cachedForEdit?.local_sync_state === 'pending' || String(payload.id || '').startsWith('local-'));
    if (isPersistentOfflineSession() || hasPendingLocalChanges) {
      const savedLocal = await saveOfflineProduct(payload, {
        currentQty,
        stockTarget: targetQty,
        unitCostBase: effectiveCost > 0 ? effectiveCost : 1,
        notes: 'تحديث الكمية المتوفرة من نافذة تعديل الصنف'
      });
      if (!savedLocal.ok) { toast(savedLocal.message, true); return; }
      cachedProducts = await getCachedProducts();
      closeModal();
      await renderPage();
      await refreshOfflineBadge();
      toast('تم حفظ بيانات الصنف محلياً. ستتم مزامنتها عند توفر اتصال صالح.');
      if (navigator.onLine && supabase) await syncOfflineQueue(false);
      return;
    }

    const submitButton = $('#product-form button[type=submit]');
    if (submitButton) { submitButton.disabled = true; submitButton.textContent = 'جارٍ الحفظ…'; }
    let result;
    try {
      result = await supabase.rpc('save_product', { p_payload: payload });
    } catch (err) {
      result = { error: err };
    }
    if (result.error) {
      if (!navigator.onLine || /failed to fetch|network|fetch/i.test(result.error.message || '')) {
        const savedLocal = await saveOfflineProduct(payload, { currentQty, stockTarget: targetQty, unitCostBase: effectiveCost > 0 ? effectiveCost : 1, notes: 'تحديث الكمية المتوفرة من نافذة تعديل الصنف' });
        if (savedLocal.ok) {
          offlineSessionActive = true;
          cachedProducts = await getCachedProducts();
          closeModal();
          await renderPage();
          await refreshOfflineBadge();
          toast('انقطع الاتصال؛ حُفظ الصنف محلياً وسيتم إرساله عند عودة الإنترنت.');
          return;
        }
        toast(savedLocal.message, true);
      } else toast(result.error.message, true);
      if (submitButton) { submitButton.disabled = false; submitButton.textContent = '💾 حفظ الصنف والكمية والوحدات'; }
      return;
    }
    const productId = result.data;
    if (Math.abs(targetQty - currentQty) > 0.000001) {
      const stockRes = await applyProductStockTarget(productId, currentQty, targetQty, effectiveCost > 0 ? effectiveCost : 1, 'تحديث الكمية المتوفرة من نافذة تعديل الصنف');
      if (!stockRes.ok) {
        if (!navigator.onLine || /failed to fetch|network|fetch|timeout|load failed/i.test(stockRes.error || '')) {
          const queued = await queueOfflineStockTarget(productId, targetQty, currentQty, effectiveCost > 0 ? effectiveCost : 1, 'تحديث الكمية المتوفرة من نافذة تعديل الصنف');
          if (queued.ok) {
            offlineSessionActive = true;
            closeModal();
            cachedProducts = [];
            try { cachedProducts = await loadProducts(); } catch (_e) { cachedProducts = await getCachedProducts(); }
            await renderPage();
            await refreshOfflineBadge();
            toast('تم حفظ بيانات الصنف على الخادم، وحُفظ تعديل الرصيد محلياً وسيُزامن عند عودة الإنترنت.');
            return;
          }
        }
        closeModal();
        cachedProducts = [];
        await renderPage();
        toast('تم حفظ بيانات الصنف لكن تعذر تحديث الكمية المتوفرة: ' + stockRes.error, true);
        return;
      }
    }
    closeModal();
    cachedProducts = [];
    await loadProducts();
    await loadInventorySummary();
    await renderPage();
    toast('تم حفظ بيانات الصنف والكمية المتوفرة والوحدات بنجاح');
  };
}

/* ============================================================================
   PARTY MODAL (FIXED SUPPLIER KIND & OPENING BALANCE LOCK)
   ============================================================================ */
async function openParty(kind, id = null) {
  let old = null;
  let hasJournalLines = false;
  if (id) {
    const [{ data, error }, { count }] = await Promise.all([
      supabase.from('parties').select('*').eq('id', id).single(),
      supabase.from('journal_lines').select('id', { count: 'exact', head: true }).eq('party_id', id)
    ]);
    if (error) { toast(error.message, true); return; }
    old = data;
    hasJournalLines = Number(count || 0) > 0;
  }

  const partyKind = old?.party_type || kind || 'customer';
  const title = id
    ? `تعديل بيانات ${partyKind === 'supplier' ? 'المورد' : 'العميل'}: ${old.name}`
    : `إضافة ${partyKind === 'supplier' ? 'مورد' : 'عميل'} جديد`;

  const body = `
    <form id="party-form" class="form-grid">
      ${hasJournalLines ? `<div class="field full"><div class="alert info">🔒 توجد قيود محاسبية مرحّلة لهذا الطرف؛ لذلك تم قفل حقول الرصيد الافتتاحي لحماية دفتر الأستاذ. يمكنك تحديث الاسم والهاتف والعنوان والملاحظات بحرية.</div></div>` : ''}
      ${selectField('نوع الطرف', 'party_type', [{ value: 'customer', label: 'عميل' }, { value: 'supplier', label: 'مورد' }, { value: 'both', label: 'عميل ومورد معاً' }], partyKind)}
      ${field('الاسم الكامل / المنشأة', 'name', old?.name || '', 'text', { required: true })}
      ${field('رقم الهاتف / واتساب', 'phone', old?.phone || '', 'text', { placeholder: '+9677xxxxxxxx' })}
      ${field('العنوان', 'address', old?.address || '')}
      ${field('الرصيد الافتتاحي', 'opening_balance', old?.opening_balance || 0, 'number', { step: '0.01', readonly: hasJournalLines })}
      ${selectField('طبيعة الرصيد الافتتاحي', 'opening_balance_side', [
        { value: 'none', label: 'بدون رصيد افتتاحي' },
        { value: 'receivable', label: 'مبلغ مستحق لنا (مدين / عميل)' },
        { value: 'payable', label: 'مبلغ مستحق علينا (دائن / مورد)' }
      ], old?.opening_balance_side || (partyKind === 'supplier' ? 'payable' : 'receivable'), false, hasJournalLines)}
      ${selectField('عملة الرصيد الافتتاحي', 'opening_currency', [
        { value: 'YER', label: 'ريال يمني' },
        { value: 'SAR', label: 'ريال سعودي' },
        { value: 'USD', label: 'دولار أمريكي' }
      ], old?.opening_currency || 'YER', false, hasJournalLines)}
      ${field('ملاحظات', 'notes', old?.notes || '', 'text', { full: true })}
      <div class="field full form-actions">
        <button class="btn" type="submit">حفظ البيانات</button>
        <button class="btn light" type="button" data-action="close-modal">إلغاء</button>
      </div>
    </form>`;

  modal(title, body);
  $('#party-form').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const updatePayload = {
      party_type: d.party_type,
      name: d.name.trim(),
      phone: d.phone || null,
      address: d.address || null,
      notes: d.notes || null
    };
    if (!hasJournalLines) {
      updatePayload.opening_balance = Number(d.opening_balance || 0);
      updatePayload.opening_balance_side = Number(d.opening_balance || 0) > 0 ? d.opening_balance_side : 'none';
      updatePayload.opening_currency = d.opening_currency || 'YER';
    }

    const r = id
      ? await supabase.from('parties').update(updatePayload).eq('id', id)
      : await supabase.from('parties').insert(updatePayload).select().single();
    if (r.error) { toast(r.error.message, true); return; }

    const partyId = r.data?.id || id;
    if (!hasJournalLines && Number(updatePayload.opening_balance || 0) > 0 && updatePayload.opening_balance_side !== 'none') {
      const op = await supabase.rpc('set_opening_party_balance', {
        p_party_id: partyId,
        p_amount: Number(updatePayload.opening_balance),
        p_currency: updatePayload.opening_currency
      });
      if (op.error) {
        closeModal();
        cachedParties = [];
        await renderPage();
        toast('تم حفظ الطرف لكن تعذر ترحيل رصيده الافتتاحي: ' + op.error.message, true);
        return;
      }
    }
    closeModal();
    cachedParties = [];
    await renderPage();
    toast('تم حفظ بيانات الطرف بنجاح');
  };
}

/* ============================================================================
   VIEW & PRINT DOCUMENT (SUPPORTS ALL 7 DOCUMENT TYPES + A4 + 80MM THERMAL)
   ============================================================================ */
async function viewDocument(id) {
  const { data, error } = await supabase.from('documents').select('*,parties(name,phone),document_lines(*)').eq('id', id).single();
  if (error) { toast(error.message, true); return; }
  activeInvoiceForActions = data;

  const isLineDoc = ['sale', 'purchase', 'sale_return', 'purchase_return'].includes(data.doc_type);
  const isPurchaseSide = ['purchase', 'purchase_return', 'payment'].includes(data.doc_type);
  const partyRoleLabel = isPurchaseSide ? 'المورد' : data.doc_type === 'expense' ? 'الجهة / المستفيد' : 'العميل';
  const partyName = data.parties?.name || noteField(data.notes, 'اسم العميل') || (data.doc_type === 'sale' ? 'عميل نقدي' : 'مباشر');
  const phone = data.parties?.phone || noteField(data.notes, 'هاتف العميل') || '—';
  const cleanNotes = String(data.notes || '').split(/\r?\n/).filter(line => !line.startsWith('اسم العميل:') && !line.startsWith('هاتف العميل:')).join('\n').trim();

  let privateCostsMap = new Map();
  if (canFinance() && data.doc_type === 'sale' && (data.document_lines || []).length) {
    try {
      const lineIds = data.document_lines.map(x => x.id);
      const privRows = await queryOrThrow(supabase.from('document_line_private_costs').select('*').in('document_line_id', lineIds));
      privRows.forEach(r => privateCostsMap.set(r.document_line_id, Number(r.purchase_unit_price)));
    } catch (_e) {
      data.document_lines.forEach(dl => {
        if (dl.private_cost !== null && dl.private_cost !== undefined) privateCostsMap.set(dl.id, Number(dl.private_cost));
      });
    }
  }

  const showPrivCol = false;
  const totalQtyDoc = (data.document_lines || []).reduce((s, x) => s + Number(x.quantity || 0), 0);
  const lineRows = (data.document_lines || []).map((x, idx) => {
    const pCost = privateCostsMap.get(x.id);
    const estProfit = pCost !== undefined ? (Number(x.unit_price) - pCost) * Number(x.quantity) : null;
    return `
      <tr>
        <td style="text-align:center;font-weight:800">${idx + 1}</td>
        <td><b>${escapeHtml(x.product_name || '')}</b></td>
        <td>${escapeHtml(x.unit_name)}</td>
        <td>${money(x.unit_price, 4)}</td>
        <td>${money(x.quantity, 4)}</td>
        ${showPrivCol ? `<td class="internal-cost-cell">${pCost !== undefined ? money(pCost, 4) : '—'}</td><td class="internal-profit">${estProfit !== null ? money(estProfit, 4) : '—'}</td>` : ''}
        <td><b>${money(x.line_total, 4)}</b></td>
      </tr>`;
  }).join('') + ((data.document_lines || []).length ? `
      <tr style="background:var(--emerald-soft);font-weight:900">
        <td colspan="4" style="color:var(--g)">المجموع الكلي للأصناف (${data.document_lines.length} أصناف)</td>
        <td style="color:var(--g)">${money(totalQtyDoc, 4)}</td>
        ${showPrivCol ? '<td colspan="2"></td>' : ''}
        <td style="color:var(--g2);font-size:14px"><b>${money(data.subtotal, 4)} ${escapeHtml(data.currency)}</b></td>
      </tr>` : '');

  const headers = ['م', 'الصنف', 'الوحدة', 'السعر', 'الكمية', ...(showPrivCol ? ['سعر الشراء (داخلي)', 'الربح التقديري'] : []), 'المجموع'];

  modal(`${docTypeLabel(data.doc_type)} — ${data.doc_no}`, `
    <div class="saved-invoice" id="saved-invoice-preview">
      <div class="invoice-official-banner-wrap" style="margin-bottom:12px">
        <img src="${BANNER_SRC}" alt="ترويسة محلات الشيباني" class="invoice-official-banner-img">
        <div class="invoice-official-title-bar">
          <span>${docTypeLabel(data.doc_type)} — رقم: ${escapeHtml(data.doc_no)}</span>
          <span>تاريخ الفاتورة: ${escapeHtml(data.document_date)}</span>
        </div>
      </div>
      <div class="saved-invoice-meta">
        <div><small>التاريخ</small><b>${escapeHtml(data.document_date)}</b></div>
        <div><small>${partyRoleLabel}</small><b>${escapeHtml(partyName)}</b></div>
        <div><small>الهاتف</small><b>${escapeHtml(phone)}</b></div>
        <div><small>طريقة السداد</small><b>${data.settlement_method === 'cash' ? 'نقدي' : 'آجل'} (${escapeHtml(data.currency)})</b></div>
      </div>
      ${isLineDoc
        ? table(headers, lineRows)
        : `<div class="panel" style="margin:14px 0;background:var(--surface-2)"><b>بيان السند:</b> ${escapeHtml(cleanNotes || '—')}</div>`}
      <div class="saved-invoice-total">
        <div><span>المجموع الفرعي</span><b>${money(data.subtotal, 4)} ${escapeHtml(data.currency)}</b></div>
        ${Number(data.discount) > 0 ? `<div><span>الخصم</span><b>${money(data.discount, 4)}</b></div>` : ''}
        ${Number(data.tax) > 0 ? `<div><span>الضريبة</span><b>${money(data.tax, 4)}</b></div>` : ''}
        <div class="grand"><span>الصافي النهائي</span><strong>${money(data.total, 4)} ${escapeHtml(data.currency)}</strong></div>
      </div>
      ${isLineDoc && cleanNotes ? `<p class="hint">ملاحظات: ${escapeHtml(cleanNotes)}</p>` : ''}
      <div class="saved-invoice-footer">محلات الشيباني للبهارات والأعشاب الطبيعية — عدن - الشيخ عثمان - شارع طرابلس 🌿</div>
    </div>
    <div class="saved-invoice-actions">
      <button class="btn" type="button" data-action="print-invoice">🖨️ طباعة A4 رسمية / PDF</button>
      <button class="btn gold" type="button" data-action="print-thermal">🧾 طباعة حرارية 80mm (كاشير)</button>
      <button class="btn outline" type="button" data-action="export-invoice-excel">📊 تنزيل جدول Excel (CSV)</button>
      <button class="btn whatsapp-btn" type="button" data-action="whatsapp-invoice">🖼️ إرسال صورة الفاتورة عبر واتساب</button>
      <button class="btn light" type="button" data-action="close-modal">إغلاق</button>
    </div>`, true);
}

function invoiceShareText(data) {
  const party = data.parties?.name || noteField(data.notes, 'اسم العميل') || 'عميلنا الكريم';
  const rows = (data.document_lines || []).map((x, i) => `${i + 1}. ${x.product_name} — ${x.unit_name} × ${money(x.quantity, 4)} = ${money(x.line_total, 4)}`).join('\n');
  return [
    `محلات الشيباني للبهارات والأعشاب الطبيعية`,
    `${docTypeLabel(data.doc_type)}: ${data.doc_no}`,
    `التاريخ: ${data.document_date}`,
    `الطرف: ${party}`,
    rows,
    `الإجمالي الصافي: ${money(data.total, 4)} ${data.currency}`,
    `طريقة السداد: ${data.settlement_method === 'cash' ? 'نقدي' : 'آجل'}`,
    `شكراً لتعاملكم معنا 🌿`
  ].filter(Boolean).join('\n');
}

function invoiceImageMarkup(data) {
  const party = data.parties?.name || noteField(data.notes, 'اسم العميل') || 'عميل نقدي';
  const phone = data.parties?.phone || noteField(data.notes, 'هاتف العميل') || '—';
  const lines = (data.document_lines || []).map((x, i) => `
    <tr><td>${i + 1}</td><td>${escapeHtml(x.product_name || '')}</td><td>${escapeHtml(x.unit_name || '')}</td>
    <td>${money(x.unit_price, 4)}</td><td>${money(x.quantity, 4)}</td><td>${money(x.line_total, 4)}</td></tr>`).join('');
  const notes = String(data.notes || '').split(/\r?\n/).filter(line => !line.startsWith('اسم العميل:') && !line.startsWith('هاتف العميل:')).join(' · ').trim();
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;background:#fff;color:#18372e;font-family:Tahoma,Arial,sans-serif;width:1000px;padding:34px}
    .sheet{border:2px solid #d7e3dc;border-radius:22px;overflow:hidden;background:#fff}
    .brand{background:#0d4436;color:#fff;padding:28px 34px;text-align:center;border-bottom:7px solid #c89b3c}
    .brand h1{font-size:34px;margin:0 0 8px}.brand p{font-size:18px;margin:0;color:#e6eee9}
    .title{display:flex;justify-content:space-between;gap:20px;background:#f0f6f2;padding:20px 30px;font-size:22px;font-weight:bold}
    .meta{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:24px 30px}
    .meta div{background:#f7faf8;border:1px solid #e0e9e3;border-radius:12px;padding:14px}.meta small{display:block;color:#687b72;font-size:15px;margin-bottom:7px}.meta b{font-size:19px}
    table{width:calc(100% - 60px);margin:0 30px;border-collapse:collapse;font-size:17px}th{background:#0d4436;color:#fff;font-size:17px}th,td{padding:14px 10px;border:1px solid #dce6e0;text-align:center}td:nth-child(2){text-align:right;font-weight:bold}
    .totals{width:430px;margin:24px 30px 24px auto;background:#f5f8f6;border-radius:14px;padding:18px 22px}.totals div{display:flex;justify-content:space-between;padding:9px 0;font-size:19px;border-bottom:1px solid #dfe8e2}.totals .grand{font-size:25px;color:#0d4436;font-weight:bold;border:0}
    .notes{margin:0 30px 22px;padding:14px;background:#fff8e8;border-right:5px solid #c89b3c;font-size:16px}.foot{background:#f0f6f2;text-align:center;padding:20px;color:#0d4436;font-size:17px;font-weight:bold}
  </style></head><body><main class="sheet"><header class="brand"><h1>محلات الشيباني</h1><p>للبهارات والأعشاب الطبيعية 🌿</p></header>
  <section class="title"><span>${docTypeLabel(data.doc_type)} — ${escapeHtml(data.doc_no)}</span><span>التاريخ: ${escapeHtml(data.document_date)}</span></section>
  <section class="meta"><div><small>العميل / الطرف</small><b>${escapeHtml(party)}</b></div><div><small>رقم الهاتف</small><b>${escapeHtml(phone)}</b></div><div><small>طريقة السداد</small><b>${data.settlement_method === 'cash' ? 'نقدي' : 'آجل'} — ${escapeHtml(data.currency)}</b></div></section>
  ${lines ? `<table><thead><tr><th>م</th><th>الصنف</th><th>الوحدة</th><th>السعر</th><th>الكمية</th><th>الإجمالي</th></tr></thead><tbody>${lines}</tbody></table>` : `<p class="notes">${escapeHtml(notes || '—')}</p>`}
  <section class="totals"><div><span>المجموع الفرعي</span><b>${money(data.subtotal,4)} ${escapeHtml(data.currency)}</b></div>${Number(data.discount)>0?`<div><span>الخصم</span><b>${money(data.discount,4)}</b></div>`:''}${Number(data.tax)>0?`<div><span>الضريبة</span><b>${money(data.tax,4)}</b></div>`:''}<div class="grand"><span>الصافي النهائي</span><b>${money(data.total,4)} ${escapeHtml(data.currency)}</b></div></section>
  ${notes && lines ? `<p class="notes">ملاحظات: ${escapeHtml(notes)}</p>`:''}<footer class="foot">عدن - الشيخ عثمان - شارع طرابلس<br>شكراً لتعاملكم مع محلات الشيباني 🌿</footer></main></body></html>`;
}

async function renderInvoicePng(data) {
  const html = invoiceImageMarkup(data);
  const styleBlock = html.match(/<style>[\s\S]*?<\/style>/i)?.[0] || '';
  const bodyMarkup = html.replace(/^<!doctype html><html[^>]*><head>[\s\S]*?<\/head><body>/i, '').replace(/<\/body><\/html>$/i, '');
  const imageHeight = Math.max(1000, 850 + (data.document_lines || []).length * 58 + (data.notes ? 80 : 0));
  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="1060" height="${imageHeight}"><foreignObject x="0" y="0" width="1060" height="${imageHeight}"><xhtml:div xmlns="http://www.w3.org/1999/xhtml" style="width:1060px;height:${imageHeight}px;background:#fff">${styleBlock}${bodyMarkup}</xhtml:div></foreignObject></svg>`;
  const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = () => reject(new Error('تعذر تحويل الفاتورة إلى صورة على هذا المتصفح.')); img.src = svgUrl; });
    const canvas = document.createElement('canvas');
    canvas.width = 1060;
    canvas.height = Math.max(1000, Math.min(5000, imageHeight));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('ميزة إنشاء الصور غير متاحة في هذا المتصفح.');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('فشل إنشاء ملف صورة الفاتورة.');
    return blob;
  } finally { URL.revokeObjectURL(svgUrl); }
}

async function shareSalesInvoice(data) {
  const button = $('[data-action="whatsapp-invoice"]');
  if (button) { button.disabled = true; button.textContent = '⏳ جارٍ تجهيز صورة الفاتورة…'; }
  try {
    const png = await renderInvoicePng(data);
    const file = new File([png], `فاتورة_${String(data.doc_no || 'الشيباني').replace(/[^\w\u0600-\u06FF-]/g,'_')}.png`, { type: 'image/png' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: `فاتورة ${data.doc_no}`, text: `فاتورة ${data.doc_no} من محلات الشيباني` });
      toast('تم فتح مشاركة صورة الفاتورة. اختر واتساب ثم المحادثة المطلوبة.');
      return;
    }
    const imageUrl = URL.createObjectURL(png);
    const a = document.createElement('a'); a.href = imageUrl; a.download = file.name; document.body.append(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(imageUrl), 30000);
    toast('تم تنزيل صورة الفاتورة PNG. افتح واتساب وأرفق الصورة من التنزيلات لإرسالها.', false);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.error('Invoice image sharing failed:', error);
    toast(error?.message || 'تعذر تجهيز صورة الفاتورة. جرّب متصفح Chrome محدّثاً.', true);
  } finally {
    if (button) { button.disabled = false; button.textContent = '🖼️ إرسال صورة الفاتورة عبر واتساب'; }
  }
}

function exportInvoiceToExcelCsv(data) {
  const party = data.parties?.name || noteField(data.notes, 'اسم العميل') || 'عميل نقدي';
  const rows = [
    ['محلات الشيباني للبهارات والأعشاب الطبيعية — فاتورة مبيعات', '', '', '', '', ''],
    ['رقم الفاتورة', data.doc_no, 'التاريخ', data.document_date, 'العميل', party],
    ['م', 'الصنف', 'الوحدة', 'السعر', 'الكمية', 'المجموع']
  ];
  (data.document_lines || []).forEach((x, idx) => {
    rows.push([idx + 1, x.product_name, x.unit_name, Number(x.unit_price), Number(x.quantity), Number(x.line_total)]);
  });
  const totalQty = (data.document_lines || []).reduce((s, x) => s + Number(x.quantity || 0), 0);
  rows.push(['', 'المجموع الكلي للأصناف', '', '', totalQty, Number(data.total)]);
  const csv = '\uFEFF' + rows.map(r => r.map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `فاتورة_${data.doc_no}.csv`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function printSalesInvoice(data, thermal = false) {
  const party = data.parties?.name || noteField(data.notes, 'اسم العميل') || 'عميل نقدي';
  const phone = data.parties?.phone || noteField(data.notes, 'هاتف العميل') || '—';
  const totalQtyPrint = (data.document_lines || []).reduce((s, x) => s + Number(x.quantity || 0), 0);
  const rows = (data.document_lines || []).map((x, idx) =>
    `<tr><td style="text-align:center;font-weight:bold">${idx + 1}</td><td><b>${escapeHtml(x.product_name)}</b></td><td style="text-align:center">${escapeHtml(x.unit_name)}</td><td>${money(x.unit_price, 2)}</td><td style="text-align:center">${money(x.quantity, 4)}</td><td><b>${money(x.line_total, 2)}</b></td></tr>`
  ).join('') + ((data.document_lines || []).length ? `<tr style="background:#eaf5f0;font-weight:bold"><td colspan="4">المجموع الكلي للأصناف</td><td style="text-align:center">${money(totalQtyPrint, 4)}</td><td>${money(data.subtotal, 2)} ${escapeHtml(data.currency)}</td></tr>` : '');
  const cleanNotes = String(data.notes || '').split(/\r?\n/).filter(line => !line.startsWith('اسم العميل:') && !line.startsWith('هاتف العميل:')).join(' · ').trim();

  const w = window.open('', '_blank', thermal ? 'width=420,height=720' : 'width=920,height=740');
  if (!w) {
    window.print();
    return;
  }
  const styleCss = thermal
    ? `body{font-family:Tahoma,Arial,sans-serif;width:76mm;margin:0 auto;padding:8px;color:#000;font-size:11px}header{text-align:center;border-bottom:1.5px dashed #000;padding-bottom:8px}h1{font-size:15px;margin:4px 0}.logo{width:52px;height:52px;border-radius:50%;object-fit:cover}.meta{margin:8px 0;font-size:10.5px;line-height:1.5}table{width:100%;border-collapse:collapse;font-size:10px}th,td{padding:4px 2px;border-bottom:1px dashed #999;text-align:right}.totals{margin-top:8px;border-top:1.5px dashed #000;padding-top:6px}.totals div{display:flex;justify-content:space-between;margin:3px 0}.grand{font-weight:bold;font-size:13px}.footer{text-align:center;margin-top:10px;font-size:10px}`
    : `body{font-family:Tahoma,Arial,sans-serif;color:#1b2d26;padding:28px}header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid #c89b3c;padding-bottom:16px}h1{color:#0d4436;font-size:23px;margin:0 0 4px}.logo{width:78px;height:78px;object-fit:cover;border-radius:50%;border:2px solid #c89b3c}.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0;padding:12px;background:#f4f7f5;border-radius:10px}.meta span{display:block;color:#667870;font-size:11px;margin-bottom:4px}table{width:100%;border-collapse:collapse;margin-top:16px}th{background:#0d4436;color:#fff}th,td{padding:10px;border:1px solid #dce6e0;text-align:right}.totals{width:320px;margin:18px 0 0 auto}.totals div{display:flex;justify-content:space-between;padding:7px;border-bottom:1px solid #e5ebe7}.grand{background:#eaf5f0;color:#0d4436;font-weight:bold;font-size:17px}.footer{text-align:center;margin-top:32px;color:#0d4436;font-size:12px}`;

  w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${escapeHtml(data.doc_no)}</title><style>${styleCss}</style></head><body>
    <header style="display:block;text-align:center;border-bottom:3px solid #c89b3c;padding-bottom:12px">
      <img src="${BANNER_SRC}" style="width:100%;max-height:130px;object-fit:contain;display:block;margin:0 auto 8px">
      <div style="display:flex;justify-content:space-between;align-items:center;background:#0d4436;color:#fff;padding:8px 14px;border-radius:8px"><b>${docTypeLabel(data.doc_type)} (${escapeHtml(data.doc_no)})</b><span>التاريخ: ${escapeHtml(data.document_date)}</span></div>
    </header>
    <div class="meta">
      <div><span>التاريخ:</span> <b>${escapeHtml(data.document_date)}</b></div>
      <div><span>الطرف:</span> <b>${escapeHtml(party)}</b></div>
      <div><span>الهاتف:</span> <b>${escapeHtml(phone)}</b></div>
      <div><span>السداد:</span> <b>${data.settlement_method === 'cash' ? 'نقدي' : 'آجل'}</b></div>
    </div>
    ${rows ? `<table><thead><tr><th style="width:38px;text-align:center">م</th><th>الصنف</th><th>الوحدة</th><th>السعر</th><th>الكمية</th><th>المجموع</th></tr></thead><tbody>${rows}</tbody></table>` : `<p><b>البيان:</b> ${escapeHtml(cleanNotes)}</p>`}
    <div class="totals">
      <div><span>المجموع</span><b>${money(data.subtotal, 4)} ${escapeHtml(data.currency)}</b></div>
      ${Number(data.discount) > 0 ? `<div><span>الخصم</span><b>${money(data.discount, 4)}</b></div>` : ''}
      ${Number(data.tax) > 0 ? `<div><span>الضريبة</span><b>${money(data.tax, 4)}</b></div>` : ''}
      <div class="grand"><span>الصافي النهائي</span><b>${money(data.total, 4)} ${escapeHtml(data.currency)}</b></div>
    </div>
    <div class="footer">اليمن - عدن - الشيخ عثمان - شارع طرابلس · واتساب: 773837930<br>شكراً لتعاملكم مع محلات الشيباني 🌿</div>
    <script>window.onload=()=>setTimeout(()=>window.print(),300);<\/script>
  </body></html>`);
  w.document.close();
}

/* ============================================================================
   DESIGN & FEATURE REVIEW SHOWCASE MODAL
   ============================================================================ */
function openDesignShowcaseModal() {
  modal('🎨 دليل التصميمات ومراجعة الوظائف والإصلاحات البرمجية', `
    <div class="stack">
      <div class="alert info">
        <b>مراجعة واجهة ووظائف نظام الشيباني المحاسبي (الإصدار 2.1.0):</b>
        يعرض هذا الدليل أسلوب الواجهة والوظائف البرمجية الأساسية التي يتضمنها المشروع. يعتمد التصميم الأخضر الزمردي <code>#0D4436</code> والذهبي <code>#C89B3C</code> مع دعم الوضعين الليلي والنهاري. هذا الملخص لا يُعد اختبار استخدام ميدانياً أو اعتماداً نهائياً لدورة الترحيل المحاسبي.
      </div>

      <div class="grid-equal">
        <div class="panel">
          <h2>1. أبرز التحسينات البصرية وتصميم النوافذ</h2>
          <ul style="padding-right:18px;line-height:1.8;margin:8px 0">
            <li><b>بوابة الدخول التفاعلية:</b> تصميم مزدوج يعرض هوية محلات الشيباني مع إمكانية الدخول المباشر للنموذج الأولي بـ 3 أدوار.</li>
            <li><b>لوحة التحكم التنفيذية:</b> بطاقات KPI عصرية مع أيقونات ومخطط أعمدة بياني للمقارنة المالية وأرصدة الصناديق الحية.</li>
            <li><b>نقطة البيع التفاعلية (POS):</b> تحويلها من بطاقة نصية ثابتة إلى شاشة كاشير حقيقية بشبكة أصناف مرئية وتصنيفات وسلة بيع فورية.</li>
            <li><b>نافذة الفواتير الموحدة:</b> تعميم تصميم الجدول التفاعلي الشبيه بـ Excel ليشمل المبيعات والمشتريات والمرتجعات مع إضافة وحدات فورية.</li>
            <li><b>الوضع الليلي والنهاري:</b> تبديل فوري بين الوضع النهاري الدافئ والوضع الليلي المريح للعين في فترات العمل الطويلة.</li>
          </ul>
        </div>

        <div class="panel">
          <h2>2. سيناريوهات تجربة الاستخدام المقترحة</h2>
          <ul style="padding-right:18px;line-height:1.8;margin:8px 0">
            <li><b>سيناريو الكاشير:</b> إضافة صنف إلى السلة، اختيار الوحدة والكمية، ثم معاينة الإيصال والطباعة الحرارية 80mm.</li>
            <li><b>سيناريو المحاسب:</b> فتح كشف حساب عميل أو مورد، ومقارنة الحركات بالرصيد الافتتاحي والرصيد الحالي.</li>
            <li><b>سيناريو مدير النظام:</b> تعديل وحدة فرعية والتحقق من بقاء معاملات الفواتير السابقة كما سُجلت.</li>
          </ul>
          <p class="muted small">هذه حالات اختبار مقترحة وليست نتائج اختبار ميداني موثقة.</p>
        </div>
      </div>

      <div class="panel">
        <h2>3. أمثلة على معالجات برمجية ووظائف مضافة</h2>
        ${table(['المشكلة البرمجية السابقة', 'السبب الجذري في الكود القديم', 'المعالجة المنفذة في المشروع'], `
          <tr><td><b>فشل ترحيل فواتير العملات الأجنبية (SAR/USD)</b></td><td>تعطيل حقل العملة <code>currencySelect.disabled = true</code> يحذفه من <code>FormData</code> فتصل العملة <code>undefined</code></td><td>حفظ العملة في متغير الحالة <code>activeSaleCurrency</code> ومنع تعطيل الحقل في DOM</td></tr>
          <tr><td><b>ظهور عنوان «فاتورة مبيعات» عند عرض فاتورة شراء</b></td><td>تثبيت النص داخل <code>viewDocument()</code> وغياب زر العرض في السندات والمصروفات</td><td>تطوير <code>viewDocument()</code> ليتعرف ديناميكياً على الأنواع الـ 7 مع طباعة A4 و80mm</td></tr>
          <tr><td><b>خطأ قاعدة البيانات عند تعديل صنف أو طرف له حركات</b></td><td>إرسال حقول الرصيد الافتتاحي أو متوسط التكلفة للقاعدة بعد قفلها بـ Trigger</td><td>قفل الحقول المحمية تلقائياً في الواجهة عند وجود حركات سابقة مع تنبيه واضح</td></tr>
          <tr><td><b>نقص المرتجعات والجرد والتحويلات والميزانية</b></td><td>عدم وجود دوال أو واجهات للمرتجعات وتسوية المخزون وتحويل الصناديق والمركز المالي</td><td>إضافة المرتجعات، تسوية الجرد، كارت الصنف، تحويل الصناديق، القيود اليدوية، والميزانية العمومية</td></tr>
        `)}
      </div>
    </div>
    <div class="form-actions"><button class="btn" type="button" data-action="close-modal">إغلاق الدليل والعودة للنظام</button></div>
  `, true);
}

/* ============================================================================
   CSV / EXCEL IMPORT & SETTINGS HELPERS
   ============================================================================ */
function downloadItemsTemplate() {
  const headers = ['اسم الصنف', 'رمز / باركود', 'التصنيف', 'الوحدة الأساسية', 'سعر الشراء', 'سعر البيع', 'العملة', 'الكمية الافتتاحية', 'حد إعادة الطلب', 'متوسط التكلفة بالعملة الأساسية', 'وحدات إضافية', 'الوصف'];
  const sample = ['مثال: كمون حب', 'SH-0001', 'بهارات', 'كيلو', '7200', '9500', 'YER', '10', '5', '7200', 'نصف كيلو=0.5، ربع كيلو=0.25، أوقية=0.1', 'احذف صف المثال قبل الاستيراد'];
  const csv = '\uFEFF' + [headers, sample].map(r => r.map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'قالب_استيراد_أصناف_الشيباني.csv';
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function importItemsDialog() {
  modal('استيراد الأصناف من ملف CSV / Excel', `
    <div class="alert">يدعم النظام ملفات Excel بصيغ XLSX وXLS وملفات CSV. الأصناف الموجودة مسبقاً بنفس الرمز أو الاسم سيتم تخطيها تلقائياً لمنع التكرار.</div>
    <div class="field"><label>اختر ملف الأصناف</label><input class="control" id="items-import-file" type="file" accept=".csv,.xlsx,.xls,text/csv"></div>
    <div id="import-preview" style="margin-top:12px"></div>
    <div class="form-actions">
      <button class="btn" id="parse-items-file" type="button">قراءة الملف ومعاينة البيانات</button>
      <button class="btn gold" id="confirm-items-import" type="button" disabled>بدء الاستيراد</button>
      <button class="btn light" data-action="close-modal" type="button">إغلاق</button>
    </div>`);
  let parsed = [];
  $('#parse-items-file').onclick = async () => {
    const file = $('#items-import-file').files[0];
    if (!file) { toast('اختر ملفاً أولاً', true); return; }
    try {
      let rows;
      if (/\.csv$/i.test(file.name)) {
        const text = await file.text();
        rows = parseCSV(text.replace(/^\uFEFF/, ''));
      } else {
        if (!window.XLSX) await loadXlsxLibrary();
        const buf = await file.arrayBuffer();
        const wb = window.XLSX.read(buf, { type: 'array' });
        rows = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      }
      parsed = normalizeImportRows(rows);
      const valid = parsed.filter(x => x.name && x.base_unit);
      $('#import-preview').innerHTML = table(['الصنف', 'الرمز', 'الوحدة', 'شراء', 'بيع', 'العملة', 'رصيد افتتاحي'],
        valid.slice(0, 10).map(x => `<tr><td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.sku || '—')}</td><td>${escapeHtml(x.base_unit)}</td><td>${money(x.purchase_price)}</td><td>${money(x.sale_price)}</td><td>${x.currency}</td><td>${money(x.opening_qty)}</td></tr>`).join('')
      );
      $('#confirm-items-import').disabled = valid.length === 0;
      $('#confirm-items-import').onclick = () => runItemsImport(valid);
    } catch (err) {
      toast('تعذر قراءة الملف: ' + (err.message || err), true);
    }
  };
}

function parseCSV(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (c === '"' && quoted && n === '"') { cell += '"'; i++; }
    else if (c === '"') { quoted = !quoted; }
    else if ((c === ',' || c === ';' || c === '\t') && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && n === '\n') i++;
      row.push(cell.trim());
      if (row.some(v => v !== '')) rows.push(row);
      row = []; cell = '';
    } else cell += c;
  }
  row.push(cell.trim());
  if (row.some(v => v !== '')) rows.push(row);
  if (!rows.length) return [];
  const headers = rows.shift().map(x => String(x).trim());
  return rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function normalizeImportRows(rows) {
  const aliases = { 'اسم الصنف': 'name', 'اسم المنتج': 'name', 'الصنف': 'name', 'name': 'name', 'رمز / باركود': 'sku', 'الباركود': 'sku', 'sku': 'sku', 'التصنيف': 'category', 'category': 'category', 'الوحدة الأساسية': 'base_unit', 'الوحدة': 'base_unit', 'base_unit': 'base_unit', 'سعر الشراء': 'purchase_price', 'purchase_price': 'purchase_price', 'سعر البيع': 'sale_price', 'sale_price': 'sale_price', 'العملة': 'currency', 'currency': 'currency', 'الكمية الافتتاحية': 'opening_qty', 'opening_qty': 'opening_qty', 'حد إعادة الطلب': 'reorder_level', 'reorder_level': 'reorder_level', 'متوسط التكلفة بالعملة الأساسية': 'avg_cost_base', 'avg_cost_base': 'avg_cost_base', 'وحدات إضافية': 'other_units', 'other_units': 'other_units', 'الوصف': 'description', 'description': 'description' };
  return rows.map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) {
      const key = aliases[String(k).trim().toLowerCase()];
      if (key) o[key] = String(v ?? '').trim();
    }
    const num = k => { const raw = String(o[k] ?? '').trim(); if (!raw) return 0; const n = Number(raw.replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
    return {
      name: o.name || '', sku: o.sku || '', category: o.category || '', base_unit: o.base_unit || '',
      purchase_price: num('purchase_price'), sale_price: num('sale_price'),
      currency: (o.currency || 'YER').toUpperCase(), opening_qty: num('opening_qty'),
      reorder_level: num('reorder_level'), avg_cost_base: num('avg_cost_base'),
      other_units: o.other_units || '', description: o.description || ''
    };
  });
}

function loadXlsxLibrary() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (xlsxLibraryPromise) return xlsxLibraryPromise;

  xlsxLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.referrerPolicy = 'no-referrer';
    script.dataset.shaibaniXlsx = 'true';
    const timeoutId = window.setTimeout(() => {
      script.remove();
      reject(new Error('انتهت مهلة تحميل مكتبة Excel؛ تحقق من اتصال الإنترنت ثم أعد المحاولة'));
    }, 20000);
    script.onload = () => {
      window.clearTimeout(timeoutId);
      if (window.XLSX) resolve(window.XLSX);
      else reject(new Error('تم تحميل مكتبة Excel دون تهيئة واجهتها'));
    };
    script.onerror = () => {
      window.clearTimeout(timeoutId);
      script.remove();
      reject(new Error('تعذر تحميل مكتبة Excel من المصدر الرسمي؛ تحقق من اتصال الإنترنت'));
    };
    document.head.appendChild(script);
  }).catch(err => {
    xlsxLibraryPromise = null;
    throw err;
  });

  return xlsxLibraryPromise;
}

async function runItemsImport(rows) {
  const button = $('#confirm-items-import');
  if (!button) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'جارٍ الاستيراد…';

  let added = 0, skipped = 0, failed = 0, stockFailed = 0;
  const failureMessages = [];
  try {
    if (!supabase?.rpc && !isPersistentOfflineSession()) throw new Error('اتصال قاعدة البيانات غير متاح');
    const existing = await loadProducts();
    const skuSet = new Set(existing.map(x => normalizeProductKey(x.sku)).filter(Boolean));
    const nameSet = new Set(existing.map(x => normalizeProductKey(x.name)).filter(Boolean));

    for (const d of rows) {
      const name = String(d.name || '').trim();
      const baseUnit = String(d.base_unit || '').trim();
      const sku = String(d.sku || '').trim();
      const skuKey = normalizeProductKey(sku);
      const nameKey = normalizeProductKey(name);
      if (!name || !baseUnit) { failed++; continue; }
      if ((skuKey && skuSet.has(skuKey)) || nameSet.has(nameKey)) { skipped++; continue; }
      if (!['YER', 'SAR', 'USD'].includes(String(d.currency || 'YER').toUpperCase())) {
        failed++;
        if (failureMessages.length < 3) failureMessages.push(`عملة غير مدعومة للصنف «${name}»`);
        continue;
      }
      if ([d.purchase_price, d.sale_price, d.opening_qty, d.reorder_level, d.avg_cost_base].some(v => !Number.isFinite(Number(v)) || Number(v) < 0)) {
        failed++;
        if (failureMessages.length < 3) failureMessages.push(`قيمة رقمية غير صحيحة للصنف «${name}»`);
        continue;
      }

      const units = [];
      let invalidUnit = false;
      for (const part of String(d.other_units || '').split(/[،,؛;]/).map(x => x.trim()).filter(Boolean)) {
        const m = part.match(/^(.+?)\s*[=:\-]\s*([0-9]*\.?[0-9]+)$/);
        if (!m || Number(m[2]) <= 0) { invalidUnit = true; break; }
        units.push({ unit_name: m[1].trim(), factor_to_base: Number(m[2]) });
      }
      if (invalidUnit) {
        failed++;
        if (failureMessages.length < 3) failureMessages.push(`تعريف وحدة غير صحيح للصنف «${name}»`);
        continue;
      }

      const payload = {
        id: null, name, sku: sku || null, category: d.category || null, base_unit: baseUnit,
        purchase_price: Number(d.purchase_price), sale_price: Number(d.sale_price),
        currency: String(d.currency || 'YER').toUpperCase(),
        avg_cost_base: Number(d.avg_cost_base || d.purchase_price),
        reorder_level: Number(d.reorder_level), description: d.description || null, units
      };

      if (isPersistentOfflineSession()) {
        const savedLocal = await saveOfflineProduct(payload, {
          currentQty: 0, stockTarget: Number(d.opening_qty || 0),
          unitCostBase: Number(d.avg_cost_base || d.purchase_price),
          notes: `رصيد افتتاحي مستورد للصنف ${name}`
        });
        if (!savedLocal.ok) {
          skipped++;
          if (failureMessages.length < 3) failureMessages.push(savedLocal.message);
          continue;
        }
      } else {
        const saved = await supabase.rpc('save_product', { p_payload: payload });
        if (saved.error || !saved.data) {
          failed++;
          if (failureMessages.length < 3) failureMessages.push(`تعذر حفظ «${name}»: ${saved.error?.message || 'لم يُرجع معرّف الصنف'}`);
          continue;
        }
        if (Number(d.opening_qty) > 0) {
          const opening = await supabase.rpc('set_opening_stock', {
            p_product_id: saved.data,
            p_quantity_base: Number(d.opening_qty),
            p_unit_cost_base: Number(d.avg_cost_base || d.purchase_price)
          });
          if (opening.error) {
            stockFailed++;
            if (failureMessages.length < 3) failureMessages.push(`أُضيف «${name}» لكن تعذّر تسجيل رصيده الافتتاحي: ${opening.error.message}`);
          }
        }
      }

      added++;
      nameSet.add(nameKey);
      if (skuKey) skuSet.add(skuKey);
    }

    cachedProducts = [];
    closeModal();
    await renderPage();
    const summary = `اكتمل الاستيراد: أضيف ${added} صنفاً، تم تخطي ${skipped} مكرراً، وفشل ${failed} صفاً.`;
    const stockSummary = stockFailed ? ` تعذّر تسجيل الرصيد الافتتاحي لـ ${stockFailed} صنفاً.` : '';
    const details = failureMessages.length ? ` التفاصيل: ${failureMessages.join(' | ')}` : '';
    toast(summary + stockSummary + details, failed > 0 || stockFailed > 0);
  } catch (err) {
    button.disabled = false;
    button.textContent = originalLabel;
    toast('توقف الاستيراد قبل اكتماله: ' + (err.message || err), true);
  }
}

async function editUser(id) {
  if (!canManage()) return;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', id).single();
  if (error) { toast(error.message, true); return; }
  modal('تعديل صلاحيات الموظف', `
    <form id="user-form" class="form-grid">
      ${field('الاسم الكامل', 'full_name', data.full_name || '')}
      ${selectField('الدور الوظيفي', 'role', [{ value: 'manager', label: 'مدير النظام' }, { value: 'accountant', label: 'محاسب' }, { value: 'cashier', label: 'كاشير' }], data.role)}
      ${selectField('الحالة', 'is_active', [{ value: 'true', label: 'مفعّل' }, { value: 'false', label: 'موقوف' }], String(data.is_active))}
      <div class="field full form-actions"><button class="btn" type="submit">حفظ التعديلات</button></div>
    </form>`);
  $('#user-form').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    const r = await supabase.from('profiles').update({ full_name: d.full_name, role: d.role, is_active: d.is_active === 'true' }).eq('id', id);
    if (r.error) { toast(r.error.message, true); return; }
    closeModal();
    await renderPage();
    toast('تم تحديث صلاحيات الموظف');
  };
}

function inviteUser() {
  modal('دعوة موظف جديد للنظام', `
    <form id="invite-form" class="form-grid">
      ${field('اسم الموظف', 'full_name', '', 'text', { required: true })}
      ${field('البريد الإلكتروني', 'email', '', 'email', { required: true })}
      ${selectField('الدور الوظيفي', 'role', [{ value: 'cashier', label: 'كاشير' }, { value: 'accountant', label: 'محاسب' }, { value: 'manager', label: 'مدير النظام' }], 'cashier')}
      <div class="field full form-actions"><button class="btn" type="submit">إرسال الدعوة</button></div>
    </form>`);
  $('#invite-form').onsubmit = async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.target));
    if (isDemoMode) {
      await supabase.from('profiles').insert({ full_name: d.full_name, role: d.role, is_active: true });
      closeModal();
      await renderPage();
      toast('تمت إضافة الموظف في وضع المحاكاة بنجاح');
      return;
    }
    const { data: { session: s } } = await supabase.auth.getSession();
    const endpoint = String(cfg.SUPABASE_URL || '') + '/functions/v1/admin-invite';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.access_token}`, 'apikey': supabaseApiKey },
      body: JSON.stringify(d)
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { toast(out.error || 'فشل إرسال الدعوة', true); return; }
    closeModal();
    await renderPage();
    toast('تم إرسال دعوة الموظف');
  };
}

async function saveSettings(e) {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  const r = await supabase.from('settings').update({ store_name: d.store_name, base_currency: d.base_currency, tax_rate: Number(d.tax_rate || 0), updated_at: new Date().toISOString() }).eq('id', 1);
  if (r.error) { toast(r.error.message, true); return; }
  toast('تم حفظ إعدادات المنشأة');
}

async function saveRate(e) {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  if (d.from_currency === d.to_currency) { toast('اختر عملتين مختلفتين', true); return; }
  const r = await supabase.from('exchange_rates').upsert({ from_currency: d.from_currency, to_currency: d.to_currency, rate: Number(d.rate), effective_date: d.effective_date, created_by: session?.user?.id || null }, { onConflict: 'from_currency,to_currency,effective_date' });
  if (r.error) { toast(r.error.message, true); return; }
  toast('تم حفظ سعر الصرف المعتمد');
  await renderPage();
}

function exportCurrentReportCsv() {
  const rows = [...$$('#report-printable-area table tr')];
  if (!rows.length) { toast('لا يوجد جدول لتصديره حالياً', true); return; }
  const csv = '\uFEFF' + rows.map(tr => [...tr.querySelectorAll('th,td')].map(c => '"' + c.textContent.trim().replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `تقرير_الشيباني_${currentReportTab}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/* ============================================================================
   GLOBAL EVENT DELEGATION & BOOTSTRAP
   ============================================================================ */
async function renderProductSuggestions(input) {
  const fieldWrap = input.closest('.field');
  const menu = input.parentElement.querySelector(`[data-suggestions-for="${input.id}"]`)
    || fieldWrap?.querySelector(`[data-suggestions-for="${input.id}"]`)
    || fieldWrap?.parentElement?.querySelector(`[data-suggestions-for="${input.id}"]`);
  if (!menu) return;
  const query = normalizeProductKey(input.value);
  if (!query) { menu.hidden = true; menu.innerHTML = ''; return; }
  const products = cachedProducts.length ? cachedProducts : await loadProducts();
  const matches = products.filter(product =>
    normalizeProductKey(product.name).includes(query) || normalizeProductKey(product.sku).includes(query)
  ).slice(0, 8);
  if (!matches.length) { menu.hidden = true; menu.innerHTML = ''; return; }
  menu.innerHTML = matches.map(product => `
    <button type="button" class="product-suggestion-option" data-action="select-product-suggestion" data-input-id="${escapeHtml(input.id)}" data-product-id="${escapeHtml(product.id)}">
      <b>${escapeHtml(product.name)}</b>
      <small>${escapeHtml(product.sku || product.category || '')}${product.base_unit ? ` · ${escapeHtml(product.base_unit)}` : ''}</small>
    </button>`).join('');
  menu.hidden = false;
}

document.addEventListener('click', async e => {
  const pageBtn = e.target.closest('[data-page]');
  if (pageBtn) {
    setPage(pageBtn.dataset.page);
    $('#sidebar')?.classList.remove('open');
    return;
  }
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const a = b.dataset.action;
  try {
    switch (a) {
      case 'toggle-menu': $('#sidebar')?.classList.toggle('open'); break;
      case 'toggle-theme': toggleTheme(); break;
      case 'start-demo': startDemoSession(b.dataset.role || 'manager'); break;
      case 'start-offline': await startCachedOfflineSession(false); break;
      case 'sync-now': await syncOfflineQueue(true); break;
      case 'select-product-suggestion': {
        const product = (cachedProducts.length ? cachedProducts : await loadProducts()).find(x => String(x.id) === String(b.dataset.productId));
        const input = document.getElementById(b.dataset.inputId);
        if (product && input) {
          input.value = product.name;
          const menu = input.parentElement.querySelector(`[data-suggestions-for="${input.id}"]`) || input.closest('.field')?.querySelector(`[data-suggestions-for="${input.id}"]`) || input.closest('.field')?.parentElement?.querySelector(`[data-suggestions-for="${input.id}"]`);
          if (menu) menu.hidden = true;
          if (input.id === 'sale-entry-name') {
            const hidden = $('#sale-entry-product-id');
            if (hidden) hidden.value = product.id;
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
        break;
      }
      case 'switch-demo-role': startDemoSession(b.dataset.role || 'manager'); break;
      case 'reset-demo-data': resetDemoDB(); cachedProducts = []; cachedParties = []; cachedCash = []; await renderPage(); toast('تمت استعادة البيانات الافتراضية للنموذج'); break;
      case 'open-design-showcase': openDesignShowcaseModal(); break;
      case 'go-pos': setPage('pos'); break;
      case 'clear-pos-cart': posCart = []; renderPosCart(); break;
      case 'submit-pos-sale': await submitPosSale(); break;
      case 'logout':
        if (realtimeChannel && supabase?.removeChannel) await supabase.removeChannel(realtimeChannel);
        if (supabase?.auth?.signOut) await supabase.auth.signOut();
        try { const ref = new URL(cfg.SUPABASE_URL).hostname.split('.')[0]; localStorage.removeItem(`sb-${ref}-auth-token`); } catch (_e) {}
        profile = null; session = null; isDemoMode = false; offlineSessionActive = false;
        cachedProducts = []; cachedParties = []; cachedCash = [];
        showLogin();
        break;
      case 'close-modal': closeModal(); break;
      case 'refresh': await renderPage(); break;
      case 'new-sale': await openUnifiedInvoice('sale'); break;
      case 'new-sale-return': await openUnifiedInvoice('sale_return'); break;
      case 'new-purchase': await openUnifiedInvoice('purchase'); break;
      case 'new-purchase-return': await openUnifiedInvoice('purchase_return'); break;
      case 'new-expense': await openDoc('expense'); break;
      case 'new-receipt': await openDoc('receipt'); break;
      case 'new-payment': await openDoc('payment'); break;
      case 'new-cash-transfer': await openCashTransfer(); break;
      case 'opening-cash': await openCashOpening(); break;
      case 'new-product': await openProduct(); break;
      case 'edit-product': await openProduct(b.dataset.id); break;
      case 'open-stock-qty-modal': await openStockQtyModal(b.dataset.id); break;
      case 'view-stock-card': await openStockCard(b.dataset.id); break;
      case 'new-stock-adjustment': await openStockAdjustment(); break;
      case 'import-items': importItemsDialog(); break;
      case 'download-items-template': downloadItemsTemplate(); break;
      case 'new-party': await openParty(b.dataset.kind); break;
      case 'edit-party': await openParty(b.dataset.kind || (currentPage === 'suppliers' ? 'supplier' : 'customer'), b.dataset.id); break;
      case 'view-party-statement': await openPartyStatement(b.dataset.id); break;
      case 'add-sale-line': addSaleLine(); break;
      case 'remove-sale-line': {
        const tr = b.closest('tr[data-line-key]');
        activeSaleLines = activeSaleLines.filter(x => x.key !== tr?.dataset.lineKey);
        renderSaleLines();
        break;
      }
      case 'toggle-sale-unit': toggleSaleUnitPanel(); break;
      case 'apply-invoice-preset': applyQuickPresetInInvoicePanel(b.dataset.preset); break;
      case 'load-unit-to-edit': {
        if ($('#sale-new-unit-name')) $('#sale-new-unit-name').value = b.dataset.unitName || '';
        if ($('#sale-new-unit-factor')) $('#sale-new-unit-factor').value = b.dataset.factor || '1';
        if ($('#sale-new-unit-purchase')) $('#sale-new-unit-purchase').value = b.dataset.buy || '0';
        if ($('#sale-new-unit-sale')) $('#sale-new-unit-sale').value = b.dataset.sell || '0';
        $('#sale-new-unit-name')?.focus();
        toast('عدّل القيم أعلاه ثم اضغط «حفظ وإضافة / تحديث الوحدة»');
        break;
      }
      case 'select-draft-unit': {
        draftNewProductConfig.selected_unit_name = b.dataset.unitName || draftNewProductConfig.base_unit;
        renderDraftNewProductUnitsSelect();
        renderDraftUnitsTableInPanel();
        break;
      }
      case 'remove-draft-unit': {
        const idx = Number(b.dataset.idx);
        if (draftNewProductConfig.units[idx] && !draftNewProductConfig.units[idx].is_base) {
          draftNewProductConfig.units.splice(idx, 1);
          draftNewProductConfig.selected_unit_name = draftNewProductConfig.units[0]?.unit_name || draftNewProductConfig.base_unit;
          renderDraftNewProductUnitsSelect();
          renderDraftUnitsTableInPanel();
        }
        break;
      }
      case 'save-sale-unit': await saveSaleUnitFromInvoice(); break;
      case 'print-invoice': if (activeInvoiceForActions) printSalesInvoice(activeInvoiceForActions, false); break;
      case 'print-thermal': if (activeInvoiceForActions) printSalesInvoice(activeInvoiceForActions, true); break;
      case 'whatsapp-invoice': if (activeInvoiceForActions) shareSalesInvoice(activeInvoiceForActions); break;
      case 'export-invoice-excel': if (activeInvoiceForActions) exportInvoiceToExcelCsv(activeInvoiceForActions); break;
      case 'print-current-modal': window.print(); break;
      case 'print-page-report': window.print(); break;
      case 'export-report-csv': exportCurrentReportCsv(); break;
      case 'switch-report-tab': currentReportTab = b.dataset.tab || 'trial_balance'; await renderPage(); break;
      case 'invite-user': inviteUser(); break;
      case 'edit-user': await editUser(b.dataset.id); break;
      case 'view-doc': await viewDocument(b.dataset.id); break;
      case 'view-journal': await viewJournal(b.dataset.id); break;
      case 'new-manual-journal': await openManualJournal(); break;
      case 'view-account-ledger': await openAccountLedger(b.dataset.id); break;
      case 'new-account': await openAccountForm(); break;
      case 'edit-account': await openAccountForm(b.dataset.id); break;
      default: break;
    }
  } catch (err) {
    toast(err.message || 'حدث خطأ غير متوقع', true);
  }
});

app.addEventListener('submit', e => {
  if (e.target.id === 'settings-form') saveSettings(e);
  if (e.target.id === 'rate-form') saveRate(e);
});

app.addEventListener('input', e => {
  if (e.target.matches('[data-product-autocomplete]')) void renderProductSuggestions(e.target);
  if (e.target.id === 'table-search') {
    const q = e.target.value.trim().toLocaleLowerCase('ar');
    $$('#data-table tbody tr').forEach(r => {
      r.style.display = r.textContent.toLocaleLowerCase('ar').includes(q) ? '' : 'none';
    });
    const itemCards = $$('#data-table [data-item-card]');
    let visibleCards = 0;
    itemCards.forEach(card => {
      const searchable = `${card.dataset.search || ''} ${card.textContent}`.toLocaleLowerCase('ar');
      const visible = searchable.includes(q);
      card.hidden = !visible;
      if (visible) visibleCards += 1;
    });
    const noResults = $('#data-table .items-no-results');
    if (noResults) noResults.hidden = !itemCards.length || visibleCards > 0;
  }
});

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installPrompt = e;
});

try {
  const savedTheme = localStorage.getItem('shaibani_theme');
  if (savedTheme === 'dark' || savedTheme === 'light') {
    document.documentElement.setAttribute('data-theme', savedTheme);
  }
} catch (_e) {}

if (window.SHAIBANI_AUTO_DEMO) {
  startDemoSession('manager');
} else if (!configured) {
  showConfig();
} else {
  (async () => {
    try {
      supabase = await withTimeout(
        createSupabaseLiveClient(cfg.SUPABASE_URL, supabaseApiKey, {
          db: { schema: cfg.SUPABASE_SCHEMA || 'shaibani_erp' },
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
        }),
        25000,
        'تأخر تحميل خدمة الاتصال. أعد المحاولة أو تحقق من اتصال الإنترنت.'
      );
      supabase.auth.onAuthStateChange((_event, newSession) => {
        if (!newSession && profile && !isDemoMode) {
          profile = null;
          session = null;
          showLogin();
        }
      });
      await withTimeout(afterLogin(), 20000, 'استغرق التحقق من الجلسة وملف الموظف وقتاً أطول من المتوقع.');
    } catch (err) {
      console.error('Shaibani startup failed:', err);
      if (!(await startCachedOfflineSession(true))) {
        showLogin('تعذر فتح النظام: ' + (err?.message || 'فشل الاتصال بالخدمة') + ' يمكنك إعادة المحاولة أو استخدام وضع النموذج التفاعلي.');
      }
    }
  })();
}

window.addEventListener('online', async () => {
  updateConnectionBadge('● استعادة الاتصال…');
  if (!isDemoMode) {
    try {
      await ensureLiveSupabaseClient();
      const { data: { session: restored } } = await supabase.auth.getSession();
      if (restored) session = restored;
      if (session && profile) await syncOfflineQueue(false);
    } catch (err) { console.warn('تعذرت استعادة المزامنة تلقائياً:', err); }
  }
  await refreshOfflineBadge();
});
window.addEventListener('offline', async () => {
  offlineSessionActive = !isDemoMode && Boolean(profile);
  updateConnectionBadge();
  if (offlineSessionActive) {
    currentPage = 'items';
    buildShell();
    try { cachedProducts = await getCachedProducts(); await renderPage(); } catch (_e) {}
  }
  toast('انقطع الاتصال. ستبقى بيانات الأصناف المحفوظة على هذا الجهاز متاحة.');
});

if ('serviceWorker' in navigator && location.protocol === 'https:' && !window.SHAIBANI_AUTO_DEMO) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

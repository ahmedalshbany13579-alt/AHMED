/*
 * طبقة التخزين المحلي لنظام الشيباني.
 * IndexedDB يحتفظ بنسخة الأصناف والمخزون والبيانات المرجعية وطابور عمليات المزامنة.
 * لا تحفظ كلمات المرور أو مفاتيح Supabase في هذه القاعدة.
 */
const DB_NAME = 'shaibani-erp-offline';
const DB_VERSION = 1;

let dbPromise;

export function normalizeProductKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim()
    .toLocaleLowerCase('ar');
}


/** Compare the latest server quantity with the offline baseline before applying a target. */
export function stockSyncDecision(currentQty, baselineQty, targetQty, epsilon = 0.000001) {
  const current = Number(currentQty || 0);
  const baseline = Number(baselineQty || 0);
  const target = Number(targetQty || 0);
  if (Math.abs(current - target) < epsilon) return 'already_applied';
  if (Math.abs(current - baseline) >= epsilon) return 'conflict';
  return 'apply';
}

export function findDuplicateProduct(products, candidate, excludeId = candidate?.id) {
  const nameKey = normalizeProductKey(candidate?.name);
  const skuKey = normalizeProductKey(candidate?.sku);
  if (!nameKey && !skuKey) return null;
  return (products || []).find(product => {
    if (excludeId && String(product.id) === String(excludeId)) return false;
    const sameName = nameKey && normalizeProductKey(product.name) === nameKey;
    const sameSku = skuKey && normalizeProductKey(product.sku) === skuKey;
    return Boolean(sameName || sameSku);
  }) || null;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('تعذر الوصول إلى قاعدة البيانات المحلية'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('فشلت معاملة التخزين المحلي'));
    transaction.onabort = () => reject(transaction.error || new Error('تم إلغاء معاملة التخزين المحلي'));
  });
}

export function initOfflineStore() {
  if (dbPromise) return dbPromise;
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(new Error('هذا المتصفح لا يدعم التخزين المحلي IndexedDB'));
  }
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('products')) {
        const store = db.createObjectStore('products', { keyPath: 'id' });
        store.createIndex('name_key', 'name_key', { unique: false });
        store.createIndex('sku_key', 'sku_key', { unique: false });
      }
      if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('outbox')) {
        const store = db.createObjectStore('outbox', { keyPath: 'id' });
        store.createIndex('created_at', 'created_at', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
      if (!db.objectStoreNames.contains('mappings')) db.createObjectStore('mappings', { keyPath: 'local_id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('تعذر إنشاء قاعدة البيانات المحلية'));
    request.onblocked = () => reject(new Error('قاعدة البيانات المحلية مشغولة في نافذة أخرى؛ أغلق النسخ الأخرى من التطبيق'));
  });
  return dbPromise;
}

async function readAll(storeName) {
  const db = await initOfflineStore();
  const tx = db.transaction(storeName, 'readonly');
  const result = await requestResult(tx.objectStore(storeName).getAll());
  await transactionDone(tx);
  return result;
}

export async function getCachedProducts() {
  const rows = await readAll('products');
  return rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ar'));
}

export async function cacheProducts(products) {
  const db = await initOfflineStore();
  const tx = db.transaction(['products', 'outbox'], 'readwrite');
  const productStore = tx.objectStore('products');
  const outboxStore = tx.objectStore('outbox');
  const pending = await requestResult(outboxStore.getAll());
  const pendingProductIds = new Set(pending.filter(x => x.type === 'save_product').map(x => String(x.local_product_id)));
  for (const product of (products || [])) {
    if (!product?.id || pendingProductIds.has(String(product.id))) continue;
    productStore.put({
      ...product,
      name_key: normalizeProductKey(product.name),
      sku_key: normalizeProductKey(product.sku),
      local_sync_state: 'synced',
      cached_at: new Date().toISOString()
    });
  }
  await transactionDone(tx);
}

export async function getSnapshot(key) {
  const db = await initOfflineStore();
  const tx = db.transaction('snapshots', 'readonly');
  const row = await requestResult(tx.objectStore('snapshots').get(key));
  await transactionDone(tx);
  return row?.value ?? null;
}

export async function setSnapshot(key, value) {
  const db = await initOfflineStore();
  const tx = db.transaction('snapshots', 'readwrite');
  tx.objectStore('snapshots').put({ key, value, updated_at: new Date().toISOString() });
  await transactionDone(tx);
}

export async function cacheProfile(profile) {
  if (!profile?.id || !profile?.role) return;
  await setSnapshot('last-authenticated-profile', {
    id: profile.id,
    full_name: profile.full_name || '',
    role: profile.role,
    is_active: profile.is_active === true,
    cached_at: new Date().toISOString()
  });
}

export async function getCachedProfile() {
  return getSnapshot('last-authenticated-profile');
}

export async function saveOfflineProduct(payload, options = {}) {
  const products = await getCachedProducts();
  const duplicate = findDuplicateProduct(products, payload, payload.id || undefined);
  if (duplicate) {
    return { ok: false, duplicate, message: `الصنف «${duplicate.name}» مسجل مسبقاً؛ اختره من القائمة بدلاً من إنشاء نسخة مكررة.` };
  }

  const isNew = !payload.id || String(payload.id).startsWith('local-');
  const localId = payload.id || `local-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
  const record = {
    ...payload,
    id: localId,
    sku: payload.sku || null,
    units: [
      {
        id: `local-unit-base-${localId}`,
        product_id: localId,
        unit_name: payload.base_unit,
        factor_to_base: 1,
        purchase_price: Number(payload.purchase_price || 0),
        sale_price: Number(payload.sale_price || 0),
        currency: payload.currency || 'YER',
        is_base: true,
        active: true
      },
      ...(payload.units || []).map((unit, index) => ({
        ...unit,
        id: unit.id || `local-unit-${localId}-${index}`,
        product_id: localId,
        is_base: false
      }))
    ],
    local_sync_state: 'pending',
    name_key: normalizeProductKey(payload.name),
    sku_key: normalizeProductKey(payload.sku),
    cached_at: new Date().toISOString()
  };
  const db = await initOfflineStore();
  const tx = db.transaction(['products', 'outbox'], 'readwrite');
  const productStore = tx.objectStore('products');
  // إعادة الفحص داخل معاملة readwrite لمنع حفظ اسم مكرر من نافذتين متزامنتين.
  const transactionProducts = await requestResult(productStore.getAll());
  const transactionDuplicate = findDuplicateProduct(transactionProducts, payload, payload.id || undefined);
  if (transactionDuplicate) {
    await transactionDone(tx);
    return { ok: false, duplicate: transactionDuplicate, message: `الصنف «${transactionDuplicate.name}» مسجل مسبقاً؛ اختره من القائمة بدلاً من إنشاء نسخة مكررة.` };
  }
  productStore.put(record);
  tx.objectStore('outbox').put({
    id: `save-product:${localId}`,
    type: 'save_product',
    local_product_id: localId,
    payload: { ...payload, id: isNew ? null : payload.id },
    status: 'pending',
    attempts: 0,
    created_at: new Date().toISOString(),
    last_error: null
  });
  const stockQueueId = `stock-target:${localId}`;
  if (options.stockTarget !== undefined) {
    const outboxStore = tx.objectStore('outbox');
    const previousStockOperation = await requestResult(outboxStore.get(stockQueueId));
    // احتفظ برصيد الخادم الأصلي بين تعديلات المستخدم المتكررة دون اتصال.
    const serverBaselineQty = previousStockOperation?.current_qty_at_entry ?? Number(options.currentQty || 0);
    if (Math.abs(Number(options.stockTarget) - Number(serverBaselineQty)) > 0.000001) {
      outboxStore.put({
        id: stockQueueId,
        type: 'stock_target',
        local_product_id: localId,
        target_qty: Number(options.stockTarget),
        current_qty_at_entry: Number(serverBaselineQty),
        unit_cost_base: Number(options.unitCostBase || 1),
        notes: options.notes || 'تعديل رصيد الصنف دون اتصال',
        status: 'pending',
        attempts: 0,
        created_at: previousStockOperation?.created_at || new Date().toISOString(),
        last_error: null
      });
    } else {
      outboxStore.delete(stockQueueId);
    }
  }
  await transactionDone(tx);
  if (options.stockTarget !== undefined) {
    const inventory = (await getSnapshot('inventory-summary')) || [];
    const existing = inventory.find(x => String(x.id) === String(localId));
    if (existing) {
      existing.quantity = Number(options.stockTarget);
      existing.inventory_value_base = Number(options.stockTarget) * Number(record.avg_cost_base || 0);
    } else inventory.push({ id: localId, name: record.name, base_unit: record.base_unit, quantity: Number(options.stockTarget), inventory_value_base: Number(options.stockTarget) * Number(record.avg_cost_base || 0) });
    await setSnapshot('inventory-summary', inventory);
  }
  return { ok: true, product: record, localId, isNew };
}

export async function getOutbox() {
  const rows = await readAll('outbox');
  return rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export async function getOutboxCount() {
  const db = await initOfflineStore();
  const tx = db.transaction('outbox', 'readonly');
  const count = await requestResult(tx.objectStore('outbox').count());
  await transactionDone(tx);
  return count;
}

export async function updateOutboxItem(item) {
  const db = await initOfflineStore();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').put(item);
  await transactionDone(tx);
}

export async function removeOutboxItem(id) {
  const db = await initOfflineStore();
  const tx = db.transaction('outbox', 'readwrite');
  tx.objectStore('outbox').delete(id);
  await transactionDone(tx);
}

export async function resolveProductId(localId) {
  const db = await initOfflineStore();
  const tx = db.transaction('mappings', 'readonly');
  const row = await requestResult(tx.objectStore('mappings').get(localId));
  await transactionDone(tx);
  return row?.remote_id || localId;
}

export async function markProductSynced(localId, remoteId) {
  const db = await initOfflineStore();
  const tx = db.transaction(['products', 'mappings'], 'readwrite');
  const products = tx.objectStore('products');
  const mappings = tx.objectStore('mappings');
  const localProduct = await requestResult(products.get(localId));
  mappings.put({ local_id: localId, remote_id: remoteId, synced_at: new Date().toISOString() });
  if (localProduct) {
    if (String(localId) !== String(remoteId)) products.delete(localId);
    products.put({
      ...localProduct,
      id: remoteId,
      units: (localProduct.units || []).map(unit => ({ ...unit, product_id: remoteId })),
      local_sync_state: 'synced',
      server_id: remoteId,
      cached_at: new Date().toISOString()
    });
  }
  await transactionDone(tx);
}

/** Queue a stock target after the product itself has already been saved online. */
export async function queueOfflineStockTarget(productId, targetQty, currentQty, unitCostBase = 1, notes = 'تحديث رصيد محفوظ دون اتصال') {
  const id = `stock-target:${productId}`;
  const db = await initOfflineStore();
  const tx = db.transaction('outbox', 'readwrite');
  const store = tx.objectStore('outbox');
  const previous = await requestResult(store.get(id));
  const serverBaselineQty = previous?.current_qty_at_entry ?? Number(currentQty || 0);
  if (Math.abs(Number(targetQty) - Number(serverBaselineQty)) > 0.000001) {
    store.put({
      id, type: 'stock_target', local_product_id: productId,
      target_qty: Number(targetQty), current_qty_at_entry: Number(serverBaselineQty),
      unit_cost_base: Number(unitCostBase) > 0 ? Number(unitCostBase) : 1,
      notes, status: 'pending', attempts: Number(previous?.attempts || 0),
      created_at: previous?.created_at || new Date().toISOString(), last_error: null
    });
  } else {
    store.delete(id);
  }
  await transactionDone(tx);

  const inventory = (await getSnapshot('inventory-summary')) || [];
  const existing = inventory.find(row => String(row.id) === String(productId));
  if (existing) existing.quantity = Number(targetQty);
  else {
    const product = (await getCachedProducts()).find(row => String(row.id) === String(productId));
    inventory.push({ id: productId, name: product?.name || '', base_unit: product?.base_unit || '', quantity: Number(targetQty), inventory_value_base: Number(targetQty) * Number(product?.avg_cost_base || 0) });
  }
  await setSnapshot('inventory-summary', inventory);
  return { ok: true };
}

export async function updateCachedProduct(product) {
  const db = await initOfflineStore();
  const tx = db.transaction('products', 'readwrite');
  tx.objectStore('products').put({
    ...product,
    name_key: normalizeProductKey(product.name),
    sku_key: normalizeProductKey(product.sku),
    cached_at: new Date().toISOString()
  });
  await transactionDone(tx);
}

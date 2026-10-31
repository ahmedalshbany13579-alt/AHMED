import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProductKey, findDuplicateProduct, stockSyncDecision } from '../offline-store.js';

test('normalizes Arabic hamza forms, diacritics, spacing, and tatweel', () => {
  assert.equal(normalizeProductKey('  إِبْرَ   الشاملـــ  '), normalizeProductKey('ابر الشامل'));
});

test('detects duplicate product names despite Arabic spelling and spacing variations', () => {
  const products = [{ id: 'p-1', name: 'إبْر الشامل جل', sku: 'SH-1001' }];
  const duplicate = findDuplicateProduct(products, { name: 'ابر   الشامل جل', sku: 'NEW-1001' });
  assert.equal(duplicate?.id, 'p-1');
});

test('detects duplicate SKU when product name differs', () => {
  const products = [{ id: 'p-2', name: 'كركم مطحون', sku: 'SH-002' }];
  const duplicate = findDuplicateProduct(products, { name: 'زنجبيل مطحون', sku: ' sh-002 ' });
  assert.equal(duplicate?.id, 'p-2');
});

test('allows editing the same product without self-duplicate', () => {
  const products = [{ id: 'p-3', name: 'حبة البركة', sku: 'SH-003' }];
  assert.equal(findDuplicateProduct(products, { id: 'p-3', name: 'حبة البركة', sku: 'SH-003' }, 'p-3'), null);
});

test('does not report a duplicate for a different product identity', () => {
  const products = [{ id: 'p-4', name: 'قرفة', sku: 'SH-004' }];
  assert.equal(findDuplicateProduct(products, { name: 'هيل', sku: 'SH-005' }), null);
});


test('does not treat empty SKUs as duplicate identifiers', () => {
  const products = [{ id: 'p-5', name: 'قرفة', sku: null }];
  assert.equal(findDuplicateProduct(products, { name: 'هيل', sku: '' }), null);
});

test('recognizes an already-applied offline stock target without replaying it', () => {
  assert.equal(stockSyncDecision(12, 5, 12), 'already_applied');
});

test('detects a concurrent server stock change as a conflict', () => {
  assert.equal(stockSyncDecision(8, 5, 12), 'conflict');
});

test('allows stock sync only when server quantity still matches the offline baseline', () => {
  assert.equal(stockSyncDecision(5, 5, 12), 'apply');
});

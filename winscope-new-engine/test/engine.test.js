
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toDecimal,
  impliedProbability,
  normalizeTwoWay,
  choosePreMatchSnapshot
} from '../src/index.js';

test('Ondalık oranı doğru okur', () => {
  assert.equal(toDecimal('1.65'), 1.65);
  assert.equal(toDecimal('1,65'), 1.65);
  assert.equal(toDecimal('0'), null);
});

test('Oranı olasılığa dönüştürür', () => {
  assert.equal(impliedProbability(2), 0.5);
});

test('İki yönlü olasılıkları normalize eder', () => {
  const result = normalizeTwoWay(2, 2);
  assert.equal(result.over, 0.5);
  assert.equal(result.under, 0.5);
});

test('Maç başladıktan sonra alınan oranı kullanmaz', () => {
  const rows = [
    {
      captured_at: '2026-11-19T10:00:00Z',
      payload: { response: [] }
    },
    {
      captured_at: '2026-11-19T12:00:00Z',
      payload: { response: [] }
    }
  ];

  const result = choosePreMatchSnapshot(
    rows,
    '2026-11-19T11:00:00Z'
  );

  assert.equal(result.captured_at, '2026-11-19T10:00:00Z');
});

test('Maç öncesi kayıt yoksa null döndürür', () => {
  const result = choosePreMatchSnapshot(
    [],
    '2026-11-19T11:00:00Z'
  );

  assert.equal(result, null);
});

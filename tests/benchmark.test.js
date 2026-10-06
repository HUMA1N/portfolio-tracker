const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/portfolio.js');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

let seq = 0;
function tr(date, ticker, side, qty, price, fee = 0) {
  seq += 1;
  return { id: 't' + seq, seq, date, ticker, side, qty, price, fee };
}

test('buildHistory отдаёт покупки и продажи за день', () => {
  const trades = [tr('2024-01-01', 'A', 'buy', 10, 100, 1), tr('2024-01-02', 'A', 'sell', 4, 110, 1)];
  const { points } = P.buildHistory(trades, new Map(), '2024-01-02', new Map([['A', 110]]));
  assert.equal(points[0].inflow, 1001);
  assert.equal(points[0].outflow, 0);
  assert.equal(points[1].inflow, 0);
  assert.equal(points[1].outflow, 439);
});

test('доходность не зависит от пополнений', () => {
  // Цена бумаги: 100 → 110 → 121. Крупная докупка в третий день по цене открытия (110) не меняет доходность.
  const trades = [tr('2024-01-01', 'A', 'buy', 10, 100), tr('2024-01-03', 'A', 'buy', 90, 110)];
  const closes = new Map([
    [
      'A',
      [
        ['2024-01-01', 100],
        ['2024-01-02', 110],
        ['2024-01-03', 121],
      ],
    ],
  ]);
  const { points } = P.buildHistory(trades, closes, '2024-01-03', new Map());
  const g = P.growthSeries(points);
  close(g[0].growth, 1);
  close(g[1].growth, 1.1);
  close(g[2].growth, 1.21);
});

test('продажа и комиссии учитываются в доходности', () => {
  const trades = [tr('2024-01-01', 'A', 'buy', 10, 100, 10), tr('2024-01-02', 'A', 'sell', 5, 100, 0)];
  const { points } = P.buildHistory(trades, new Map(), '2024-01-03', new Map([['A', 120]]));
  const g = P.growthSeries(points);
  close(g[0].growth, 1000 / 1010); // комиссия — потеря в первый день
  close(g[1].growth, 1000 / 1010); // продажа по той же цене — без изменений
  close(g[2].growth, (1000 / 1010) * 1.2);
});

test('выплаты увеличивают доходность', () => {
  const trades = [tr('2024-01-01', 'A', 'buy', 10, 100)];
  const { points } = P.buildHistory(trades, new Map(), '2024-01-02', new Map([['A', 100]]));
  const g = P.growthSeries(points, new Map([['2024-01-02', 50]]));
  close(g[1].growth, 1.05);
});

test('портфель полностью продан и куплен снова — доходность продолжается', () => {
  const trades = [tr('2024-01-01', 'A', 'buy', 1, 100), tr('2024-01-02', 'A', 'sell', 1, 110), tr('2024-01-04', 'A', 'buy', 1, 50)];
  const closes = new Map([
    [
      'A',
      [
        ['2024-01-01', 100],
        ['2024-01-02', 110],
        ['2024-01-04', 50],
        ['2024-01-05', 55],
      ],
    ],
  ]);
  const { points } = P.buildHistory(trades, closes, '2024-01-05', new Map());
  const g = P.growthSeries(points);
  close(g[2].growth, 1.1); // без бумаг — без изменений
  close(g[4].growth, 1.21);
});

test('alignCloses берёт последнее известное значение', () => {
  const v = P.alignCloses(['2024-01-01', '2024-01-02', '2024-01-03', '2024-01-06'], [
    ['2024-01-02', 3000],
    ['2024-01-05', 3100],
  ]);
  assert.deepEqual(v, [null, 3000, 3000, 3100]);
});

test('compareWithBenchmark: обе линии с нуля в начале периода', () => {
  const trades = [tr('2024-01-01', 'A', 'buy', 10, 100)];
  const closes = new Map([
    [
      'A',
      [
        ['2024-01-01', 100],
        ['2024-01-02', 105],
        ['2024-01-03', 120],
      ],
    ],
  ]);
  const { points } = P.buildHistory(trades, closes, '2024-01-03', new Map());
  const bench = [
    ['2023-12-29', 3000],
    ['2024-01-02', 3030],
    ['2024-01-03', 3060],
  ];
  const all = P.compareWithBenchmark(points, bench, null);
  assert.equal(all.points[0].date, '2024-01-01');
  close(all.points[0].portfolio, 0);
  close(all.points[0].bench, 0);
  close(all.portfolio, 0.2);
  close(all.bench, 0.02);

  const part = P.compareWithBenchmark(points, bench, '2024-01-02');
  assert.equal(part.points.length, 2);
  close(part.portfolio, 120 / 105 - 1);
  close(part.bench, 3060 / 3030 - 1);

  assert.equal(P.compareWithBenchmark(points, [], null), null);
});

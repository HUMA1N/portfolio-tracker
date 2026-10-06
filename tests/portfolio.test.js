const test = require('node:test');
const assert = require('node:assert/strict');
const Fmt = require('../js/format.js');
const P = require('../js/portfolio.js');

let seq = 0;
function tr(date, ticker, side, qty, price, fee = 0) {
  seq += 1;
  return { id: 't' + seq, seq, date, ticker, side, qty, price, fee };
}

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('parseNumber понимает русскую и английскую запись', () => {
  assert.equal(Fmt.parseNumber('1 234,56'), 1234.56);
  assert.equal(Fmt.parseNumber('1234.56'), 1234.56);
  assert.equal(Fmt.parseNumber('1,234.56'), 1234.56);
  assert.equal(Fmt.parseNumber('1.234,56'), 1234.56);
  assert.equal(Fmt.parseNumber('0,0712'), 0.0712);
  assert.equal(Fmt.parseNumber('280,5 ₽'), 280.5);
  assert.ok(Number.isNaN(Fmt.parseNumber('')));
  assert.ok(Number.isNaN(Fmt.parseNumber('abc')));
  assert.ok(Number.isNaN(Fmt.parseNumber('1,2,3')));
});

test('parseDate: ISO и ДД.ММ.ГГГГ, отсекает несуществующие даты', () => {
  assert.equal(Fmt.parseDate('2024-03-05'), '2024-03-05');
  assert.equal(Fmt.parseDate('5.3.2024'), '2024-03-05');
  assert.equal(Fmt.parseDate('05/03/2024'), '2024-03-05');
  assert.equal(Fmt.parseDate('2023-02-29'), null);
  assert.equal(Fmt.parseDate('завтра'), null);
});

test('parseTrade проверяет поля и считает комиссию в процентах', () => {
  const ok = P.parseTrade({ ticker: ' sber ', date: '2024-03-05', side: 'Покупка', qty: '10', price: '280,50', fee: '0,05%' }, '2026-10-06');
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.trade.ticker, 'SBER');
  assert.equal(ok.trade.side, 'buy');
  assert.equal(ok.trade.fee, 1.4); // 2805 × 0,05 % = 1,4025 → 1,40

  const bad = P.parseTrade({ ticker: 'сбер', date: '2030-01-01', side: '?', qty: '1.5', price: '0', fee: '-1' }, '2026-10-06');
  assert.equal(bad.trade, null);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['date', 'fee', 'price', 'qty', 'side', 'ticker']);
});

test('findOversell ловит продажу больше позиции на дату', () => {
  const trades = [tr('2024-01-10', 'SBER', 'buy', 10, 100), tr('2024-01-05', 'SBER', 'sell', 5, 110)];
  const over = P.findOversell(trades);
  assert.ok(over);
  assert.equal(over.trade.date, '2024-01-05');
  assert.equal(over.have, 0);
  assert.equal(P.findOversell([tr('2024-01-10', 'SBER', 'buy', 10, 100), tr('2024-01-11', 'SBER', 'sell', 10, 110)]), null);
});

test('summarize: средняя цена, реализованная и нереализованная прибыль', () => {
  const trades = [
    tr('2024-01-10', 'SBER', 'buy', 10, 100, 1), // себестоимость 1001
    tr('2024-02-10', 'SBER', 'buy', 10, 120, 1), // +1201 → 2202 за 20 шт.
    tr('2024-03-10', 'SBER', 'sell', 5, 130, 1), // списано 5 × 110,1 = 550,5; выручка 649
    tr('2024-01-15', 'GAZP', 'buy', 100, 150, 0),
    tr('2024-04-01', 'GAZP', 'sell', 100, 140, 2), // закрыта: 13998 − 15000 = −1002
  ];
  const { positions, closed, totals } = P.summarize(trades, new Map([['SBER', 140]]));
  assert.equal(positions.length, 1);
  assert.equal(closed.length, 1);

  const s = positions[0];
  assert.equal(s.qty, 15);
  close(s.cost, 1651.5);
  close(s.avgPrice, 110.1);
  close(s.value, 2100);
  close(s.unrealized, 448.5);
  close(s.realized, 649 - 550.5);
  close(s.totalPnl, 2100 + 649 - 2202);
  close(s.totalPnlPct, (2100 + 649 - 2202) / 2202);
  close(s.weight, 1);

  const g = closed[0];
  close(g.realized, -1002);
  close(g.totalPnl, -1002);
  assert.equal(g.value, 0);

  // Итог не зависит от метода списания: стоимость + продажи − покупки.
  close(totals.totalPnl, totals.unrealized + totals.realized);
  close(totals.totalPnl, 2100 + 649 + 13998 - 2202 - 15000);
  close(totals.totalPnlPct, totals.totalPnl / (2202 + 15000));
  close(totals.fees, 5);
  close(totals.netInvested, 2202 + 15000 - 649 - 13998);
});

test('summarize без котировки берёт цену последней сделки', () => {
  const { positions } = P.summarize([tr('2024-01-10', 'XYZ', 'buy', 2, 50), tr('2024-01-12', 'XYZ', 'buy', 2, 60)], new Map());
  assert.equal(positions[0].price, 60);
  assert.equal(positions[0].value, 240);
});

test('buildHistory: цены закрытия, перенос на выходные, чистые вложения', () => {
  const trades = [tr('2024-01-05', 'SBER', 'buy', 10, 100, 1), tr('2024-01-09', 'SBER', 'sell', 4, 110, 1)];
  const closes = new Map([
    [
      'SBER',
      [
        ['2024-01-05', 102],
        ['2024-01-08', 105],
        ['2024-01-09', 111],
      ],
    ],
  ]);
  const { points, approximated } = P.buildHistory(trades, closes, '2024-01-10', new Map([['SBER', 120]]));
  assert.equal(approximated.size, 0);
  assert.deepEqual(
    points.map((p) => p.date),
    ['2024-01-05', '2024-01-06', '2024-01-07', '2024-01-08', '2024-01-09', '2024-01-10']
  );
  assert.equal(points[0].value, 1020);
  assert.equal(points[1].value, 1020); // суббота — последнее закрытие
  assert.equal(points[3].value, 1050);
  assert.equal(points[4].value, 6 * 111);
  assert.equal(points[5].value, 6 * 120); // сегодня — текущая цена
  assert.equal(points[0].invested, 1001);
  assert.equal(points[4].invested, 1001 - 439);
});

test('buildHistory без истории котировок опирается на цены сделок', () => {
  const trades = [tr('2024-01-01', 'XYZ', 'buy', 1, 10), tr('2024-01-03', 'XYZ', 'buy', 1, 14)];
  const { points, approximated } = P.buildHistory(trades, new Map(), '2024-01-04', new Map([['XYZ', 14]]));
  assert.ok(approximated.has('XYZ'));
  assert.deepEqual(
    points.map((p) => p.value),
    [10, 10, 28, 28]
  );
});

test('итог истории совпадает со сводкой на сегодня', () => {
  const trades = [
    tr('2024-01-10', 'SBER', 'buy', 10, 100, 1),
    tr('2024-02-10', 'LKOH', 'buy', 2, 7000, 5),
    tr('2024-03-10', 'SBER', 'sell', 3, 130, 1),
  ];
  const prices = new Map([
    ['SBER', 300],
    ['LKOH', 7100],
  ]);
  const { totals } = P.summarize(trades, prices);
  const { points } = P.buildHistory(trades, new Map(), '2024-04-01', prices);
  const last = points[points.length - 1];
  close(last.value, totals.value);
  close(last.value - last.invested, totals.totalPnl);
});

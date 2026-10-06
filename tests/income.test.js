const test = require('node:test');
const assert = require('node:assert/strict');
const Income = require('../js/income.js');

let seq = 0;
function tr(date, ticker, side, qty, price, fee = 0) {
  seq += 1;
  return { id: 't' + seq, seq, date, ticker, side, qty, price, fee };
}

test('lastTradeDate: Т+1 с 31.07.2023, раньше — Т+2 для акций и Т+0 для облигаций', () => {
  // Реестр в понедельник → купить нужно до пятницы.
  assert.equal(Income.lastTradeDate('2025-07-14', 'dividend'), '2025-07-11');
  assert.equal(Income.lastTradeDate('2025-07-16', 'dividend'), '2025-07-15');
  assert.equal(Income.lastTradeDate('2022-05-12', 'dividend'), '2022-05-10');
  assert.equal(Income.lastTradeDate('2022-05-12', 'coupon'), '2022-05-12');
  assert.equal(Income.lastTradeDate('2025-07-14', 'coupon'), '2025-07-11');
});

test('addWeekdays пропускает выходные', () => {
  assert.equal(Income.addWeekdays('2025-07-11', 1), '2025-07-14'); // пятница → понедельник
  assert.equal(Income.addWeekdays('2025-07-14', 10), '2025-07-28');
  assert.equal(Income.addWeekdays('2025-07-14', -1), '2025-07-11');
});

test('дивиденд начисляется на бумаги, купленные до даты отсечки', () => {
  const trades = [
    tr('2025-06-02', 'SBER', 'buy', 100, 300),
    tr('2025-07-17', 'SBER', 'buy', 50, 310), // реестр 18.07 → последний день покупки 17.07
    tr('2025-07-18', 'SBER', 'buy', 7, 310), // уже поздно
    tr('2025-07-18', 'SBER', 'sell', 20, 315), // продажа в день реестра не лишает дивиденда
  ];
  const events = new Map([['SBER', { kind: 'dividend', items: [{ recordDate: '2025-07-18', value: 34.84, currency: 'SUR' }] }]]);
  const res = Income.build(trades, events, { today: '2026-10-06', taxRate: 0.13 });
  assert.equal(res.items.length, 1);
  const d = res.items[0];
  assert.equal(d.qty, 150);
  assert.equal(d.gross, 5226);
  assert.equal(d.tax, 679.38);
  assert.equal(d.net, 4546.62);
  assert.equal(d.status, 'received');
  assert.equal(d.payDate, '2025-08-01'); // +10 рабочих дней, оценка
  assert.ok(d.payEstimated);
  assert.equal(res.totals.receivedNet, 4546.62);
  assert.equal(res.totals.dividends, 4546.62);
  assert.equal(res.byTicker.get('SBER'), 4546.62);
});

test('нет бумаг на дату отсечки — нет выплаты', () => {
  const trades = [tr('2025-08-01', 'SBER', 'buy', 10, 300)];
  const events = new Map([['SBER', { kind: 'dividend', items: [{ recordDate: '2025-07-18', value: 34.84 }] }]]);
  assert.equal(Income.build(trades, events, { today: '2026-10-06' }).items.length, 0);
});

test('купоны: прошлые получены, будущие — в календаре, неизвестный размер отдельно', () => {
  const trades = [tr('2026-01-15', 'RU000A0JX0J2', 'buy', 10, 980), tr('2026-05-05', 'RU000A0JX0J2', 'sell', 4, 990)];
  const events = new Map([
    [
      'RU000A0JX0J2',
      {
        kind: 'coupon',
        items: [
          { payDate: '2026-01-10', recordDate: '2026-01-09', value: 40 }, // до покупки
          { payDate: '2026-04-10', recordDate: '2026-04-09', value: 40 },
          { payDate: '2026-07-10', recordDate: '2026-07-09', value: 40 },
          { payDate: '2026-10-10', recordDate: null, value: 41.5 },
          { payDate: '2027-01-10', recordDate: null, value: null },
          { payDate: '2028-01-10', recordDate: null, value: 41.5 }, // дальше 12 месяцев
        ],
      },
    ],
  ]);
  const res = Income.build(trades, events, { today: '2026-10-06', taxRate: 0 });
  assert.deepEqual(
    res.items.map((i) => [i.payDate, i.qty, i.net, i.status]),
    [
      ['2026-04-10', 10, 400, 'received'],
      ['2026-07-10', 6, 240, 'received'],
      ['2026-10-10', 6, 249, 'expected'],
      ['2027-01-10', 6, null, 'expected'],
      ['2028-01-10', 6, 249, 'expected'],
    ]
  );
  assert.equal(res.items[2].recordDate, '2026-10-09'); // без даты реестра — рабочий день до выплаты
  assert.equal(res.totals.receivedNet, 640);
  assert.equal(res.totals.coupons, 640);
  assert.equal(res.totals.expectedNet, 249);
  assert.equal(res.totals.expectedUnknown, 1);
  assert.equal(res.upcoming.length, 3);
  assert.equal(res.received[0].payDate, '2026-07-10'); // новые сверху
});

test('исключённые события и ручные выплаты', () => {
  const trades = [tr('2025-01-10', 'LKOH', 'buy', 2, 7000)];
  const events = new Map([
    [
      'LKOH',
      {
        kind: 'dividend',
        items: [
          { recordDate: '2025-06-03', value: 541 },
          { recordDate: '2025-12-20', value: 397, currency: 'USD' }, // не в рублях — пропускаем
        ],
      },
    ],
  ]);
  const key = 'LKOH:dividend:2025-06-03';
  const res = Income.build(trades, events, {
    today: '2026-10-06',
    taxRate: 0.13,
    excluded: new Set([key]),
    manual: [{ id: 'm1', ticker: 'LKOH', date: '2025-06-20', kind: 'dividend', amount: 941.34 }],
  });
  assert.equal(res.items.length, 2);
  assert.equal(res.items.find((i) => i.key === key).excluded, true);
  assert.equal(res.totals.receivedNet, 941.34);
  assert.equal(Income.cashByDate(res).get('2025-06-20'), 941.34);
  assert.equal(Income.cashByDate(res).size, 1);
});

test('parseManual проверяет поля', () => {
  const ok = Income.parseManual({ ticker: 'sber', date: '01.08.2025', kind: 'dividend', amount: '1 234,5' }, '2026-10-06');
  assert.deepEqual(ok.item, { ticker: 'SBER', date: '2025-08-01', kind: 'dividend', amount: 1234.5, note: '' });
  const bad = Income.parseManual({ ticker: '', date: '2030-01-01', kind: 'x', amount: '-1' }, '2026-10-06');
  assert.equal(bad.item, null);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['amount', 'date', 'kind', 'ticker']);
});

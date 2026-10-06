const test = require('node:test');
const assert = require('node:assert/strict');
const Csv = require('../js/csv.js');

const TODAY = '2026-10-06';

// Похоже на выгрузку брокера: шапка отчёта, строка «Итого», дата со временем, две комиссии.
const BROKER = [
  'Брокерский отчёт;;;;;;;;',
  'Клиент: Иванов И. И.;;;;;;;;',
  ';;;;;;;;',
  'Дата заключения;Время;Код бумаги;Вид сделки;Количество, шт.;Цена за единицу;Сумма сделки;Комиссия брокера;Комиссия биржи',
  '15.01.2025 10:23:45;10:23;SBER;Покупка;100;270,50;27 050,00;8,12;0,81',
  '16.01.2025;11:00;GAZP;Купля;10;;1 300,00;0,39;0,04',
  '20.01.2025;12:00;SBER;Продажа;40;280;11 200,00;3,36;0,34',
  '21.01.2025;12:00;SBER;Перевод ЦБ;5;;;;',
  'Итого;;;;;;39 550,00;11,87;1,19',
].join('\r\n');

test('findHeaderRow находит заголовок под шапкой отчёта', () => {
  const rows = Csv.parseCSV(BROKER);
  assert.equal(Csv.findHeaderRow(rows), 2); // пустая строка отброшена при разборе
});

test('guessMapping узнаёт столбцы брокера', () => {
  const rows = Csv.parseCSV(BROKER);
  const m = Csv.guessMapping(rows[2]);
  assert.deepEqual(m, { date: 0, ticker: 2, side: 3, qty: 4, price: 5, amount: 6, fee: 7, fee2: 8 });
});

test('guessMapping для собственного экспорта', () => {
  assert.deepEqual(Csv.guessMapping(Csv.TRADE_HEADER), { date: 0, ticker: 1, side: 2, qty: 3, price: 4, amount: -1, fee: 5, fee2: -1 });
});

test('guessSide', () => {
  assert.equal(Csv.guessSide('Покупка'), 'buy');
  assert.equal(Csv.guessSide('Купля'), 'buy');
  assert.equal(Csv.guessSide('BUY'), 'buy');
  assert.equal(Csv.guessSide('Продажа'), 'sell');
  assert.equal(Csv.guessSide('S'), 'sell');
  assert.equal(Csv.guessSide('Перевод ЦБ'), 'skip');
});

test('mapRows: цена из суммы, сумма комиссий, пропуск служебных строк', () => {
  const rows = Csv.parseCSV(BROKER);
  const header = Csv.findHeaderRow(rows);
  const mapping = Csv.guessMapping(rows[header]);
  const { trades, errors, skipped } = Csv.mapRows(rows, header, mapping, {}, TODAY);
  assert.deepEqual(errors, []);
  assert.deepEqual(trades, [
    { ticker: 'SBER', date: '2025-01-15', side: 'buy', qty: 100, price: 270.5, fee: 8.93, row: 5 },
    { ticker: 'GAZP', date: '2025-01-16', side: 'buy', qty: 10, price: 130, fee: 0.43, row: 6 },
    { ticker: 'SBER', date: '2025-01-20', side: 'sell', qty: 40, price: 280, fee: 3.7, row: 7 },
  ]);
  assert.deepEqual(
    skipped.map((s) => s.row),
    [8, 9]
  );
});

test('mapRows: пользователь сам задаёт значения операции', () => {
  const rows = Csv.parseCSV('Date;Sym;Op;Q;P\n2025-02-01;LKOH;A;1;7000\n2025-02-02;LKOH;B;1;7100\n');
  const mapping = { date: 0, ticker: 1, side: 2, qty: 3, price: 4, amount: -1, fee: -1, fee2: -1 };
  const { trades } = Csv.mapRows(rows, 0, mapping, { A: 'buy', B: 'sell' }, TODAY);
  assert.deepEqual(
    trades.map((t) => t.side),
    ['buy', 'sell']
  );
});

test('mapRows: направление по знаку количества', () => {
  const rows = Csv.parseCSV('Дата,Тикер,Кол-во,Цена\n2025-02-01,YDEX,5,"4000,5"\n2025-02-03,YDEX,-2,4100\n');
  const mapping = Csv.guessMapping(rows[0]);
  assert.equal(mapping.side, -1);
  const { trades, errors } = Csv.mapRows(rows, 0, mapping, {}, TODAY);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    trades.map((t) => [t.side, t.qty, t.price]),
    [
      ['buy', 5, 4000.5],
      ['sell', 2, 4100],
    ]
  );
});

test('mapRows: ошибки с номерами строк и проверка обязательных столбцов', () => {
  const rows = Csv.parseCSV('Дата;Тикер;Операция;Количество;Цена\n2025-02-01;SBER;Покупка;1,5;300\n2031-01-01;SBER;Покупка;1;300\n');
  const res = Csv.mapRows(rows, 0, Csv.guessMapping(rows[0]), {}, TODAY);
  assert.equal(res.trades.length, 0);
  assert.deepEqual(
    res.errors.map((e) => e.row),
    [2, 3]
  );
  const none = Csv.mapRows(rows, 0, { date: 0, ticker: -1, side: 2, qty: 3, price: -1, amount: -1, fee: -1, fee2: -1 }, {}, TODAY);
  assert.match(none.errors[0].message, /Тикер.*Цена за 1 шт\. или Сумма сделки/);
});

test('findDuplicates учитывает повторы', () => {
  const a = { date: '2025-01-01', ticker: 'SBER', side: 'buy', qty: 1, price: 300 };
  const dup = Csv.findDuplicates([a], [Object.assign({}, a), Object.assign({}, a), Object.assign({}, a, { qty: 2 })]);
  assert.deepEqual([...dup], [0]);
});

test('headerSignature не зависит от регистра и пробелов', () => {
  assert.equal(Csv.headerSignature([' Дата ', 'ТИКЕР']), Csv.headerSignature(['дата', 'тикер']));
});

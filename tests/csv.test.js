const test = require('node:test');
const assert = require('node:assert/strict');
const Csv = require('../js/csv.js');

const TODAY = '2026-10-06';

test('экспорт сделок: «;», десятичная запятая, BOM, порядок по дате', () => {
  const csv = Csv.tradesToCSV([
    { id: 'b', seq: 2, date: '2024-03-01', ticker: 'GAZP', side: 'sell', qty: 5, price: 160.25, fee: 0.4 },
    { id: 'a', seq: 1, date: '2024-02-01', ticker: 'SBER', side: 'buy', qty: 10, price: 0.0712, fee: 0 },
  ]);
  assert.ok(csv.startsWith('﻿'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], 'Дата;Тикер;Операция;Количество;Цена;Комиссия');
  assert.equal(lines[1], '2024-02-01;SBER;Покупка;10;0,0712;0');
  assert.equal(lines[2], '2024-03-01;GAZP;Продажа;5;160,25;0,4');
});

test('экспорт → импорт возвращает те же сделки', () => {
  const trades = [
    { seq: 1, date: '2024-02-01', ticker: 'SBER', side: 'buy', qty: 10, price: 280.5, fee: 1.4 },
    { seq: 2, date: '2024-03-01', ticker: 'SBER', side: 'sell', qty: 4, price: 300, fee: 0.6 },
  ];
  const { trades: back, errors } = Csv.parseTradesCSV(Csv.tradesToCSV(trades), TODAY);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    back,
    trades.map(({ seq, ...t }) => t)
  );
});

test('импорт: запятая-разделитель, кавычки, английские заголовки и другой порядок', () => {
  const text = 'Ticker,Date,Side,Price,Qty,Fee\nlkoh,05.03.2024,BUY,"7 012,50",2,"3,5"\n';
  const { trades, errors } = Csv.parseTradesCSV(text, TODAY);
  assert.deepEqual(errors, []);
  assert.deepEqual(trades, [{ ticker: 'LKOH', date: '2024-03-05', side: 'buy', qty: 2, price: 7012.5, fee: 3.5 }]);
});

test('импорт без заголовка и с пустыми строками', () => {
  const { trades, errors } = Csv.parseTradesCSV('2024-01-10;SBER;покупка;1;250\n\n2024-01-11;SBER;продажа;1;260;0,1\n', TODAY);
  assert.deepEqual(errors, []);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].fee, 0);
  assert.equal(trades[1].side, 'sell');
});

test('импорт сообщает номер строки с ошибкой', () => {
  const { errors } = Csv.parseTradesCSV('Дата;Тикер;Операция;Количество;Цена\n2024-01-10;SBER;покупка;1;250\n2024-13-01;SBER;покупка;x;250\n', TODAY);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^Строка 3: /);
});

test('импорт: не хватает обязательного столбца', () => {
  const { errors } = Csv.parseTradesCSV('Дата;Тикер;Количество;Цена\n2024-01-10;SBER;1;250\n', TODAY);
  assert.match(errors[0], /Операция/);
});

test('текстовые ячейки не превращаются в формулы Excel', () => {
  assert.equal(Csv.text('=HYPERLINK("x")'), '\'=HYPERLINK("x")');
  assert.equal(Csv.text('Сбербанк'), 'Сбербанк');
  const csv = Csv.toCSV([['a;b', 'say "hi"']]);
  assert.equal(csv, '﻿"a;b";"say ""hi"""\r\n');
});

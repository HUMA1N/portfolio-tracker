/*
 * CSV для Excel с русской локалью: разделитель «;», десятичная запятая, UTF-8 с BOM.
 * Импорт понимает и «;», и «,», и табуляцию, русские и английские заголовки.
 */
(function (root, factory) {
  const req = typeof require === 'function' ? require : null;
  const api = factory(root.Fmt || req('./format.js'), root.Portfolio || req('./portfolio.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Csv = api;
})(typeof self !== 'undefined' ? self : this, function (Fmt, Portfolio) {
  'use strict';

  const SEP = ';';
  const BOM = '﻿';
  const TRADE_HEADER = ['Дата', 'Тикер', 'Операция', 'Количество', 'Цена', 'Комиссия'];

  function escapeCell(s) {
    const str = String(s);
    return /[";\n\r]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
  }

  // Текст из внешних источников: не даём Excel принять его за формулу.
  function text(s) {
    const str = String(s == null ? '' : s);
    return /^[=+\-@\t\r]/.test(str) ? "'" + str : str;
  }

  function num(v, digits) {
    if (!Number.isFinite(v)) return '';
    const s = digits == null ? String(v) : String(Math.round(v * Math.pow(10, digits)) / Math.pow(10, digits));
    return s.replace('.', ',');
  }

  function toCSV(rows) {
    return BOM + rows.map((r) => r.map(escapeCell).join(SEP)).join('\r\n') + '\r\n';
  }

  function tradesToCSV(trades) {
    const rows = [TRADE_HEADER];
    for (const t of Portfolio.sortTrades(trades)) {
      rows.push([t.date, t.ticker, t.side === 'buy' ? 'Покупка' : 'Продажа', num(t.qty), num(t.price), num(t.fee)]);
    }
    return toCSV(rows);
  }

  function detectSeparator(line) {
    const counts = { ';': 0, ',': 0, '\t': 0 };
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch in counts) counts[ch]++;
    }
    if (counts[';']) return ';';
    if (counts['\t']) return '\t';
    return ',';
  }

  function parseCSV(textIn) {
    const src = String(textIn).replace(/^﻿/, '');
    const firstLine = src.split(/\r?\n/, 1)[0] || '';
    const sep = detectSeparator(firstLine);
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            cell += '"';
            i++;
          } else quoted = false;
        } else cell += ch;
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === sep) {
        row.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c.trim() !== ''));
  }

  const ALIASES = {
    date: ['дата', 'date', 'дата сделки', 'trade date'],
    ticker: ['тикер', 'ticker', 'бумага', 'secid', 'symbol', 'код'],
    side: ['операция', 'тип', 'тип сделки', 'направление', 'side', 'type', 'direction', 'operation'],
    qty: ['количество', 'кол-во', 'шт', 'шт.', 'qty', 'quantity', 'amount'],
    price: ['цена', 'цена за шт.', 'цена за штуку', 'price'],
    fee: ['комиссия', 'fee', 'fees', 'commission'],
  };

  function headerKey(h) {
    const n = String(h).trim().toLowerCase().replace(/^'/, '').split(/[,(]/)[0].trim();
    for (const [key, list] of Object.entries(ALIASES)) if (list.includes(n)) return key;
    return null;
  }

  /*
   * Разбирает CSV со сделками. Возвращает { trades, errors }, где errors —
   * строки вида «Строка 3: …». Сделки без seq: порядок задаёт вызывающий код.
   */
  function parseTradesCSV(textIn, today) {
    const rows = parseCSV(textIn);
    const errors = [];
    const trades = [];
    if (!rows.length) return { trades, errors: ['Файл пустой'] };

    let map = null;
    let startRow = 0;
    const keys = rows[0].map(headerKey);
    if (keys.filter(Boolean).length >= 3) {
      map = {};
      keys.forEach((k, i) => {
        if (k && !(k in map)) map[k] = i;
      });
      startRow = 1;
      const missing = ['date', 'ticker', 'side', 'qty', 'price'].filter((k) => !(k in map));
      if (missing.length) {
        const names = { date: 'Дата', ticker: 'Тикер', side: 'Операция', qty: 'Количество', price: 'Цена' };
        return { trades, errors: ['Нет столбцов: ' + missing.map((k) => names[k]).join(', ')] };
      }
    } else {
      map = { date: 0, ticker: 1, side: 2, qty: 3, price: 4, fee: 5 };
    }

    for (let r = startRow; r < rows.length; r++) {
      const row = rows[r];
      const get = (k) => (k in map && map[k] < row.length ? row[map[k]].trim() : '');
      const { trade, errors: errs } = Portfolio.parseTrade(
        { date: get('date'), ticker: get('ticker'), side: get('side'), qty: get('qty'), price: get('price'), fee: get('fee') },
        today
      );
      if (trade) trades.push(trade);
      else errors.push('Строка ' + (r + 1) + ': ' + Object.values(errs).join('; '));
    }
    return { trades, errors };
  }

  return { toCSV, tradesToCSV, parseCSV, parseTradesCSV, text, num, TRADE_HEADER };
});

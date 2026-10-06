/* Форматирование и разбор чисел/дат для русской локали. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Fmt = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LOCALE = 'ru-RU';
  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const nfCache = new Map();

  function nf(opts) {
    const key = JSON.stringify(opts);
    let f = nfCache.get(key);
    if (!f) {
      f = new Intl.NumberFormat(LOCALE, opts);
      nfCache.set(key, f);
    }
    return f;
  }

  // Убирает «−0,00»: значения, округляющиеся до нуля, показываем как ноль.
  function clean(v, digits) {
    const m = Math.pow(10, digits);
    return Math.round(v * m) === 0 ? 0 : v;
  }

  function money(v, opts) {
    if (!Number.isFinite(v)) return '—';
    const o = opts || {};
    const digits = o.digits == null ? 2 : o.digits;
    return nf({
      style: 'currency',
      currency: 'RUB',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: o.sign ? 'exceptZero' : 'auto',
    }).format(clean(v, digits));
  }

  // Цена за штуку: копейки для обычных бумаг, больше знаков для дешёвых (0,0712 ₽).
  function price(v) {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    const max = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
    return nf({ style: 'currency', currency: 'RUB', minimumFractionDigits: 2, maximumFractionDigits: max }).format(v);
  }

  function pct(ratio, opts) {
    if (!Number.isFinite(ratio)) return '—';
    const o = opts || {};
    const digits = o.digits == null ? 2 : o.digits;
    const v = clean(ratio * 100, digits);
    return nf({
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: o.sign === false ? 'auto' : 'exceptZero',
    }).format(v) + ' %';
  }

  function qty(v) {
    if (!Number.isFinite(v)) return '—';
    return nf({ maximumFractionDigits: 6 }).format(v);
  }

  // Подписи оси: «1,2 млн ₽», «850 тыс. ₽».
  function compactMoney(v) {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    if (abs < 10000) return nf({ maximumFractionDigits: 0 }).format(v) + ' ₽';
    return nf({ notation: 'compact', maximumFractionDigits: 1 }).format(v) + ' ₽';
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // ISO-дата (YYYY-MM-DD) → «06.10.2026».
  function date(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-');
    return d + '.' + m + '.' + y;
  }

  function dateShort(iso) {
    const [, m, d] = iso.split('-');
    return +d + ' ' + MONTHS_SHORT[+m - 1];
  }

  function monthLabel(iso, withYear) {
    const [y, m] = iso.split('-');
    return MONTHS_SHORT[+m - 1] + (withYear ? ' ' + y : '');
  }

  function todayISO(now) {
    const d = now || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function isValidISODate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  // Принимает YYYY-MM-DD и DD.MM.YYYY; возвращает ISO или null.
  function parseDate(s) {
    const str = String(s == null ? '' : s).trim();
    let iso = null;
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(str);
    if (m) iso = m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
    m = m || /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(str);
    if (!iso && m) iso = m[3] + '-' + pad2(+m[2]) + '-' + pad2(+m[1]);
    return iso && isValidISODate(iso) ? iso : null;
  }

  // «1 234,56», «1234.56», «1,5» → число; иначе NaN.
  function parseNumber(s) {
    if (typeof s === 'number') return s;
    let str = String(s == null ? '' : s).trim().replace(/[\s  ']/g, '').replace(/₽$/, '');
    if (!str) return NaN;
    const hasComma = str.indexOf(',') !== -1;
    const hasDot = str.indexOf('.') !== -1;
    if (hasComma && hasDot) {
      // Последний разделитель — десятичный, остальные — разряды.
      if (str.lastIndexOf(',') > str.lastIndexOf('.')) str = str.replace(/\./g, '').replace(',', '.');
      else str = str.replace(/,/g, '');
    } else if (hasComma) {
      if ((str.match(/,/g) || []).length > 1) return NaN;
      str = str.replace(',', '.');
    }
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(str)) return NaN;
    return Number(str);
  }

  // Дни между ISO-датами без влияния часовых поясов и перехода на летнее время.
  function dayNumber(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / 86400000);
  }

  function isoFromDayNumber(n) {
    const dt = new Date(n * 86400000);
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }

  function addDays(iso, days) {
    return isoFromDayNumber(dayNumber(iso) + days);
  }

  function addMonths(iso, months) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(Math.min(d, last));
  }

  return {
    money,
    price,
    pct,
    qty,
    compactMoney,
    date,
    dateShort,
    monthLabel,
    todayISO,
    isValidISODate,
    parseDate,
    parseNumber,
    dayNumber,
    isoFromDayNumber,
    addDays,
    addMonths,
    MONTHS_SHORT,
  };
});

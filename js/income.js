/*
 * Дивиденды и купоны: кому положена выплата, сколько, когда.
 * Чистые функции без DOM и сети — события выплат приходят из MOEX ISS (см. moex.js).
 */
(function (root, factory) {
  const req = typeof require === 'function' ? require : null;
  const api = factory(root.Fmt || req('./format.js'), root.Portfolio || req('./portfolio.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Income = api;
})(typeof self !== 'undefined' ? self : this, function (Fmt, Portfolio) {
  'use strict';

  // С 31.07.2023 акции и облигации на MOEX рассчитываются в режиме Т+1.
  const T1_SINCE = '2023-07-31';
  // Срок выплаты дивидендов номинальным держателям (брокерам) — до 10 рабочих дней после даты закрытия реестра.
  const DIVIDEND_PAY_LAG = 10;
  const TAX_RATES = [0.13, 0.15, 0];
  const KIND_LABEL = { dividend: 'Дивиденд', coupon: 'Купон' };

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function isWeekend(iso) {
    const wd = new Date(Fmt.dayNumber(iso) * 86400000).getUTCDay();
    return wd === 0 || wd === 6;
  }

  // Сдвиг на n рабочих дней (праздники биржи не учитываются). n < 0 — назад.
  function addWeekdays(iso, n) {
    let d = iso;
    const step = n < 0 ? -1 : 1;
    for (let left = Math.abs(n); left > 0; ) {
      d = Fmt.addDays(d, step);
      if (!isWeekend(d)) left--;
    }
    return d;
  }

  /*
   * Последний день, когда сделка ещё попадает в реестр на дату recordDate.
   * Т+1: купить нужно за рабочий день до даты закрытия реестра.
   * До 31.07.2023 акции торговались в Т+2, облигации — в Т+0.
   */
  function lastTradeDate(recordDate, kind) {
    let lag = 1;
    if (recordDate < T1_SINCE) lag = kind === 'coupon' ? 0 : 2;
    return lag ? addWeekdays(recordDate, -lag) : recordDate;
  }

  // Количество бумаг в портфеле по сделкам с датой не позже date.
  function qtyOn(trades, ticker, date) {
    let q = 0;
    for (const t of trades) {
      if (t.ticker !== ticker || t.date > date) continue;
      q += t.side === 'buy' ? t.qty : -t.qty;
    }
    return Math.max(0, q);
  }

  function eventKey(e) {
    return e.ticker + ':' + e.kind + ':' + (e.kind === 'coupon' ? e.payDate : e.recordDate);
  }

  /*
   * Начисления по сделкам и событиям MOEX.
   * events: Map тикер → { kind: 'dividend'|'coupon', items: [...] } (как отдаёт moex.js).
   * opts: { today, taxRate, excluded: Set ключей, manual: [{ id, ticker, date, kind, amount, note }] }.
   * Ручные выплаты — суммы, фактически зачисленные брокером (после налога).
   * Возвращает { items, received, upcoming, byTicker, totals }.
   */
  function build(trades, events, opts) {
    const o = opts || {};
    const today = o.today;
    const rate = Number.isFinite(o.taxRate) ? o.taxRate : 0.13;
    const excluded = o.excluded || new Set();
    const items = [];

    for (const [ticker, ev] of events || []) {
      if (!ev || !Array.isArray(ev.items)) continue;
      const tickerTrades = trades.filter((t) => t.ticker === ticker);
      if (!tickerTrades.length) continue;
      for (const raw of ev.items) {
        const kind = ev.kind;
        let recordDate;
        let payDate;
        let payEstimated = false;
        if (kind === 'dividend') {
          if (raw.currency && !['SUR', 'RUB', 'RUR'].includes(String(raw.currency).toUpperCase())) continue;
          recordDate = raw.recordDate;
          payDate = addWeekdays(recordDate, DIVIDEND_PAY_LAG);
          payEstimated = true;
        } else {
          payDate = raw.payDate;
          recordDate = raw.recordDate || addWeekdays(payDate, -1);
        }
        if (!recordDate || !payDate) continue;
        const cutoff = lastTradeDate(recordDate, kind);
        // Будущие события: сделок после сегодняшнего дня ещё нет, считаем по текущему количеству.
        const qty = qtyOn(tickerTrades, ticker, cutoff);
        if (qty <= 0) continue;
        const perUnit = Number.isFinite(raw.value) && raw.value > 0 ? raw.value : null;
        const gross = perUnit != null ? round2(perUnit * qty) : null;
        const tax = gross != null ? round2(gross * rate) : null;
        const item = {
          source: 'moex',
          ticker,
          kind,
          recordDate,
          payDate,
          payEstimated,
          perUnit,
          qty,
          gross,
          tax,
          net: gross != null ? round2(gross - tax) : null,
          status: payDate <= today ? 'received' : 'expected',
        };
        item.key = eventKey(item);
        item.excluded = excluded.has(item.key);
        items.push(item);
      }
    }

    for (const m of o.manual || []) {
      items.push({
        source: 'manual',
        key: 'manual:' + m.id,
        id: m.id,
        ticker: m.ticker,
        kind: m.kind,
        recordDate: null,
        payDate: m.date,
        payEstimated: false,
        perUnit: null,
        qty: null,
        gross: null,
        tax: null,
        net: m.amount,
        note: m.note || '',
        status: m.date <= today ? 'received' : 'expected',
        excluded: false,
      });
    }

    items.sort((a, b) => (a.payDate < b.payDate ? -1 : a.payDate > b.payDate ? 1 : a.ticker < b.ticker ? -1 : 1));

    const byTicker = new Map();
    const totals = { receivedNet: 0, receivedGross: 0, receivedTax: 0, dividends: 0, coupons: 0, expectedNet: 0, expectedUnknown: 0 };
    const yearAhead = today ? Fmt.addMonths(today, 12) : null;
    for (const it of items) {
      if (it.excluded) continue;
      if (it.status === 'received') {
        if (it.net == null) continue;
        totals.receivedNet += it.net;
        totals.receivedGross += it.gross != null ? it.gross : it.net;
        totals.receivedTax += it.tax || 0;
        totals[it.kind === 'coupon' ? 'coupons' : 'dividends'] += it.net;
        byTicker.set(it.ticker, (byTicker.get(it.ticker) || 0) + it.net);
      } else if (!yearAhead || it.payDate <= yearAhead) {
        if (it.net == null) totals.expectedUnknown += 1;
        else totals.expectedNet += it.net;
      }
    }
    for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);

    return {
      items,
      received: items.filter((it) => it.status === 'received').reverse(),
      upcoming: items.filter((it) => it.status === 'expected'),
      byTicker,
      totals,
    };
  }

  // Полученные выплаты по датам зачисления (для расчёта доходности с выплатами).
  function cashByDate(result) {
    const map = new Map();
    for (const it of result.received) {
      if (it.excluded || it.net == null) continue;
      map.set(it.payDate, (map.get(it.payDate) || 0) + it.net);
    }
    return map;
  }

  // Проверка ручной выплаты. Возвращает { item, errors }.
  function parseManual(raw, today) {
    const errors = {};
    const ticker = Portfolio.normalizeTicker(raw.ticker);
    if (!ticker) errors.ticker = 'Укажите тикер';
    else if (!Portfolio.TICKER_RE.test(ticker)) errors.ticker = 'Тикер латиницей и цифрами';
    const date = Fmt.parseDate(raw.date);
    if (!date) errors.date = 'Укажите дату';
    else if (today && date > today) errors.date = 'Дата не может быть в будущем';
    const kind = raw.kind === 'coupon' ? 'coupon' : raw.kind === 'dividend' ? 'dividend' : null;
    if (!kind) errors.kind = 'Выберите вид выплаты';
    const amount = Fmt.parseNumber(raw.amount);
    if (!Number.isFinite(amount) || amount <= 0) errors.amount = 'Сумма больше нуля';
    const note = String(raw.note == null ? '' : raw.note).trim().slice(0, 100);
    if (Object.keys(errors).length) return { item: null, errors };
    return { item: { ticker, date, kind, amount: round2(amount), note }, errors };
  }

  return {
    TAX_RATES,
    KIND_LABEL,
    addWeekdays,
    lastTradeDate,
    qtyOn,
    eventKey,
    build,
    cashByDate,
    parseManual,
  };
});

/*
 * Учёт портфеля: проверка сделок, позиции по методу средней цены,
 * прибыль/убыток и история стоимости. Чистые функции без DOM и сети.
 */
(function (root, factory) {
  const api = factory(root.Fmt || (typeof require === 'function' ? require('./format.js') : null));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Portfolio = api;
})(typeof self !== 'undefined' ? self : this, function (Fmt) {
  'use strict';

  const EPS = 1e-9;
  const TICKER_RE = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;

  function normalizeTicker(s) {
    return String(s == null ? '' : s).trim().toUpperCase();
  }

  function parseSide(s) {
    const v = String(s == null ? '' : s).trim().toLowerCase();
    if (['buy', 'b', 'покупка', 'купить', 'к', 'покуп'].includes(v)) return 'buy';
    if (['sell', 's', 'продажа', 'продать', 'п', 'прод'].includes(v)) return 'sell';
    return null;
  }

  /*
   * Проверяет поля одной сделки. Числа можно передать строками («280,5»),
   * комиссию — в процентах от суммы («0,05%»).
   * Возвращает { trade, errors }, где errors — { поле: текст }.
   */
  function parseTrade(raw, today) {
    const errors = {};
    const ticker = normalizeTicker(raw.ticker);
    if (!ticker) errors.ticker = 'Укажите тикер';
    else if (!TICKER_RE.test(ticker)) errors.ticker = 'Тикер латиницей и цифрами, например SBER';

    const date = typeof raw.date === 'string' ? Fmt.parseDate(raw.date) : null;
    if (!date) errors.date = 'Укажите дату';
    else if (today && date > today) errors.date = 'Дата не может быть в будущем';
    else if (date < '1990-01-01') errors.date = 'Слишком ранняя дата';

    const side = raw.side === 'buy' || raw.side === 'sell' ? raw.side : parseSide(raw.side);
    if (!side) errors.side = 'Выберите покупку или продажу';

    const qty = Fmt.parseNumber(raw.qty);
    if (!Number.isFinite(qty) || qty <= 0) errors.qty = 'Количество больше нуля';
    else if (!Number.isInteger(qty)) errors.qty = 'Количество — целое число штук';

    const price = Fmt.parseNumber(raw.price);
    if (!Number.isFinite(price) || price <= 0) errors.price = 'Цена больше нуля';

    let fee = 0;
    const feeStr = String(raw.fee == null ? '' : raw.fee).trim();
    if (feeStr) {
      if (/%$/.test(feeStr)) {
        const rate = Fmt.parseNumber(feeStr.slice(0, -1));
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) errors.fee = 'Комиссия в % — от 0 до 100';
        else if (Number.isFinite(qty) && Number.isFinite(price)) fee = round2((qty * price * rate) / 100);
      } else {
        fee = Fmt.parseNumber(feeStr);
        if (!Number.isFinite(fee) || fee < 0) errors.fee = 'Комиссия — число не меньше нуля';
      }
    }

    if (Object.keys(errors).length) return { trade: null, errors };
    return { trade: { ticker, date, side, qty, price, fee }, errors };
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  // Порядок учёта: по дате, внутри дня — в порядке ввода.
  function sortTrades(trades) {
    return trades.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.seq || 0) - (b.seq || 0)));
  }

  /*
   * Ищет продажу, для которой на её дату не хватает бумаг.
   * Возвращает null или { trade, have }.
   */
  function findOversell(trades) {
    const held = new Map();
    for (const t of sortTrades(trades)) {
      const have = held.get(t.ticker) || 0;
      if (t.side === 'sell') {
        if (t.qty > have + EPS) return { trade: t, have };
        held.set(t.ticker, have - t.qty);
      } else {
        held.set(t.ticker, have + t.qty);
      }
    }
    return null;
  }

  /*
   * Проводит сделки по бумаге методом средней цены:
   * покупка увеличивает себестоимость на сумму + комиссия,
   * продажа списывает себестоимость по средней цене, разница — реализованный результат.
   */
  function buildLedger(trades) {
    const map = new Map();
    for (const t of sortTrades(trades)) {
      let p = map.get(t.ticker);
      if (!p) {
        p = {
          ticker: t.ticker,
          qty: 0,
          cost: 0,
          buyCost: 0,
          sellProceeds: 0,
          realized: 0,
          fees: 0,
          firstDate: t.date,
          lastDate: t.date,
          lastTradePrice: t.price,
          tradeCount: 0,
        };
        map.set(t.ticker, p);
      }
      const gross = t.qty * t.price;
      p.fees += t.fee;
      if (t.side === 'buy') {
        p.qty += t.qty;
        p.cost += gross + t.fee;
        p.buyCost += gross + t.fee;
      } else {
        const avg = p.qty > EPS ? p.cost / p.qty : 0;
        const costOut = avg * t.qty;
        p.qty -= t.qty;
        p.cost -= costOut;
        if (p.qty <= EPS) {
          p.qty = 0;
          p.cost = 0;
        }
        p.sellProceeds += gross - t.fee;
        p.realized += gross - t.fee - costOut;
      }
      p.lastDate = t.date;
      p.lastTradePrice = t.price;
      p.tradeCount += 1;
    }
    return map;
  }

  /*
   * Позиции и итоги. prices: Map тикер → текущая цена; если цены нет,
   * берётся цена последней сделки (приложение помечает такие бумаги).
   */
  function summarize(trades, prices) {
    const ledger = buildLedger(trades);
    const open = [];
    const closed = [];
    const totals = {
      value: 0,
      cost: 0,
      buyCost: 0,
      sellProceeds: 0,
      realized: 0,
      fees: 0,
      unrealized: 0,
      unrealizedPct: NaN,
      totalPnl: 0,
      totalPnlPct: NaN,
      netInvested: 0,
      openCount: 0,
    };

    for (const p of ledger.values()) {
      const known = prices && prices.get(p.ticker);
      const price = Number.isFinite(known) && known > 0 ? known : p.lastTradePrice;
      const value = p.qty * price;
      const unrealized = p.qty > 0 ? value - p.cost : 0;
      // Итог по бумаге = стоимость + выручка от продаж − все затраты на покупки.
      const totalPnl = value + p.sellProceeds - p.buyCost;
      const pos = Object.assign({}, p, {
        price,
        value,
        avgPrice: p.qty > 0 ? p.cost / p.qty : NaN,
        unrealized,
        unrealizedPct: p.qty > 0 && p.cost > 0 ? unrealized / p.cost : NaN,
        totalPnl,
        totalPnlPct: p.buyCost > 0 ? totalPnl / p.buyCost : NaN,
        weight: 0,
      });
      (p.qty > 0 ? open : closed).push(pos);

      totals.value += value;
      totals.cost += p.cost;
      totals.buyCost += p.buyCost;
      totals.sellProceeds += p.sellProceeds;
      totals.realized += p.realized;
      totals.fees += p.fees;
    }

    for (const pos of open) pos.weight = totals.value > 0 ? pos.value / totals.value : 0;
    open.sort((a, b) => b.value - a.value || (a.ticker < b.ticker ? -1 : 1));
    closed.sort((a, b) => (a.lastDate < b.lastDate ? 1 : a.lastDate > b.lastDate ? -1 : 0));

    totals.openCount = open.length;
    totals.unrealized = totals.value - totals.cost;
    totals.unrealizedPct = totals.cost > 0 ? totals.unrealized / totals.cost : NaN;
    totals.totalPnl = totals.value + totals.sellProceeds - totals.buyCost;
    totals.totalPnlPct = totals.buyCost > 0 ? totals.totalPnl / totals.buyCost : NaN;
    totals.netInvested = totals.buyCost - totals.sellProceeds;

    return { positions: open, closed, totals };
  }

  /*
   * История стоимости по календарным дням от первой сделки до today.
   * closes: Map тикер → [[ISO-дата, цена закрытия], ...] (по возрастанию дат).
   * current: Map тикер → текущая цена (подставляется на сегодняшний день).
   * Цена на день — последняя известная на эту дату: закрытие торгов,
   * а если его нет — цена сделки. Возвращает { points, approximated: Set тикеров без истории }.
   */
  function buildHistory(trades, closes, today, current) {
    const sorted = sortTrades(trades);
    if (!sorted.length) return { points: [], approximated: new Set() };

    const tickers = [...new Set(sorted.map((t) => t.ticker))];
    const series = new Map();
    const approximated = new Set();
    for (const tk of tickers) {
      const byDate = new Map();
      for (const t of sorted) if (t.ticker === tk) byDate.set(t.date, t.price);
      const cl = closes && closes.get(tk);
      if (cl && cl.length) {
        for (const [d, c] of cl) if (d <= today && c > 0) byDate.set(d, c);
      } else {
        approximated.add(tk);
      }
      const cur = current && current.get(tk);
      if (Number.isFinite(cur) && cur > 0) byDate.set(today, cur);
      series.set(tk, { pts: [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)), i: -1 });
    }

    const held = new Map();
    let invested = 0;
    let ti = 0;
    const points = [];
    const start = Fmt.dayNumber(sorted[0].date);
    const end = Math.max(start, Fmt.dayNumber(today));

    for (let n = start; n <= end; n++) {
      const d = Fmt.isoFromDayNumber(n);
      while (ti < sorted.length && sorted[ti].date === d) {
        const t = sorted[ti++];
        const gross = t.qty * t.price;
        if (t.side === 'buy') {
          held.set(t.ticker, (held.get(t.ticker) || 0) + t.qty);
          invested += gross + t.fee;
        } else {
          held.set(t.ticker, (held.get(t.ticker) || 0) - t.qty);
          invested -= gross - t.fee;
        }
      }
      let value = 0;
      for (const [tk, q] of held) {
        const s = series.get(tk);
        while (s.i + 1 < s.pts.length && s.pts[s.i + 1][0] <= d) s.i++;
        if (q > EPS && s.i >= 0) value += q * s.pts[s.i][1];
      }
      points.push({ date: d, value, invested });
    }
    return { points, approximated };
  }

  return {
    TICKER_RE,
    normalizeTicker,
    parseSide,
    parseTrade,
    sortTrades,
    findOversell,
    buildLedger,
    summarize,
    buildHistory,
  };
});

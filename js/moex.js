/*
 * Клиент MOEX ISS (https://iss.moex.com) — бесплатный публичный API без ключа.
 * Данные отдаются с задержкой около 15 минут. Поддерживается фондовый рынок
 * «акции» (engine=stock, market=shares): акции, ETF и БПИФ.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Moex = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BASE = 'https://iss.moex.com/iss';
  const TIMEOUT_MS = 12000;
  const PREFERRED_BOARDS = ['TQBR', 'TQTF', 'TQIF', 'TQPI', 'TQTD', 'TQTE', 'FQBR', 'SMAL'];
  const RUB = ['SUR', 'RUB', 'RUR'];
  const BATCH = 10;

  let fetchImpl = typeof fetch === 'function' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null;

  function setFetch(fn) {
    fetchImpl = fn;
  }

  // network=true — сервер недоступен целиком (нет сети, CORS, таймаут): остальные запросы можно не слать.
  class MoexError extends Error {
    constructor(message, network) {
      super(message);
      this.network = !!network;
    }
  }

  async function getJson(path, params) {
    const url = new URL(BASE + path);
    url.searchParams.set('iss.meta', 'off');
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      let res;
      try {
        res = await fetchImpl(url.toString(), { signal: ctrl && ctrl.signal, cache: 'no-store' });
      } catch (e) {
        throw new MoexError(e && e.name === 'AbortError' ? 'нет ответа от сервера' : 'нет соединения', true);
      }
      if (!res.ok) throw new MoexError('ошибка сервера ' + res.status, res.status >= 500 || res.status === 429);
      try {
        return await res.json();
      } catch (e) {
        throw new MoexError('неожиданный ответ сервера');
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Блок ISS {columns, data} → массив объектов с ключами в верхнем регистре.
  function rows(json, block) {
    const b = json && json[block];
    if (!b || !Array.isArray(b.columns) || !Array.isArray(b.data)) return [];
    const cols = b.columns.map((c) => String(c).toUpperCase());
    return b.data.map((r) => {
      const o = {};
      cols.forEach((c, i) => {
        o[c] = r[i];
      });
      return o;
    });
  }

  /*
   * Основной режим торгов бумаги. Возвращает
   * { status: 'ok', board, currency } | { status: 'notfound' } | { status: 'unsupported', market }.
   */
  async function resolveBoard(ticker) {
    const json = await getJson('/securities/' + encodeURIComponent(ticker) + '.json', { 'iss.only': 'boards' });
    const all = rows(json, 'boards');
    if (!all.length) return { status: 'notfound' };
    const shares = all.filter((r) => r.ENGINE === 'stock' && r.MARKET === 'shares');
    if (!shares.length) return { status: 'unsupported', market: String(all[0].MARKET || '') };
    const traded = shares.filter((r) => Number(r.IS_TRADED) === 1);
    const pick =
      traded.find((r) => Number(r.IS_PRIMARY) === 1) ||
      PREFERRED_BOARDS.map((b) => traded.find((r) => r.BOARDID === b)).find(Boolean) ||
      traded[0] ||
      shares.find((r) => Number(r.IS_PRIMARY) === 1) ||
      shares[0];
    return { status: 'ok', board: pick.BOARDID, currency: pick.CURRENCYID || null };
  }

  function positive(v) {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
  }

  /*
   * Текущие цены по одному режиму торгов. Возвращает
   * { ТИКЕР: { price, kind: 'last'|'current'|'close'|'prevclose', time, name, currency } }.
   */
  async function fetchQuotes(board, tickers) {
    const out = {};
    for (let i = 0; i < tickers.length; i += BATCH) {
      const chunk = tickers.slice(i, i + BATCH);
      const json = await getJson('/engines/stock/markets/shares/boards/' + encodeURIComponent(board) + '/securities.json', {
        securities: chunk.join(','),
        'iss.only': 'securities,marketdata',
      });
      const sec = rows(json, 'securities');
      const md = rows(json, 'marketdata');
      for (const s of sec) {
        if (!chunk.includes(s.SECID)) continue;
        const m = md.find((x) => x.SECID === s.SECID && (!x.BOARDID || !s.BOARDID || x.BOARDID === s.BOARDID)) || {};
        const candidates = [
          [m.LAST, 'last'],
          [m.LCURRENTPRICE, 'current'],
          [m.MARKETPRICE, 'current'],
          [m.LEGALCLOSEPRICE, 'close'],
          [s.PREVLEGALCLOSEPRICE, 'prevclose'],
          [s.PREVPRICE, 'prevclose'],
        ];
        const hit = candidates.find(([v]) => positive(v) != null);
        if (!hit) continue;
        out[s.SECID] = {
          price: positive(hit[0]),
          kind: hit[1],
          time: m.SYSTIME || null,
          name: s.SHORTNAME || s.SECNAME || null,
          currency: s.CURRENCYID || null,
        };
      }
    }
    return out;
  }

  /*
   * Дневные цены закрытия за период (свечи interval=24).
   * Возвращает [[YYYY-MM-DD, close], ...] по возрастанию дат.
   */
  async function fetchCloses(board, ticker, from, till) {
    const byDate = new Map();
    let start = 0;
    let prevFirst = null;
    for (let page = 0; page < 60; page++) {
      const json = await getJson(
        '/engines/stock/markets/shares/boards/' + encodeURIComponent(board) + '/securities/' + encodeURIComponent(ticker) + '/candles.json',
        { from, till, interval: 24, start }
      );
      const rs = rows(json, 'candles');
      if (!rs.length || rs[0].BEGIN === prevFirst) break;
      prevFirst = rs[0].BEGIN;
      for (const r of rs) {
        const d = String(r.BEGIN || '').slice(0, 10);
        const c = positive(r.CLOSE);
        if (d && c != null) byDate.set(d, c);
      }
      start += rs.length;
      const lastDate = String(rs[rs.length - 1].BEGIN || '').slice(0, 10);
      if (lastDate >= till) break;
    }
    return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  function isRub(currency) {
    return !currency || RUB.includes(String(currency).toUpperCase());
  }

  return { BASE, MoexError, setFetch, getJson, rows, resolveBoard, fetchQuotes, fetchCloses, isRub };
});

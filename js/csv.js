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
    // У каждой строки есть свойство line — номер строки в файле (для сообщений об ошибках).
    const rows = [];
    let line = 1;
    let row = [];
    row.line = line;
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
        } else {
          if (ch === '\n') line++;
          cell += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === sep) {
        row.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(cell);
        rows.push(row);
        line++;
        row = [];
        row.line = line;
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
      else errors.push('Строка ' + (row.line || r + 1) + ': ' + Object.values(errs).join('; '));
    }
    return { trades, errors };
  }

  /* ---------- Импорт отчёта брокера с сопоставлением столбцов ---------- */

  // Поля сделки, которые можно взять из файла. Нужны дата, тикер, количество и цена (или сумма).
  const FIELDS = [
    { key: 'date', label: 'Дата сделки', required: true },
    { key: 'ticker', label: 'Тикер (код бумаги)', required: true },
    { key: 'side', label: 'Покупка или продажа' },
    { key: 'qty', label: 'Количество, шт.', required: true },
    { key: 'price', label: 'Цена за 1 шт.' },
    { key: 'amount', label: 'Сумма сделки' },
    { key: 'fee', label: 'Комиссия' },
    { key: 'fee2', label: 'Ещё комиссия (например, биржи)' },
  ];

  // Точные названия столбцов из отчётов разных брокеров (в нижнем регистре).
  const BROKER_ALIASES = {
    date: ALIASES.date.concat(['дата заключения', 'дата заключения сделки', 'дата и время', 'дата/время', 'дата исполнения', 'дата операции', 'tradedate', 'datetime', 'time']),
    ticker: ALIASES.ticker.concat(['код бумаги', 'код инструмента', 'код актива', 'код цб', 'тикер бумаги', 'торговый код', 'инструмент', 'актив', 'isin', 'secid']),
    side: ALIASES.side.concat(['вид сделки', 'тип операции', 'покупка/продажа', 'направление сделки', 'операция с цб', 'buy/sell']),
    qty: ALIASES.qty.concat(['количество цб', 'количество ценных бумаг', 'кол-во цб', 'кол-во бумаг', 'объем, шт', 'лоты (шт)']),
    price: ALIASES.price.concat(['цена сделки', 'цена за единицу', 'цена одной цб', 'цена исполнения', 'цена за 1 шт']),
    amount: ['сумма', 'сумма сделки', 'объем', 'объём', 'объем сделки', 'объём сделки', 'сумма сделки без нкд', 'value', 'total'],
    fee: ALIASES.fee.concat(['комиссия брокера', 'брокерская комиссия', 'комиссия банка', 'комиссия за сделку']),
    fee2: ['комиссия биржи', 'биржевая комиссия', 'комиссия тс', 'комиссия торговой системы', 'exchange fee'],
  };

  // Если точного совпадения нет — по ключевым словам.
  const KEYWORDS = {
    date: /дата|date/,
    ticker: /тикер|ticker|код (бумаги|инструмента|цб)|isin|symbol/,
    side: /операц|направлен|вид сделки|тип сделки|покупка\/продажа|side|buy\/sell/,
    qty: /количеств|кол-во|qty|quantity/,
    price: /^цена|price/,
    amount: /^сумма|^объ[её]м|amount|value/,
    fee: /комисс|fee|commission/,
    fee2: /комисс.*(бирж|тс|торгов)|exchange/,
  };

  function normHeader(h) {
    return String(h == null ? '' : h).trim().toLowerCase().replace(/^'/, '').replace(/ё/g, 'е').replace(/\s+/g, ' ');
  }

  function exactKey(h) {
    const n = normHeader(h);
    const short = n.split(/[,(]/)[0].trim();
    for (const [key, list] of Object.entries(BROKER_ALIASES)) {
      const norm = list.map((x) => x.replace(/ё/g, 'е'));
      if (norm.includes(n) || norm.includes(short)) return key;
    }
    return null;
  }

  // Строка заголовка — та, где больше всего узнаваемых названий столбцов (отчёты брокеров часто начинаются с шапки).
  function findHeaderRow(rows) {
    let best = 0;
    let bestScore = 0;
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const score = rows[i].filter((c) => exactKey(c) || Object.values(KEYWORDS).some((re) => re.test(normHeader(c)))).length;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    return bestScore >= 2 ? best : 0;
  }

  /*
   * Угадывает, какой столбец какому полю соответствует.
   * Возвращает { поле: номер столбца или -1 }.
   */
  function guessMapping(header) {
    const map = {};
    for (const f of FIELDS) map[f.key] = -1;
    const used = new Set();
    header.forEach((h, i) => {
      const k = exactKey(h);
      if (k && map[k] === -1) {
        map[k] = i;
        used.add(i);
      }
    });
    for (const key of ['fee2', 'date', 'ticker', 'side', 'qty', 'price', 'amount', 'fee']) {
      if (map[key] !== -1) continue;
      const i = header.findIndex((h, j) => !used.has(j) && KEYWORDS[key].test(normHeader(h)));
      if (i !== -1) {
        map[key] = i;
        used.add(i);
      }
    }
    // Вторая комиссия имеет смысл, только если есть первая.
    if (map.fee === -1 && map.fee2 !== -1) {
      map.fee = map.fee2;
      map.fee2 = -1;
    }
    return map;
  }

  // Значение из столбца «Операция» → 'buy' | 'sell' | 'skip'.
  function guessSide(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return 'skip';
    const exact = Portfolio.parseSide(s);
    if (exact) return exact;
    if (/куп|покуп|buy|приобр/.test(s)) return 'buy';
    if (/прод|sell|реализ/.test(s)) return 'sell';
    return 'skip';
  }

  // Разные значения в столбце операции (для таблицы «что считать покупкой»).
  function distinctValues(rows, start, col, limit) {
    const out = [];
    if (col < 0) return out;
    for (let r = start; r < rows.length && out.length < (limit || 30); r++) {
      const v = (rows[r][col] || '').trim();
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }

  // «15.01.2025 10:23:45», «2025-01-15T10:23» → дата без времени.
  function cellDate(v) {
    const s = String(v == null ? '' : v).trim();
    return Fmt.parseDate(s.split(/[ T]/)[0]);
  }

  function cellNum(v) {
    const s = String(v == null ? '' : v).trim();
    return s ? Fmt.parseNumber(s) : NaN;
  }

  /*
   * Сделки из строк файла по выбранному сопоставлению.
   * mapping: { поле: столбец | -1 }; side = -1 — направление по знаку количества (минус — продажа).
   * sideMap: { значение из файла: 'buy' | 'sell' | 'skip' }.
   * Возвращает { trades: [{ ...сделка, row }], errors: [{ row, message }], skipped: [{ row, reason }] }.
   * row — номер строки в файле, начиная с 1 (rows — результат parseCSV).
   */
  function mapRows(rows, headerRow, mapping, sideMap, today) {
    const trades = [];
    const errors = [];
    const skipped = [];
    const missing = FIELDS.filter((f) => f.required && !(mapping[f.key] >= 0)).map((f) => f.label);
    if (!(mapping.price >= 0) && !(mapping.amount >= 0)) missing.push('Цена за 1 шт. или Сумма сделки');
    if (missing.length) return { trades, errors: [{ row: 0, message: 'Не выбраны столбцы: ' + missing.join(', ') }], skipped };

    const cell = (row, key) => (mapping[key] >= 0 && mapping[key] < row.length ? String(row[mapping[key]]).trim() : '');
    for (let r = headerRow + 1; r < rows.length; r++) {
      const row = rows[r];
      const n = row.line || r + 1;
      const rawDate = cell(row, 'date');
      const rawTicker = cell(row, 'ticker');
      // Строки «Итого», подзаголовки разделов и пустые строки отчёта.
      if (!rawTicker && !cellDate(rawDate)) {
        skipped.push({ row: n, reason: 'служебная строка' });
        continue;
      }
      const qtyRaw = cellNum(cell(row, 'qty'));
      let side;
      if (mapping.side >= 0) {
        const v = cell(row, 'side');
        side = sideMap && v in sideMap ? sideMap[v] : guessSide(v);
        if (side === 'skip') {
          skipped.push({ row: n, reason: v ? 'операция «' + v + '»' : 'нет операции' });
          continue;
        }
      } else {
        side = qtyRaw < 0 ? 'sell' : 'buy';
      }
      const qty = Number.isFinite(qtyRaw) ? Math.abs(qtyRaw) : NaN;
      let price = cellNum(cell(row, 'price'));
      if (!(price > 0) && mapping.amount >= 0) {
        const amount = Math.abs(cellNum(cell(row, 'amount')));
        if (amount > 0 && qty > 0) price = Math.round((amount / qty) * 1e6) / 1e6;
      }
      let fee = 0;
      for (const k of ['fee', 'fee2']) {
        const v = cellNum(cell(row, k));
        if (Number.isFinite(v)) fee += Math.abs(v);
      }
      const { trade, errors: errs } = Portfolio.parseTrade(
        {
          date: cellDate(rawDate) || rawDate,
          ticker: rawTicker,
          side,
          qty: Number.isFinite(qty) ? qty : cell(row, 'qty'),
          price: Number.isFinite(price) ? price : cell(row, 'price'),
          fee: Math.round(fee * 100) / 100,
        },
        today
      );
      if (trade) trades.push(Object.assign(trade, { row: n }));
      else errors.push({ row: n, message: Object.values(errs).join('; ') });
    }
    return { trades, errors, skipped };
  }

  // Ключ для запоминания сопоставления: одинаковые заголовки — тот же формат отчёта.
  function headerSignature(header) {
    return header.map(normHeader).join('|');
  }

  // Совпадают ли сделки (для пропуска уже внесённых при повторном импорте).
  function sameTrade(a, b) {
    return a.date === b.date && a.ticker === b.ticker && a.side === b.side && a.qty === b.qty && Math.abs(a.price - b.price) < 1e-9;
  }

  // Сколько сделок из incoming уже есть в existing (с учётом повторов).
  function findDuplicates(existing, incoming) {
    const pool = existing.slice();
    const dup = new Set();
    incoming.forEach((t, i) => {
      const j = pool.findIndex((x) => sameTrade(x, t));
      if (j !== -1) {
        pool.splice(j, 1);
        dup.add(i);
      }
    });
    return dup;
  }

  return {
    toCSV,
    tradesToCSV,
    parseCSV,
    parseTradesCSV,
    text,
    num,
    TRADE_HEADER,
    FIELDS,
    findHeaderRow,
    guessMapping,
    guessSide,
    distinctValues,
    mapRows,
    headerSignature,
    findDuplicates,
  };
});

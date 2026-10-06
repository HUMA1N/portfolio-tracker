/* Интерфейс трекера: состояние, хранение в браузере, отрисовка, обновление цен. */
(function () {
  'use strict';

  const { Fmt, Portfolio, Csv, Moex, Charts, Income } = window;

  const DATA_KEY = 'portfolio-tracker:data:v1';
  const CACHE_KEY = 'portfolio-tracker:cache:v1';
  const THEME_KEY = 'portfolio-tracker:theme';
  const RANGE_KEY = 'portfolio-tracker:range';
  const INCOME_TAB_KEY = 'portfolio-tracker:income-tab';
  const IMPORT_MAP_KEY = 'portfolio-tracker:import-map:v1';
  const EVENTS_TTL = 12 * 36e5;
  const BOARD_TTL = 7 * 864e5;
  const MISS_TTL = 864e5;
  const AUTO_REFRESH_AFTER = 10 * 60e3;
  const MAX_SLICES = 6;
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

  const KIND_TEXT = {
    last: 'цена последней сделки',
    current: 'текущая цена',
    close: 'цена закрытия',
    prevclose: 'закрытие предыдущего дня',
  };

  const $ = (id) => document.getElementById(id);

  // Небольшой конструктор DOM: весь текст вставляется через textContent.
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : String(c));
    }
    return node;
  }

  function plural(n, one, few, many) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b === 1) return one;
    if (b >= 2 && b <= 4) return few;
    return many;
  }

  function tone(v) {
    if (!Number.isFinite(v) || Math.abs(v) < 0.005) return '';
    return v > 0 ? 'pos' : 'neg';
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function localTime(ms) {
    const d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function localDateTime(ms) {
    const d = new Date(ms);
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + ' ' + localTime(ms);
  }

  // «2026-10-06 18:45:12» (время биржи) → «06.10 18:45».
  function issTime(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || ''));
    return m ? m[3] + '.' + m[2] + ' ' + m[4] + ':' + m[5] : '';
  }

  function ddmm(iso) {
    return iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) : '';
  }

  function numToInput(v) {
    return Number.isFinite(v) ? String(v).replace('.', ',') : '';
  }

  /* ---------- Состояние и хранение ---------- */

  // Новые поля добавлены в ту же запись v1: старые данные читаются без изменений.
  function emptyData() {
    return { trades: [], manualPrices: {}, nextSeq: 1, incomeManual: [], incomeExcluded: [], settings: { taxRate: 0.13, benchIncome: false } };
  }

  function emptyCache() {
    return { boards: {}, quotes: {}, history: {}, events: {}, bench: null };
  }

  let data = emptyData();
  let cache = emptyCache();
  const ui = {
    live: new Set(),
    busy: false,
    pendingRefresh: false,
    refreshing: false,
    historyLoading: false,
    lastRefresh: 0,
    status: null,
    range: 'all',
    incomeTab: 'upcoming',
    importState: null,
    showClosed: false,
    filter: '',
    editingId: null,
    storageOk: true,
    priceTicker: null,
    ledger: new Map(),
  };

  function readJSON(key) {
    try {
      const s = localStorage.getItem(key);
      return s ? JSON.parse(s) : null;
    } catch (e) {
      return null;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function newId(seq) {
    return 't' + Date.now().toString(36) + '-' + seq + '-' + Math.random().toString(36).slice(2, 7);
  }

  // Загружает сделки, отбрасывая повреждённые записи.
  function loadData() {
    const raw = readJSON(DATA_KEY);
    const d = emptyData();
    if (raw && Array.isArray(raw.trades)) {
      let maxSeq = 0;
      for (const t of raw.trades) {
        if (!t || typeof t !== 'object') continue;
        const { trade } = Portfolio.parseTrade(t, null);
        if (!trade) continue;
        const seq = Number.isFinite(t.seq) ? t.seq : maxSeq + 1;
        maxSeq = Math.max(maxSeq, seq);
        trade.seq = seq;
        trade.id = typeof t.id === 'string' && t.id ? t.id : newId(seq);
        d.trades.push(trade);
      }
      d.nextSeq = Math.max(maxSeq + 1, Number(raw.nextSeq) || 1);
    }
    if (raw && raw.manualPrices && typeof raw.manualPrices === 'object') {
      for (const [tk, m] of Object.entries(raw.manualPrices)) {
        if (m && Number.isFinite(m.price) && m.price > 0) {
          d.manualPrices[tk] = { price: m.price, date: Fmt.isValidISODate(m.date) ? m.date : null };
        }
      }
    }
    if (raw && Array.isArray(raw.incomeManual)) {
      for (const m of raw.incomeManual) {
        if (!m || typeof m !== 'object') continue;
        const { item } = Income.parseManual(m, null);
        if (item) d.incomeManual.push(Object.assign(item, { id: typeof m.id === 'string' && m.id ? m.id : newId(0) }));
      }
    }
    if (raw && Array.isArray(raw.incomeExcluded)) d.incomeExcluded = raw.incomeExcluded.filter((k) => typeof k === 'string');
    if (raw && raw.settings && typeof raw.settings === 'object') {
      if (Income.TAX_RATES.includes(raw.settings.taxRate)) d.settings.taxRate = raw.settings.taxRate;
      d.settings.benchIncome = raw.settings.benchIncome === true;
    }
    data = d;
  }

  function saveData() {
    ui.storageOk = writeJSON(DATA_KEY, data);
    if (!ui.storageOk) {
      setStatus('warn', 'Не удалось сохранить данные в браузере (хранилище недоступно или переполнено). Сделайте экспорт в CSV.');
    }
  }

  function loadCache() {
    const raw = readJSON(CACHE_KEY);
    const c = emptyCache();
    if (raw && typeof raw === 'object') {
      for (const k of ['boards', 'quotes', 'history', 'events']) {
        if (raw[k] && typeof raw[k] === 'object') c[k] = raw[k];
      }
      if (raw.bench && Array.isArray(raw.bench.closes)) c.bench = raw.bench;
    }
    for (const [tk, hst] of Object.entries(c.history)) {
      if (!hst || !Array.isArray(hst.closes)) delete c.history[tk];
    }
    for (const [tk, ev] of Object.entries(c.events)) {
      if (!ev || !Array.isArray(ev.items) || !['dividend', 'coupon'].includes(ev.kind)) delete c.events[tk];
    }
    cache = c;
  }

  function saveCache() {
    const keep = new Set(data.trades.map((t) => t.ticker));
    for (const k of ['boards', 'quotes', 'history', 'events']) {
      for (const tk of Object.keys(cache[k])) if (!keep.has(tk)) delete cache[k][tk];
    }
    if (!writeJSON(CACHE_KEY, cache)) {
      // История занимает больше всего места: без неё кэш точно поместится.
      writeJSON(CACHE_KEY, { boards: cache.boards, quotes: cache.quotes, history: {}, events: cache.events, bench: null });
    }
  }

  /* ---------- Цены ---------- */

  // Приоритет: ручная цена → котировка MOEX → цена последней сделки.
  function priceInfo(ticker, entry) {
    const m = data.manualPrices[ticker];
    if (m) return { price: m.price, source: 'manual', date: m.date };
    const q = cache.quotes[ticker];
    if (q && q.price > 0 && Moex.isRub(q.currency)) {
      return { price: q.price, source: ui.live.has(ticker) ? 'moex' : 'cached', quote: q };
    }
    return { price: entry.lastTradePrice, source: 'trade', date: entry.lastDate };
  }

  function priceBadge(info) {
    switch (info.source) {
      case 'moex':
        return {
          text: 'MOEX',
          cls: '',
          title:
            'MOEX ISS: ' + (KIND_TEXT[info.quote.kind] || 'котировка') +
            (info.quote.time ? ', ' + issTime(info.quote.time) : '') +
            ' (задержка до 15 минут). Нажмите, чтобы ввести цену вручную.',
        };
      case 'cached':
        return {
          text: 'MOEX · ' + localDateTime(info.quote.fetchedAt),
          cls: 'warn',
          title: 'Сохранённая котировка: сейчас MOEX ISS не ответил. Нажмите, чтобы ввести цену вручную.',
        };
      case 'manual':
        return {
          text: 'вручную' + (info.date ? ' · ' + ddmm(info.date) : ''),
          cls: 'manual',
          title: 'Цена введена вручную. Нажмите, чтобы изменить или вернуть котировку MOEX.',
        };
      default:
        return {
          text: 'цена сделки',
          cls: 'warn',
          title: 'Нет котировки: стоимость оценена по цене последней сделки. Нажмите, чтобы ввести цену.',
        };
    }
  }

  /* ---------- Расчёт представления ---------- */

  function compute() {
    const today = Fmt.todayISO();
    const ledger = Portfolio.buildLedger(data.trades);
    const infos = new Map();
    const prices = new Map();
    for (const e of ledger.values()) {
      const info = priceInfo(e.ticker, e);
      infos.set(e.ticker, info);
      prices.set(e.ticker, info.price);
    }
    const summary = Portfolio.summarize(data.trades, prices);
    const closes = new Map();
    for (const [tk, hst] of Object.entries(cache.history)) closes.set(tk, hst.closes);
    const history = Portfolio.buildHistory(data.trades, closes, today, prices);
    const events = new Map(Object.entries(cache.events));
    const income = Income.build(data.trades, events, {
      today,
      taxRate: data.settings.taxRate,
      excluded: new Set(data.incomeExcluded),
      manual: data.incomeManual,
    });
    ui.ledger = ledger;
    return { today, infos, summary, history, income };
  }

  // До шести долей; цвета закреплены за бумагами в порядке первой покупки.
  function allocationSlices(summary) {
    const open = summary.positions;
    if (!open.length || summary.totals.value <= 0) return [];
    let shown = open;
    let rest = [];
    if (open.length > MAX_SLICES) {
      shown = open.slice(0, MAX_SLICES - 1);
      rest = open.slice(MAX_SLICES - 1);
    }
    const ordered = shown.slice().sort((a, b) => (a.firstDate < b.firstDate ? -1 : a.firstDate > b.firstDate ? 1 : a.ticker < b.ticker ? -1 : 1));
    const slices = ordered.map((p, i) => ({ key: p.ticker, label: p.ticker, value: p.value, share: p.weight, cls: 's' + (i + 1) }));
    if (rest.length) {
      const value = rest.reduce((s, p) => s + p.value, 0);
      slices.push({
        key: '',
        label: 'Прочие (' + rest.length + ')',
        title: rest.map((p) => p.ticker).join(', '),
        value,
        share: value / summary.totals.value,
        cls: 's-other',
      });
    }
    return slices;
  }

  /* ---------- Отрисовка ---------- */

  function renderAll() {
    const vm = compute();
    const slices = allocationSlices(vm.summary);
    const colorOf = new Map(slices.filter((s) => s.key).map((s) => [s.key, s.cls]));
    renderKpis(vm);
    renderPriceWarning(vm);
    renderAllocation(vm, slices);
    renderHistory(vm);
    renderBench(vm);
    renderPositions(vm, colorOf);
    renderIncome(vm);
    renderTrades();
    renderTickerLists();
    renderStatus();
  }

  function kpi(label, value, sub, opts) {
    const o = opts || {};
    return h(
      'div',
      { class: 'kpi' + (o.hero ? ' hero' : '') },
      h('div', { class: 'kpi-label', text: label }),
      h('div', { class: 'kpi-value ' + (o.tone || ''), text: value }),
      sub ? h('div', { class: 'kpi-sub ' + (o.subTone || ''), text: sub }) : null
    );
  }

  function renderKpis(vm) {
    const t = vm.summary.totals;
    const box = $('kpis');
    if (!data.trades.length) {
      box.replaceChildren(
        kpi('Текущая стоимость', '—', 'Добавьте первую сделку — форма ниже', { hero: true }),
        kpi('Прибыль/убыток всего', '—', 'с учётом продаж и комиссий'),
        kpi('Нереализованная', '—', 'по открытым позициям'),
        kpi('Реализованная', '—', 'по проданным бумагам'),
        kpi('Дивиденды и купоны', '—', 'получено после налога')
      );
      return;
    }
    const inc = vm.income.totals;
    const withIncome = t.totalPnl + inc.receivedNet;
    const n = t.openCount;
    box.replaceChildren(
      kpi(
        'Текущая стоимость',
        Fmt.money(t.value),
        n + ' ' + plural(n, 'бумага', 'бумаги', 'бумаг') + ' · себестоимость ' + Fmt.money(t.cost, { digits: 0 }) + ' · комиссии за всё время ' + Fmt.money(t.fees),
        { hero: true }
      ),
      kpi('Прибыль/убыток всего', Fmt.money(t.totalPnl, { sign: true }), Fmt.pct(t.totalPnlPct) + ' к сумме покупок', {
        tone: tone(t.totalPnl),
      }),
      kpi('Нереализованная', Fmt.money(t.unrealized, { sign: true }), Number.isFinite(t.unrealizedPct) ? Fmt.pct(t.unrealizedPct) + ' к себестоимости' : 'нет открытых позиций', {
        tone: tone(t.unrealized),
      }),
      kpi('Реализованная', Fmt.money(t.realized, { sign: true }), 'по проданным бумагам', { tone: tone(t.realized) }),
      kpi(
        'Дивиденды и купоны',
        Fmt.money(inc.receivedNet),
        'получено после налога · итог с выплатами ' + Fmt.money(withIncome, { sign: true, digits: 0 }) +
          (t.buyCost > 0 ? ' (' + Fmt.pct(withIncome / t.buyCost) + ')' : ''),
        { tone: inc.receivedNet > 0 ? 'pos' : '' }
      )
    );
  }

  function renderPriceWarning(vm) {
    const box = $('price-warning');
    const list = vm.summary.positions.filter((p) => vm.infos.get(p.ticker).source === 'trade');
    if (!list.length || ui.refreshing) {
      box.hidden = true;
      return;
    }
    const reason = (tk) => {
      const b = cache.boards[tk];
      if (b && b.status === 'notfound') return ' (нет на MOEX)';
      if (b && b.status === 'unsupported') return ' (не рынок акций MOEX)';
      return '';
    };
    box.replaceChildren(
      h('b', { text: 'Нет текущей цены. ' }),
      'Стоимость ' + list.map((p) => p.ticker + reason(p.ticker)).join(', ') + ' оценена по цене последней сделки. Укажите цену вручную:',
      h('div', null, list.map((p) => h('button', { type: 'button', class: 'btn small', onclick: () => openPriceDialog(p.ticker), text: 'Цена ' + p.ticker })))
    );
    box.hidden = false;
  }

  function renderAllocation(vm, slices) {
    const box = $('donut');
    const legend = $('donut-legend');
    if (!slices.length) {
      box.replaceChildren(h('div', { class: 'chart-empty', text: data.trades.length ? 'Нет открытых позиций' : 'Здесь появятся доли бумаг' }));
      legend.replaceChildren();
      return;
    }
    const t = vm.summary.totals;
    Charts.renderDonut(box, slices, {
      title: Fmt.compactMoney(t.value),
      sub: t.openCount + ' ' + plural(t.openCount, 'бумага', 'бумаги', 'бумаг'),
    });
    legend.replaceChildren(
      ...slices.map((s) =>
        h(
          'li',
          { title: s.title || null },
          h('span', { class: 'key ' + s.cls }),
          h('span', { class: 'name', text: s.label }),
          h('span', { class: 'share', text: Fmt.pct(s.share, { sign: false, digits: 1 }) }),
          h('span', { class: 'val', text: Fmt.money(s.value, { digits: 0 }) })
        )
      )
    );
  }

  function renderHistory(vm) {
    const box = $('history-chart');
    const pts = vm.history.points;
    const sub = $('history-sub');
    const note = $('history-note');
    const table = $('history-table');
    document.querySelectorAll('button[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === ui.range)));

    $('history-legend').hidden = !pts.length;
    $('history-table-details').hidden = !pts.length;
    $('range').hidden = !pts.length;
    if (!pts.length) {
      box.__chart = null;
      box.replaceChildren(h('div', { class: 'chart-empty', text: 'График появится после первой сделки' }));
      sub.textContent = '';
      note.textContent = '';
      table.replaceChildren();
      return;
    }

    const from = ui.range === 'all' ? null : Fmt.addMonths(vm.today, -Number(ui.range));
    let view = from ? pts.filter((p) => p.date >= from) : pts;
    if (!view.length) view = pts.slice(-1);

    Charts.renderLineChart(box, {
      points: view,
      series: [
        { key: 'value', label: 'стоимость', cls: 's-value' },
        { key: 'invested', label: 'чистые вложения', cls: 's-invested', step: true },
      ],
      tipExtra: (p) => {
        const pnl = p.value - p.invested;
        return [{ value: Fmt.money(pnl, { sign: true, digits: 0 }), label: 'прибыль/убыток', tone: tone(pnl) }];
      },
      ariaLabel:
        'График стоимости портфеля с ' + Fmt.date(view[0].date) + ' по ' + Fmt.date(view[view.length - 1].date) +
        '. Стрелки влево и вправо перемещают по датам.',
    });

    const a = view[0];
    const b = view[view.length - 1];
    const periodPnl = b.value - b.invested - (from && view.length > 1 ? a.value - a.invested : 0);
    sub.replaceChildren(
      'Прибыль/убыток ' + (from ? 'за период' : 'за всё время') + ': ',
      h('span', { class: tone(periodPnl), text: Fmt.money(periodPnl, { sign: true }) })
    );

    if (ui.historyLoading) {
      note.textContent = 'Загружаю историю котировок MOEX…';
    } else {
      const approx = [...vm.history.approximated].filter((tk) => data.trades.some((t) => t.ticker === tk));
      note.textContent = approx.length
        ? 'Нет истории котировок MOEX для ' + approx.join(', ') + ' — между сделками стоимость этих бумаг считается по ценам сделок.'
        : 'Стоимость на дату — по ценам закрытия MOEX; сегодня — по текущим ценам.';
    }

    // Табличное представление: конец каждого месяца и последний день.
    const rows = view.filter((p, i) => i === view.length - 1 || view[i + 1].date.slice(0, 7) !== p.date.slice(0, 7)).reverse();
    table.replaceChildren(
      h('thead', null, h('tr', null, h('th', { text: 'Дата' }), h('th', { text: 'Стоимость' }), h('th', { text: 'Чистые вложения' }), h('th', { text: 'Прибыль/убыток' }))),
      h(
        'tbody',
        null,
        rows.map((p) => {
          const pnl = p.value - p.invested;
          return h(
            'tr',
            null,
            h('td', { text: Fmt.date(p.date) }),
            h('td', { text: Fmt.money(p.value) }),
            h('td', { text: Fmt.money(p.invested) }),
            h('td', { class: tone(pnl), text: Fmt.money(pnl, { sign: true }) })
          );
        })
      )
    );
  }

  // Разница доходностей — в процентных пунктах.
  function pp(v) {
    return Fmt.pct(v).replace(/\s%$/, ' п. п.');
  }

  function pctAxis(v, step) {
    const digits = step >= 0.01 - 1e-12 ? 0 : step >= 0.001 - 1e-12 ? 1 : 2;
    return Fmt.pct(v, { digits, sign: v !== 0 });
  }

  function renderBench(vm) {
    const box = $('bench-chart');
    const sub = $('bench-sub');
    const note = $('bench-note');
    const pts = vm.history.points;
    $('bench-income').checked = data.settings.benchIncome;
    const empty = (text) => {
      box.__chart = null;
      box.replaceChildren(h('div', { class: 'chart-empty', text }));
      sub.textContent = '';
      $('bench-tools').hidden = !pts.length;
      $('bench-range').hidden = !pts.length;
    };
    if (!pts.length) {
      empty('График появится после первой сделки');
      note.textContent = '';
      return;
    }
    const closes = cache.bench && cache.bench.closes;
    const from = ui.range === 'all' ? null : Fmt.addMonths(vm.today, -Number(ui.range));
    const income = data.settings.benchIncome ? Income.cashByDate(vm.income) : null;
    const cmp = closes && closes.length ? Portfolio.compareWithBenchmark(pts, closes, from, income) : null;
    if (!cmp || cmp.points.length < 2) {
      empty(ui.refreshing || ui.historyLoading ? 'Загружаю значения индекса IMOEX…' : cmp ? 'Слишком короткий период для сравнения' : 'Нет данных индекса IMOEX — MOEX ISS недоступен. Нажмите «Обновить цены».');
      note.textContent = '';
      return;
    }
    $('bench-tools').hidden = false;
    $('bench-range').hidden = false;
    Charts.renderLineChart(box, {
      points: cmp.points,
      series: [
        { key: 'portfolio', label: 'портфель', cls: 's-value' },
        { key: 'bench', label: 'IMOEX', cls: 's-bench' },
      ],
      includeZero: true,
      axisFormat: pctAxis,
      valueFormat: (v) => Fmt.pct(v),
      valueTone: tone,
      tipExtra: (p) => {
        const diff = p.portfolio - p.bench;
        return [{ value: pp(diff), label: 'разница', tone: tone(diff) }];
      },
      ariaLabel:
        'Доходность портфеля и индекса IMOEX с ' + Fmt.date(cmp.points[0].date) + ' по ' + Fmt.date(cmp.points[cmp.points.length - 1].date) +
        '. Стрелки влево и вправо перемещают по датам.',
    });
    const diff = cmp.portfolio - cmp.bench;
    sub.replaceChildren(
      'С ' + Fmt.date(cmp.points[0].date) + ': портфель ',
      h('span', { class: tone(cmp.portfolio), text: Fmt.pct(cmp.portfolio) }),
      ', IMOEX ',
      h('span', { class: tone(cmp.bench), text: Fmt.pct(cmp.bench) }),
      ', разница ',
      h('span', { class: tone(diff), text: pp(diff) })
    );
    const approx = [...vm.history.approximated].filter((tk) => data.trades.some((t) => t.ticker === tk));
    note.textContent =
      'Доходность портфеля не зависит от пополнений и выводов. IMOEX — ценовой индекс без дивидендов' +
      (data.settings.benchIncome ? '; в доходность портфеля включены полученные дивиденды и купоны.' : '.') +
      (approx.length ? ' Для ' + approx.join(', ') + ' нет истории котировок — между сделками используются их цены.' : '');
  }

  function moneyWithPct(v, ratio) {
    const frag = [h('span', { class: tone(v), text: Fmt.money(v, { sign: true }) })];
    if (Number.isFinite(ratio)) frag.push(h('span', { class: 'sub ' + tone(v), text: Fmt.pct(ratio) }));
    return frag;
  }

  function renderPositions(vm, colorOf) {
    const table = $('positions');
    const { positions, closed, totals } = vm.summary;
    const head = h(
      'thead',
      null,
      h(
        'tr',
        null,
        ['Бумага', 'Кол-во', 'Средняя цена', 'Текущая цена', 'Стоимость', 'Доля', 'Нереализованная прибыль/убыток', 'Реализованная', 'Выплаты после налога', 'Итого прибыль/убыток'].map((t) =>
          h('th', { scope: 'col', text: t })
        )
      )
    );

    const nameCell = (p) => {
      const q = cache.quotes[p.ticker];
      const b = cache.boards[p.ticker];
      const cls = colorOf.get(p.ticker);
      return h(
        'td',
        null,
        cls ? h('span', { class: 'swatch ' + cls, 'aria-hidden': 'true' }) : null,
        h('span', { class: 'ticker', text: p.ticker }),
        b && b.status === 'notfound' ? h('span', { class: 'tag', text: 'нет на MOEX' }) : null,
        b && b.status === 'unsupported' ? h('span', { class: 'tag', text: 'не акция' }) : null,
        q && q.name ? h('span', { class: 'name', text: q.name }) : null
      );
    };

    const paid = vm.income.byTicker;
    const paidCell = (tk) => {
      const v = paid.get(tk) || 0;
      return h('td', { class: tone(v), text: v > 0 ? Fmt.money(v, { sign: true }) : '—' });
    };
    const body = h('tbody');
    if (!positions.length && !(ui.showClosed && closed.length)) {
      body.append(
        h('tr', { class: 'empty-row' }, h('td', { colspan: 10, text: data.trades.length ? 'Открытых позиций нет.' : 'Позиций пока нет — добавьте сделку в форме ниже.' }))
      );
    }
    for (const p of positions) {
      const info = vm.infos.get(p.ticker);
      const badge = priceBadge(info);
      body.append(
        h(
          'tr',
          null,
          nameCell(p),
          h('td', { text: Fmt.qty(p.qty) }),
          h('td', { text: Fmt.price(p.avgPrice) }),
          h(
            'td',
            null,
            h(
              'span',
              { class: 'price-cell' },
              h('span', { text: Fmt.price(p.price) }),
              h('button', { type: 'button', class: 'badge ' + badge.cls, title: badge.title, 'aria-label': 'Цена ' + p.ticker + ': ' + badge.text + '. Изменить', onclick: () => openPriceDialog(p.ticker), text: badge.text })
            )
          ),
          h('td', { text: Fmt.money(p.value) }),
          h('td', { text: Fmt.pct(p.weight, { sign: false, digits: 1 }) }),
          h('td', null, moneyWithPct(p.unrealized, p.unrealizedPct)),
          h('td', { class: tone(p.realized), text: Math.abs(p.realized) < 0.005 ? '—' : Fmt.money(p.realized, { sign: true }) }),
          paidCell(p.ticker),
          h('td', null, moneyWithPct(p.totalPnl, p.totalPnlPct))
        )
      );
    }
    if (ui.showClosed) {
      for (const p of closed) {
        body.append(
          h(
            'tr',
            { class: 'closed' },
            h('td', null, h('span', { class: 'ticker', text: p.ticker }), h('span', { class: 'name', text: 'закрыта ' + Fmt.date(p.lastDate) })),
            h('td', { text: '0' }),
            h('td', { text: '—' }),
            h('td', { text: '—' }),
            h('td', { text: '—' }),
            h('td', { text: '—' }),
            h('td', { text: '—' }),
            h('td', { class: tone(p.realized), text: Fmt.money(p.realized, { sign: true }) }),
            paidCell(p.ticker),
            h('td', null, moneyWithPct(p.totalPnl, p.totalPnlPct))
          )
        );
      }
    }

    let foot = null;
    if (data.trades.length) {
      foot = h(
        'tfoot',
        null,
        h(
          'tr',
          null,
          h('td', { text: 'Итого' }),
          h('td'),
          h('td'),
          h('td'),
          h('td', { text: Fmt.money(totals.value) }),
          h('td', { text: totals.value > 0 ? '100 %' : '—' }),
          h('td', null, moneyWithPct(totals.unrealized, totals.unrealizedPct)),
          h('td', { class: tone(totals.realized), text: Fmt.money(totals.realized, { sign: true }) }),
          h('td', { class: tone(vm.income.totals.receivedNet), text: Fmt.money(vm.income.totals.receivedNet, { sign: true }) }),
          h('td', null, moneyWithPct(totals.totalPnl, totals.totalPnlPct))
        )
      );
    }
    table.replaceChildren(head, body);
    if (foot) table.append(foot);
    $('show-closed').parentElement.hidden = !closed.length;
  }

  const MONTHS_FULL = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

  function monthTitle(iso) {
    const m = MONTHS_FULL[+iso.slice(5, 7) - 1];
    return m[0].toUpperCase() + m.slice(1) + ' ' + iso.slice(0, 4);
  }

  function kindPill(it) {
    return h('span', { class: 'kind-pill' + (it.source === 'manual' ? ' manual' : ''), title: it.source === 'manual' ? 'Внесено вручную' : 'По данным MOEX ISS', text: Income.KIND_LABEL[it.kind] + (it.source === 'manual' ? ' · вручную' : '') });
  }

  function payDateCell(it) {
    return h('td', { title: it.payEstimated ? 'Биржа не публикует дату выплаты дивидендов: оценка — 10 рабочих дней после даты реестра' : null }, it.payEstimated ? h('span', { class: 'est', text: '≈ ' + Fmt.date(it.payDate) }) : Fmt.date(it.payDate));
  }

  function renderIncome(vm) {
    const table = $('income-table');
    const inc = vm.income;
    const tab = ui.incomeTab;
    document.querySelectorAll('#income-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    $('tax-rate').value = String(data.settings.taxRate);
    const tz = inc.totals;
    const subParts = ['Получено после налога: ' + Fmt.money(tz.receivedNet)];
    if (tz.receivedNet > 0) subParts.push('дивиденды ' + Fmt.money(tz.dividends, { digits: 0 }) + ', купоны ' + Fmt.money(tz.coupons, { digits: 0 }));
    subParts.push('ожидается за 12 месяцев: ' + Fmt.money(tz.expectedNet) + (tz.expectedUnknown ? ' + ' + tz.expectedUnknown + ' ' + plural(tz.expectedUnknown, 'выплата', 'выплаты', 'выплат') + ' без объявленного размера' : ''));
    $('income-sub').textContent = data.trades.length || data.incomeManual.length ? subParts.join(' · ') : '';

    const body = h('tbody');
    let head;
    const taxLabel = data.settings.taxRate ? 'После налога ' + Math.round(data.settings.taxRate * 100) + ' %' : 'К зачислению';
    if (tab === 'upcoming') {
      head = h('thead', null, h('tr', null, ['Дата выплаты', 'Бумага', 'Вид', 'Дата реестра', 'На 1 шт.', 'Кол-во', 'Сумма до налога', taxLabel].map((t, i) => h('th', { scope: 'col', class: i === 1 || i === 2 ? 'left' : null, text: t }))));
      const list = inc.upcoming;
      if (!list.length) {
        body.append(h('tr', { class: 'empty-row' }, h('td', { colspan: 8, text: data.trades.length ? (ui.refreshing || ui.historyLoading ? 'Загружаю календарь выплат MOEX…' : 'Объявленных выплат по бумагам портфеля пока нет.') : 'Здесь появятся будущие дивиденды и купоны по вашим бумагам.' })));
      }
      let month = '';
      for (const it of list) {
        const m = it.payDate.slice(0, 7);
        if (m !== month) {
          month = m;
          const inMonth = list.filter((x) => x.payDate.slice(0, 7) === m);
          const known = inMonth.filter((x) => x.net != null);
          const sum = known.reduce((a, x) => a + x.net, 0);
          const sumText = !known.length ? 'размер не объявлен' : 'ожидается ' + Fmt.money(sum) + (known.length < inMonth.length ? ' + не объявленные' : '');
          body.append(h('tr', { class: 'month' }, h('td', { colspan: 8 }, monthTitle(it.payDate), h('span', { class: 'month-sum', text: sumText }))));
        }
        body.append(
          h(
            'tr',
            null,
            payDateCell(it),
            h('td', { class: 'left' }, h('span', { class: 'ticker', text: it.ticker })),
            h('td', { class: 'left' }, kindPill(it)),
            h('td', { text: it.recordDate ? Fmt.date(it.recordDate) : '—' }),
            h('td', { text: it.perUnit != null ? Fmt.price(it.perUnit) : 'не объявлен' }),
            h('td', { text: it.qty != null ? Fmt.qty(it.qty) : '—' }),
            h('td', { text: it.gross != null ? Fmt.money(it.gross) : '—' }),
            h('td', { text: it.net != null ? Fmt.money(it.net) : '—' })
          )
        );
      }
    } else {
      head = h('thead', null, h('tr', null, ['Дата выплаты', 'Бумага', 'Вид', 'На 1 шт.', 'Кол-во', 'До налога', 'Налог', 'Получено', ''].map((t, i) => h('th', { scope: 'col', class: i === 1 || i === 2 ? 'left' : null, text: t }))));
      const list = inc.received;
      if (!list.length) {
        body.append(h('tr', { class: 'empty-row' }, h('td', { colspan: 9, text: data.trades.length ? 'Выплат по вашим бумагам пока не было.' : 'Здесь появятся полученные дивиденды и купоны.' })));
      }
      for (const it of list) {
        let action;
        if (it.source === 'manual') {
          action = h('button', { type: 'button', class: 'btn small', onclick: () => deleteManualIncome(it.id), 'aria-label': 'Удалить выплату ' + it.ticker + ' от ' + Fmt.date(it.payDate), text: 'Удалить' });
        } else {
          action = h('button', {
            type: 'button',
            class: 'btn small',
            title: it.excluded ? 'Снова учитывать эту выплату' : 'Не учитывать (например, если брокер зачислил другую сумму — её можно добавить вручную)',
            onclick: () => toggleIncome(it.key),
            text: it.excluded ? 'Учитывать' : 'Не учитывать',
          });
        }
        body.append(
          h(
            'tr',
            { class: it.excluded ? 'excluded' : null, title: it.note || null },
            payDateCell(it),
            h('td', { class: 'left' }, h('span', { class: 'ticker', text: it.ticker }), it.note ? h('span', { class: 'name', text: it.note }) : null),
            h('td', { class: 'left' }, kindPill(it)),
            h('td', { text: it.perUnit != null ? Fmt.price(it.perUnit) : '—' }),
            h('td', { text: it.qty != null ? Fmt.qty(it.qty) : '—' }),
            h('td', { text: it.gross != null ? Fmt.money(it.gross) : it.source === 'manual' ? '—' : 'не известно' }),
            h('td', { text: it.tax != null ? Fmt.money(it.tax) : '—' }),
            h('td', { class: it.net != null && !it.excluded ? 'pos' : '', text: it.net != null ? Fmt.money(it.net) : '—' }),
            h('td', { class: 'actions' }, action)
          )
        );
      }
    }
    table.replaceChildren(head, body);

    const noData = [...new Set(data.trades.map((t) => t.ticker))].filter((tk) => {
      const b = cache.boards[tk];
      return b && (b.status === 'notfound' || (b.status === 'unsupported' && b.market !== 'bonds'));
    });
    const parts = [];
    if (tab === 'upcoming') parts.push('Календарь — по объявленным биржей выплатам и текущему количеству бумаг. Даты выплат дивидендов со знаком ≈ — оценка.');
    if (noData.length) parts.push('Нет данных о выплатах MOEX для ' + noData.join(', ') + ' — такие выплаты можно добавить вручную.');
    $('income-note').textContent = parts.join(' ');
  }

  function toggleIncome(key) {
    const set = new Set(data.incomeExcluded);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    data.incomeExcluded = [...set];
    saveData();
    renderAll();
  }

  function deleteManualIncome(id) {
    const m = data.incomeManual.find((x) => x.id === id);
    if (!m) return;
    if (!window.confirm('Удалить выплату ' + m.ticker + ' от ' + Fmt.date(m.date) + ' на ' + Fmt.money(m.amount) + '?')) return;
    data.incomeManual = data.incomeManual.filter((x) => x.id !== id);
    saveData();
    renderAll();
  }

  const incomeForm = $('income-form');

  function openIncomeDialog() {
    incomeForm.reset();
    incomeForm.date.value = Fmt.todayISO();
    incomeForm.date.max = Fmt.todayISO();
    incomeForm.querySelectorAll('.field-error').forEach((e) => (e.textContent = ''));
    incomeForm.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
    $('income-dialog').showModal();
    incomeForm.ticker.focus();
  }

  function saveManualIncome(e) {
    e.preventDefault();
    incomeForm.querySelectorAll('.field-error').forEach((x) => (x.textContent = ''));
    incomeForm.querySelectorAll('[aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
    const raw = {
      ticker: incomeForm.ticker.value,
      date: incomeForm.date.value,
      kind: incomeForm.kind.value,
      amount: incomeForm.amount.value,
      note: incomeForm.note.value,
    };
    const { item, errors } = Income.parseManual(raw, Fmt.todayISO());
    if (!item) {
      let first = null;
      for (const [field, msg] of Object.entries(errors)) {
        const slot = incomeForm.querySelector('.field-error[data-for="' + field + '"]');
        if (slot) slot.textContent = msg;
        const input = incomeForm.elements[field];
        if (input && input.setAttribute) {
          input.setAttribute('aria-invalid', 'true');
          first = first || input;
        }
      }
      if (first && first.focus) first.focus();
      return;
    }
    data.incomeManual.push(Object.assign(item, { id: newId(data.incomeManual.length + 1) }));
    saveData();
    $('income-dialog').close();
    ui.incomeTab = 'received';
    renderAll();
    if (ui.storageOk) setStatus('ok', 'Выплата добавлена: ' + item.ticker + ', ' + Fmt.money(item.amount));
  }

  function renderTrades() {
    const table = $('trades');
    const list = Portfolio.sortTrades(data.trades)
      .reverse()
      .filter((t) => !ui.filter || t.ticker === ui.filter);
    const head = h(
      'thead',
      null,
      h(
        'tr',
        null,
        ['Дата', 'Бумага', 'Операция', 'Кол-во', 'Цена', 'Комиссия', 'Сумма', ''].map((t, i) =>
          h('th', { scope: 'col', class: i === 1 || i === 2 ? 'left' : null, text: t })
        )
      )
    );
    const body = h('tbody');
    if (!list.length) {
      body.append(h('tr', { class: 'empty-row' }, h('td', { colspan: 8, text: 'Сделок пока нет.' })));
    }
    for (const t of list) {
      body.append(
        h(
          'tr',
          null,
          h('td', { text: Fmt.date(t.date) }),
          h('td', { class: 'left' }, h('span', { class: 'ticker', text: t.ticker })),
          h('td', { class: 'left' }, h('span', { class: 'side-pill', text: t.side === 'buy' ? 'Покупка' : 'Продажа' })),
          h('td', { text: Fmt.qty(t.qty) }),
          h('td', { text: Fmt.price(t.price) }),
          h('td', { text: Fmt.money(t.fee) }),
          h('td', { text: Fmt.money(t.qty * t.price) }),
          h(
            'td',
            { class: 'actions' },
            h('button', { type: 'button', class: 'btn small', onclick: () => startEdit(t.id), 'aria-label': 'Изменить сделку ' + t.ticker + ' от ' + Fmt.date(t.date), text: 'Изменить' }),
            h('button', { type: 'button', class: 'btn small', onclick: () => deleteTrade(t.id), 'aria-label': 'Удалить сделку ' + t.ticker + ' от ' + Fmt.date(t.date), text: 'Удалить' })
          )
        )
      );
    }
    table.replaceChildren(head, body);
  }

  function renderTickerLists() {
    const tickers = [...new Set(data.trades.map((t) => t.ticker))].sort();
    $('ticker-list').replaceChildren(...tickers.map((t) => h('option', { value: t })));
    const sel = $('trade-filter');
    if (ui.filter && !tickers.includes(ui.filter)) ui.filter = '';
    sel.replaceChildren(h('option', { value: '', text: 'все' }), ...tickers.map((t) => h('option', { value: t, text: t })));
    sel.value = ui.filter;
  }

  function setStatus(kind, text) {
    ui.status = kind ? { kind, text } : null;
    renderStatus();
  }

  function renderStatus() {
    const box = $('status');
    const s = ui.status;
    if (!s) {
      box.replaceChildren();
      return;
    }
    const dotCls = s.kind === 'busy' ? 'dot busy' : s.kind === 'ok' ? 'dot ok' : s.kind === 'warn' ? 'dot warn' : 'dot';
    box.replaceChildren(h('span', { class: dotCls, 'aria-hidden': 'true' }), h('span', { class: s.kind === 'warn' ? 'err' : '', text: s.text }));
  }

  /* ---------- Обновление цен с MOEX ---------- */

  async function pool(items, size, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    });
    await Promise.all(workers);
  }

  async function refreshPrices() {
    // Запрос во время обновления не теряем: повторим, когда текущее закончится.
    if (ui.busy) {
      ui.pendingRefresh = true;
      return;
    }
    const tickers = [...new Set(data.trades.map((t) => t.ticker))];
    if (!tickers.length) return;
    ui.busy = true;
    ui.pendingRefresh = false;
    ui.refreshing = true;
    $('refresh-btn').disabled = true;
    setStatus('busy', 'Обновляю котировки MOEX…');

    let down = null;
    const call = async (fn) => {
      if (down) return null;
      try {
        return await fn();
      } catch (e) {
        if (e && e.network) down = down || e;
        return null;
      }
    };
    const now = Date.now();
    const today = Fmt.todayISO();

    try {
      // 1. Режим торгов каждой бумаги (кэшируется на неделю).
      const toResolve = tickers.filter((tk) => {
        const b = cache.boards[tk];
        if (!b) return true;
        return now - (b.checkedAt || 0) > (b.status === 'ok' ? BOARD_TTL : MISS_TTL);
      });
      await pool(toResolve, 4, async (tk) => {
        const res = await call(() => Moex.resolveBoard(tk));
        if (res) cache.boards[tk] = Object.assign(res, { checkedAt: Date.now() });
      });

      // 2. Текущие цены открытых позиций, по режимам торгов.
      const open = [...ui.ledger.values()].filter((e) => e.qty > 0).map((e) => e.ticker);
      const byBoard = new Map();
      for (const tk of open) {
        const b = cache.boards[tk];
        if (b && b.status === 'ok') byBoard.set(b.board, (byBoard.get(b.board) || []).concat(tk));
      }
      await pool([...byBoard.entries()], 3, async ([board, list]) => {
        const quotes = await call(() => Moex.fetchQuotes(board, list));
        if (!quotes) return;
        for (const [tk, q] of Object.entries(quotes)) {
          cache.quotes[tk] = Object.assign(q, { board, fetchedAt: Date.now() });
          ui.live.add(tk);
        }
      });
      saveCache();
      ui.refreshing = false;
      ui.historyLoading = !down;
      renderAll();

      // 3. История цен закрытия — только недостающий кусок.
      if (!down) {
        const firstDate = new Map();
        for (const t of Portfolio.sortTrades(data.trades)) if (!firstDate.has(t.ticker)) firstDate.set(t.ticker, t.date);
        const jobs = tickers.filter((tk) => cache.boards[tk] && cache.boards[tk].status === 'ok');
        await pool(jobs, 3, async (tk) => {
          const board = cache.boards[tk].board;
          const need = firstDate.get(tk);
          const hst = cache.history[tk];
          if (!hst || hst.board !== board || hst.from > need) {
            const closes = await call(() => Moex.fetchCloses(board, tk, need, today));
            if (closes) cache.history[tk] = { board, from: need, till: today, closes };
          } else if (hst.till < today) {
            const lastDate = hst.closes.length ? hst.closes[hst.closes.length - 1][0] : hst.from;
            const fresh = await call(() => Moex.fetchCloses(board, tk, lastDate, today));
            if (fresh) {
              const merged = new Map(hst.closes);
              for (const [d, c] of fresh) merged.set(d, c);
              hst.closes = [...merged.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
              hst.till = today;
            }
          }
        });
        saveCache();
      }

      // 4. Дивиденды и купоны (обновляются раз в 12 часов) и значения индекса IMOEX.
      if (!down) {
        const evJobs = tickers.filter((tk) => {
          const b = cache.boards[tk];
          if (!b || !(b.status === 'ok' || (b.status === 'unsupported' && b.market === 'bonds'))) return false;
          const ev = cache.events[tk];
          return !ev || now - (ev.fetchedAt || 0) > EVENTS_TTL;
        });
        await pool(evJobs, 3, async (tk) => {
          const kind = cache.boards[tk].status === 'ok' ? 'dividend' : 'coupon';
          const items = await call(() => (kind === 'dividend' ? Moex.fetchDividends(tk) : Moex.fetchCoupons(tk)));
          if (items) cache.events[tk] = { kind, items, fetchedAt: Date.now() };
        });

        // Индекс — с запасом в неделю до первой сделки, чтобы было значение на её дату.
        const need = Fmt.addDays(Portfolio.sortTrades(data.trades)[0].date, -7);
        const bc = cache.bench;
        if (!bc || bc.from > need) {
          const closes = await call(() => Moex.fetchIndexCloses(need, today));
          if (closes) cache.bench = { from: need, till: today, closes };
        } else {
          // Последний день перезапрашиваем: во время торгов его значение меняется.
          const lastDate = bc.closes.length ? bc.closes[bc.closes.length - 1][0] : bc.from;
          const fresh = await call(() => Moex.fetchIndexCloses(lastDate, today));
          if (fresh) {
            const merged = new Map(bc.closes);
            for (const [d, c] of fresh) merged.set(d, c);
            bc.closes = [...merged.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
            bc.till = today;
          }
        }
        saveCache();
      }
    } finally {
      ui.busy = false;
      ui.refreshing = false;
      ui.historyLoading = false;
      ui.lastRefresh = Date.now();
      $('refresh-btn').disabled = false;
    }

    const missing = tickers.filter((tk) => cache.boards[tk] && cache.boards[tk].status !== 'ok' && !data.manualPrices[tk] && ui.ledger.get(tk) && ui.ledger.get(tk).qty > 0);
    if (down) {
      setStatus('warn', 'MOEX ISS недоступен (' + down.message + '). Используются сохранённые котировки и цены, введённые вручную.');
    } else {
      let text = 'Котировки MOEX ISS обновлены в ' + localTime(Date.now()) + ' · задержка до 15 минут';
      if (missing.length) text += ' · Не найдены на рынке акций MOEX: ' + missing.join(', ') + ' — укажите цену вручную';
      setStatus(missing.length ? 'warn' : 'ok', text);
    }
    renderAll();
    if (ui.pendingRefresh) refreshPrices();
  }

  /* ---------- Форма сделки ---------- */

  const form = $('trade-form');

  function readForm() {
    return {
      ticker: form.ticker.value,
      date: form.date.value,
      side: form.side.value,
      qty: form.qty.value,
      price: form.price.value,
      fee: form.fee.value,
    };
  }

  function clearFormErrors() {
    form.querySelectorAll('.field-error').forEach((e) => (e.textContent = ''));
    form.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
    $('form-error').textContent = '';
  }

  function showFormErrors(errors) {
    let first = null;
    for (const [field, msg] of Object.entries(errors)) {
      const slot = form.querySelector('.field-error[data-for="' + field + '"]');
      if (slot) slot.textContent = msg;
      const input = form.elements[field];
      if (input && input.setAttribute) {
        input.setAttribute('aria-invalid', 'true');
        first = first || input;
      }
    }
    if (first) first.focus();
  }

  function heldOn(ticker, date, excludeId) {
    let q = 0;
    for (const t of data.trades) {
      if (t.ticker !== ticker || t.id === excludeId || t.date > date) continue;
      q += t.side === 'buy' ? t.qty : -t.qty;
    }
    return q;
  }

  function updateFormSummary() {
    const raw = readForm();
    const out = $('form-summary');
    const qty = Fmt.parseNumber(raw.qty);
    const price = Fmt.parseNumber(raw.price);
    if (!(qty > 0 && price > 0)) {
      out.textContent = '';
      return;
    }
    const { trade } = Portfolio.parseTrade(Object.assign({}, raw, { ticker: raw.ticker || 'X', date: raw.date || Fmt.todayISO() }), null);
    const gross = qty * price;
    const fee = trade ? trade.fee : 0;
    const parts = ['Сумма ' + Fmt.money(gross), 'комиссия ' + Fmt.money(fee)];
    parts.push((raw.side === 'sell' ? 'к получению ' + Fmt.money(gross - fee) : 'к оплате ' + Fmt.money(gross + fee)));
    const tk = Portfolio.normalizeTicker(raw.ticker);
    if (raw.side === 'sell' && tk && Fmt.parseDate(raw.date)) {
      parts.push('в портфеле на эту дату ' + Fmt.qty(heldOn(tk, Fmt.parseDate(raw.date), ui.editingId)) + ' шт.');
    }
    out.textContent = parts.join(' · ');
  }

  function resetForm() {
    const date = form.date.value;
    form.reset();
    form.date.value = date || Fmt.todayISO();
    form.date.max = Fmt.todayISO();
    clearFormErrors();
    updateFormSummary();
  }

  function oversellText(over, prefix) {
    const t = over.trade;
    return (
      (prefix || '') +
      'продажа ' + Fmt.qty(t.qty) + ' шт. ' + t.ticker + ' от ' + Fmt.date(t.date) +
      ' больше позиции на эту дату (' + Fmt.qty(Math.max(0, over.have)) + ' шт.).'
    );
  }

  function onSubmit(e) {
    e.preventDefault();
    clearFormErrors();
    const { trade, errors } = Portfolio.parseTrade(readForm(), Fmt.todayISO());
    if (!trade) {
      showFormErrors(errors);
      return;
    }
    const editing = ui.editingId;
    let next;
    let seq = data.nextSeq;
    if (editing) {
      next = data.trades.map((t) => (t.id === editing ? Object.assign({}, t, trade) : t));
    } else {
      next = data.trades.concat(Object.assign(trade, { id: newId(seq), seq }));
    }
    const over = Portfolio.findOversell(next);
    if (over) {
      $('form-error').textContent = oversellText(over, 'Нельзя сохранить: ');
      return;
    }
    const hst = cache.history[trade.ticker];
    const needsPrices = !data.trades.some((t) => t.ticker === trade.ticker) || (hst && trade.date < hst.from);
    data.trades = next;
    if (!editing) data.nextSeq = seq + 1;
    saveData();
    endEdit();
    resetForm();
    renderAll();
    if (ui.storageOk) setStatus('ok', editing ? 'Сделка изменена' : 'Сделка добавлена: ' + trade.ticker + ', ' + Fmt.qty(trade.qty) + ' шт.');
    if (needsPrices) refreshPrices();
    form.ticker.focus();
  }

  function startEdit(id) {
    const t = data.trades.find((x) => x.id === id);
    if (!t) return;
    ui.editingId = id;
    form.ticker.value = t.ticker;
    form.date.value = t.date;
    form.side.value = t.side;
    form.qty.value = numToInput(t.qty);
    form.price.value = numToInput(t.price);
    form.fee.value = numToInput(t.fee);
    clearFormErrors();
    updateFormSummary();
    $('trade-form-title').textContent = 'Изменение сделки от ' + Fmt.date(t.date);
    $('submit-btn').textContent = 'Сохранить';
    $('cancel-edit-btn').hidden = false;
    $('trade-card').classList.add('editing');
    $('trade-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    form.qty.focus({ preventScroll: true });
  }

  function endEdit() {
    ui.editingId = null;
    $('trade-form-title').textContent = 'Новая сделка';
    $('submit-btn').textContent = 'Добавить сделку';
    $('cancel-edit-btn').hidden = true;
    $('trade-card').classList.remove('editing');
  }

  function deleteTrade(id) {
    const t = data.trades.find((x) => x.id === id);
    if (!t) return;
    const label = (t.side === 'buy' ? 'покупку' : 'продажу') + ' ' + Fmt.qty(t.qty) + ' шт. ' + t.ticker + ' от ' + Fmt.date(t.date);
    const next = data.trades.filter((x) => x.id !== id);
    const over = Portfolio.findOversell(next);
    if (over) {
      window.alert('Нельзя удалить ' + label + ': ' + oversellText(over) + ' Сначала измените или удалите эту продажу.');
      return;
    }
    if (!window.confirm('Удалить ' + label + '?')) return;
    data.trades = next;
    if (!next.some((x) => x.ticker === t.ticker)) delete data.manualPrices[t.ticker];
    if (ui.editingId === id) {
      endEdit();
      resetForm();
    }
    saveData();
    saveCache();
    renderAll();
  }

  /* ---------- Ручная цена ---------- */

  function openPriceDialog(ticker) {
    const entry = ui.ledger.get(ticker);
    if (!entry) return;
    ui.priceTicker = ticker;
    const q = cache.quotes[ticker];
    const b = cache.boards[ticker];
    const m = data.manualPrices[ticker];
    const lines = [];
    if (q && Moex.isRub(q.currency)) {
      lines.push(
        'MOEX: ' + Fmt.price(q.price) + ' — ' + (KIND_TEXT[q.kind] || 'котировка') +
          (q.time ? ', ' + issTime(q.time) : '') +
          (ui.live.has(ticker) ? '.' : ' (сохранённая котировка от ' + localDateTime(q.fetchedAt) + ').')
      );
    } else if (q) {
      lines.push('MOEX отдаёт цену в валюте ' + q.currency + ' — укажите цену в рублях вручную.');
    } else if (b && b.status === 'notfound') {
      lines.push('Бумага не найдена на MOEX — цену нужно указать вручную.');
    } else if (b && b.status === 'unsupported') {
      lines.push('Бумага торгуется не на рынке акций MOEX — цену нужно указать вручную.');
    } else {
      lines.push('Котировка MOEX сейчас недоступна.');
    }
    if (m) lines.push('Сейчас используется цена, введённая вручную' + (m.date ? ' ' + Fmt.date(m.date) : '') + '.');
    lines.push('Последняя сделка: ' + Fmt.price(entry.lastTradePrice) + ' (' + Fmt.date(entry.lastDate) + ').');

    $('pd-title').textContent = 'Цена ' + ticker;
    $('pd-info').replaceChildren(...lines.map((l, i) => (i ? [h('br'), l] : l)).flat());
    $('pd-error').textContent = '';
    const input = $('pd-input');
    input.removeAttribute('aria-invalid');
    input.value = numToInput(m ? m.price : q && Moex.isRub(q.currency) ? q.price : entry.lastTradePrice);
    $('pd-reset').hidden = !m;
    $('price-dialog').showModal();
    input.select();
  }

  function savePrice(e) {
    e.preventDefault();
    const v = Fmt.parseNumber($('pd-input').value);
    if (!(Number.isFinite(v) && v > 0)) {
      $('pd-error').textContent = 'Введите цену больше нуля';
      $('pd-input').setAttribute('aria-invalid', 'true');
      $('pd-input').focus();
      return;
    }
    data.manualPrices[ui.priceTicker] = { price: v, date: Fmt.todayISO() };
    saveData();
    $('price-dialog').close();
    renderAll();
  }

  function resetPrice() {
    delete data.manualPrices[ui.priceTicker];
    saveData();
    $('price-dialog').close();
    renderAll();
    if (!ui.live.has(ui.priceTicker)) refreshPrices();
  }

  /* ---------- Импорт и экспорт CSV ---------- */

  function download(name, text) {
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function exportCSV(kind) {
    const vm = compute();
    const today = vm.today;
    if (kind === 'trades') {
      download('portfolio-trades-' + today + '.csv', Csv.tradesToCSV(data.trades));
      return;
    }
    if (kind === 'positions') {
      const SOURCE = { moex: 'MOEX', cached: 'MOEX (сохранённая)', manual: 'вручную', trade: 'цена сделки' };
      const rows = [
        [
          'Тикер', 'Название', 'Количество', 'Средняя цена', 'Текущая цена', 'Источник цены', 'Стоимость',
          'Доля, %', 'Нереализованная прибыль/убыток, ₽', 'Нереализованная прибыль/убыток, %',
          'Реализованная прибыль/убыток, ₽', 'Итого прибыль/убыток, ₽', 'Итого прибыль/убыток, %', 'Комиссии, ₽',
        ],
      ];
      for (const p of vm.summary.positions.concat(vm.summary.closed)) {
        const q = cache.quotes[p.ticker];
        const open = p.qty > 0;
        rows.push([
          p.ticker,
          Csv.text(q && q.name ? q.name : ''),
          Csv.num(p.qty),
          open ? Csv.num(p.avgPrice, 6) : '',
          open ? Csv.num(p.price) : '',
          open ? SOURCE[vm.infos.get(p.ticker).source] : 'позиция закрыта',
          Csv.num(p.value, 2),
          open ? Csv.num(p.weight * 100, 2) : '',
          open ? Csv.num(p.unrealized, 2) : '',
          open ? Csv.num(p.unrealizedPct * 100, 2) : '',
          Csv.num(p.realized, 2),
          Csv.num(p.totalPnl, 2),
          Csv.num(p.totalPnlPct * 100, 2),
          Csv.num(p.fees, 2),
        ]);
      }
      const t = vm.summary.totals;
      rows.push([
        'Итого', '', '', '', '', '', Csv.num(t.value, 2), t.value > 0 ? '100' : '', Csv.num(t.unrealized, 2),
        Csv.num(t.unrealizedPct * 100, 2), Csv.num(t.realized, 2), Csv.num(t.totalPnl, 2), Csv.num(t.totalPnlPct * 100, 2), Csv.num(t.fees, 2),
      ]);
      download('portfolio-positions-' + today + '.csv', Csv.toCSV(rows));
      return;
    }
    if (kind === 'income') {
      const STATUS = { received: 'получено', expected: 'ожидается' };
      const rows = [['Дата выплаты', 'Дата выплаты — оценка', 'Тикер', 'Вид', 'Статус', 'Дата реестра', 'На 1 шт., ₽', 'Количество', 'До налога, ₽', 'Налог, ₽', 'После налога, ₽', 'Источник', 'Учитывается', 'Комментарий']];
      for (const it of vm.income.items) {
        rows.push([
          it.payDate,
          it.payEstimated ? 'да' : '',
          it.ticker,
          Income.KIND_LABEL[it.kind],
          STATUS[it.status],
          it.recordDate || '',
          it.perUnit != null ? Csv.num(it.perUnit) : '',
          it.qty != null ? Csv.num(it.qty) : '',
          it.gross != null ? Csv.num(it.gross, 2) : '',
          it.tax != null ? Csv.num(it.tax, 2) : '',
          it.net != null ? Csv.num(it.net, 2) : '',
          it.source === 'manual' ? 'вручную' : 'MOEX ISS',
          it.excluded ? 'нет' : 'да',
          Csv.text(it.note || ''),
        ]);
      }
      download('portfolio-income-' + today + '.csv', Csv.toCSV(rows));
      return;
    }
    const rows = [['Дата', 'Стоимость, ₽', 'Чистые вложения, ₽', 'Прибыль/убыток, ₽']];
    for (const p of vm.history.points) rows.push([p.date, Csv.num(p.value, 2), Csv.num(p.invested, 2), Csv.num(p.value - p.invested, 2)]);
    download('portfolio-history-' + today + '.csv', Csv.toCSV(rows));
  }

  // Excel под Windows может сохранить CSV в cp1251 — пробуем обе кодировки.
  async function readFileText(file) {
    const buf = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
      return new TextDecoder('windows-1251').decode(buf);
    }
  }

  function importDialog(title, infoNodes, buttons) {
    $('imp-title').textContent = title;
    $('imp-info').replaceChildren(...infoNodes);
    $('imp-actions').replaceChildren(
      h('span', { class: 'spacer' }),
      ...buttons.map((b) =>
        h('button', {
          type: 'button',
          class: 'btn' + (b.primary ? ' primary' : ''),
          text: b.label,
          onclick: () => {
            $('import-dialog').close();
            if (b.action) b.action();
          },
        })
      )
    );
    $('import-dialog').showModal();
  }

  function readImportMaps() {
    try {
      const m = JSON.parse(localStorage.getItem(IMPORT_MAP_KEY) || '{}');
      return m && typeof m === 'object' ? m : {};
    } catch (e) {
      return {};
    }
  }

  function rememberImportMap(sig, mapping, sideMap) {
    const all = readImportMaps();
    all[sig] = { mapping, sideMap, savedAt: Date.now() };
    // Храним несколько последних форматов отчётов.
    const keys = Object.keys(all).sort((a, b) => (all[b].savedAt || 0) - (all[a].savedAt || 0));
    for (const k of keys.slice(10)) delete all[k];
    try {
      localStorage.setItem(IMPORT_MAP_KEY, JSON.stringify(all));
    } catch (e) {
      /* не критично */
    }
  }

  async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      importDialog('Импорт сделок', ['Файл слишком большой (больше 5 МБ).'], [{ label: 'Закрыть', primary: true }]);
      return;
    }
    if (/\.(xlsx?|xlsm|ods|pdf|html?)$/i.test(file.name)) {
      importDialog(
        'Нужен файл CSV',
        ['Откройте отчёт брокера в Excel и сохраните его как «CSV UTF-8 (разделитель — запятая)» или «CSV (разделители — точка с запятой)», затем выберите этот файл.'],
        [{ label: 'Закрыть', primary: true }]
      );
      return;
    }
    const text = await readFileText(file);
    const rows = Csv.parseCSV(text);
    if (!rows.length) {
      importDialog('Импорт сделок', ['Файл пустой.'], [{ label: 'Закрыть', primary: true }]);
      return;
    }
    const headerRow = Csv.findHeaderRow(rows);
    const st = { fileName: file.name, rows, headerRow, mapping: null, sideMap: {}, mode: data.trades.length ? 'append' : 'replace', skipErrors: false, skipDuplicates: true, result: null };
    setImportHeader(st, headerRow);
    ui.importState = st;
    renderImport();
    $('map-dialog').showModal();
  }

  // Новая строка заголовка → сопоставление заново (или запомненное для такого же отчёта).
  function setImportHeader(st, headerRow) {
    st.headerRow = headerRow;
    const header = st.rows[headerRow] || [];
    st.sig = Csv.headerSignature(header);
    const saved = readImportMaps()[st.sig];
    st.mapping = saved && saved.mapping ? Object.assign(Csv.guessMapping(header), saved.mapping) : Csv.guessMapping(header);
    st.sideMap = saved && saved.sideMap ? Object.assign({}, saved.sideMap) : {};
    st.remembered = !!saved;
  }

  function colLetter(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  function clip(v, n) {
    const str = String(v == null ? '' : v).trim();
    return str.length > n ? str.slice(0, n - 1) + '…' : str;
  }

  function renderImport() {
    const st = ui.importState;
    if (!st) return;
    const rows = st.rows;
    const header = rows[st.headerRow] || [];
    const sample = rows[st.headerRow + 1] || [];
    const width = Math.max(...rows.slice(st.headerRow, st.headerRow + 50).map((r) => r.length));
    const colName = (i) => colLetter(i) + ': ' + (clip(header[i], 40) || 'без названия');

    // Сопоставление → сделки.
    const sideValues = st.mapping.side >= 0 ? Csv.distinctValues(rows, st.headerRow + 1, st.mapping.side, 30) : [];
    for (const v of sideValues) if (!(v in st.sideMap)) st.sideMap[v] = Csv.guessSide(v);
    const res = Csv.mapRows(rows, st.headerRow, st.mapping, st.sideMap, Fmt.todayISO());
    const dup = st.mode === 'append' ? Csv.findDuplicates(data.trades, res.trades) : new Set();
    st.result = res;
    st.dup = dup;
    const fatal = res.errors.length === 1 && res.errors[0].row === 0;
    const importable = res.trades.length - (st.skipDuplicates ? dup.size : 0);

    const nodes = [];
    nodes.push(
      h(
        'p',
        { class: 'map-hint' },
        'Файл «' + clip(st.fileName, 60) + '»: ' + rows.length + ' ' + plural(rows.length, 'строка', 'строки', 'строк') + '. ' +
          'Укажите, в каком столбце что находится — сайт подставил то, что узнал' + (st.remembered ? ' (и сопоставление, сохранённое при прошлом импорте такого отчёта)' : '') + '. Поля со звёздочкой обязательны.'
      )
    );

    // Строка заголовка.
    const headerOptions = rows.slice(0, 40).map((r, i) => h('option', { value: String(i), text: 'Строка ' + (r.line || i + 1) + ': ' + clip(r.filter((c) => c.trim()).join(' · '), 90) }));
    const headerSel = h('select', { id: 'map-header', 'aria-label': 'Строка с названиями столбцов' }, headerOptions);
    headerSel.value = String(st.headerRow);
    headerSel.addEventListener('change', () => {
      setImportHeader(st, Number(headerSel.value));
      renderImport();
    });
    nodes.push(h('div', { class: 'map-section' }, h('h4', { text: '1. Строка с названиями столбцов' }), headerSel));

    // Поля.
    const grid = h('div', { class: 'map-grid' });
    for (const f of Csv.FIELDS) {
      const sel = h('select', { 'data-field': f.key });
      const none = f.key === 'side' ? '— нет: покупка/продажа по знаку количества —' : f.required ? '— выберите столбец —' : '— нет в файле —';
      sel.append(h('option', { value: '-1', text: none }));
      for (let i = 0; i < width; i++) sel.append(h('option', { value: String(i), text: colName(i) }));
      sel.value = String(st.mapping[f.key]);
      sel.addEventListener('change', () => {
        st.mapping[f.key] = Number(sel.value);
        renderImport();
      });
      const unset = f.required && st.mapping[f.key] < 0;
      const col = st.mapping[f.key];
      const example = col >= 0 && sample[col] ? 'например: ' + clip(sample[col], 40) : '';
      grid.append(
        h('label', { class: 'map-row' + (f.required ? ' req' : '') + (unset ? ' unset' : '') }, h('span', { text: f.label }), sel, example ? h('small', { class: 'muted', text: example }) : null)
      );
    }
    nodes.push(
      h(
        'div',
        { class: 'map-section' },
        h('h4', { text: '2. Столбцы' }),
        h('p', { class: 'map-hint', text: 'Если в отчёте нет цены за штуку, выберите «Сумма сделки» — цена будет посчитана как сумма / количество. Две комиссии (брокера и биржи) складываются.' }),
        grid
      )
    );

    // Значения операции.
    if (st.mapping.side >= 0) {
      const box = h('div', { class: 'side-map' });
      if (!sideValues.length) box.append(h('span', { class: 'muted', text: 'В выбранном столбце нет значений.' }));
      for (const v of sideValues) {
        const sel = h(
          'select',
          { 'aria-label': 'Значение «' + v + '»' },
          h('option', { value: 'buy', text: 'Покупка' }),
          h('option', { value: 'sell', text: 'Продажа' }),
          h('option', { value: 'skip', text: 'Пропустить строку' })
        );
        sel.value = st.sideMap[v];
        sel.addEventListener('change', () => {
          st.sideMap[v] = sel.value;
          renderImport();
        });
        box.append(h('span', { class: 'val', title: v, text: v }), sel);
      }
      nodes.push(h('div', { class: 'map-section' }, h('h4', { text: '3. Что означают значения в столбце операции' }), box));
    }

    // Итог и предпросмотр.
    const summary = h('div', { class: 'map-summary' });
    if (fatal) {
      summary.append(h('span', { class: 'neg', text: res.errors[0].message }));
    } else {
      summary.append(h('span', null, 'Сделок найдено: ', h('b', { text: String(res.trades.length) })));
      if (res.skipped.length) summary.append(h('span', { title: res.skipped.slice(0, 20).map((x) => 'строка ' + x.row + ': ' + x.reason).join('\n') }, 'Пропущено строк: ', h('b', { text: String(res.skipped.length) }), ' (служебные и другие операции)'));
      if (res.errors.length) summary.append(h('span', { class: 'neg' }, 'С ошибками: ', h('b', { text: String(res.errors.length) })));
      if (dup.size) summary.append(h('span', null, 'Уже есть в трекере: ', h('b', { text: String(dup.size) })));
    }
    const section = h('div', { class: 'map-section map-preview' }, h('h4', { text: (st.mapping.side >= 0 ? '4' : '3') + '. Проверка' }), summary);
    if (!fatal && res.errors.length) {
      section.append(h('ul', { class: 'map-errors' }, res.errors.slice(0, 15).map((er) => h('li', { text: 'Строка ' + er.row + ': ' + er.message })), res.errors.length > 15 ? h('li', { text: '…и ещё ' + (res.errors.length - 15) }) : null));
    }
    if (res.trades.length) {
      const shown = res.trades.slice(0, 6);
      section.append(
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data' },
            h('thead', null, h('tr', null, ['Строка', 'Дата', 'Бумага', 'Операция', 'Кол-во', 'Цена', 'Комиссия'].map((t, i) => h('th', { class: i === 2 || i === 3 ? 'left' : null, text: t })))),
            h(
              'tbody',
              null,
              shown.map((t) =>
                h(
                  'tr',
                  { class: dup.has(res.trades.indexOf(t)) && st.skipDuplicates ? 'closed' : null },
                  h('td', { text: String(t.row) }),
                  h('td', { text: Fmt.date(t.date) }),
                  h('td', { class: 'left' }, h('span', { class: 'ticker', text: t.ticker })),
                  h('td', { class: 'left', text: t.side === 'buy' ? 'Покупка' : 'Продажа' }),
                  h('td', { text: Fmt.qty(t.qty) }),
                  h('td', { text: Fmt.price(t.price) }),
                  h('td', { text: Fmt.money(t.fee) })
                )
              )
            )
          )
        )
      );
      if (res.trades.length > shown.length) section.append(h('p', { class: 'map-hint', text: 'Показаны первые ' + shown.length + ' из ' + res.trades.length + '.' }));
    }
    nodes.push(section);

    // Параметры.
    const opts = h('div', { class: 'map-options' });
    if (data.trades.length) {
      const radio = (value, text) => {
        const input = h('input', { type: 'radio', name: 'map-mode', value, checked: st.mode === value });
        input.addEventListener('change', () => {
          st.mode = value;
          renderImport();
        });
        return h('label', { class: 'check' }, input, text);
      };
      opts.append(radio('append', 'Добавить к сделкам в трекере (сейчас ' + data.trades.length + ')'), radio('replace', 'Заменить все сделки в трекере'));
      if (st.mode === 'append' && dup.size) {
        const cb = h('input', { type: 'checkbox', checked: st.skipDuplicates });
        cb.addEventListener('change', () => {
          st.skipDuplicates = cb.checked;
          renderImport();
        });
        opts.append(h('label', { class: 'check' }, cb, 'Не добавлять сделки, которые уже есть (совпадают дата, бумага, операция, количество и цена)'));
      }
    }
    if (!fatal && res.errors.length) {
      const cb = h('input', { type: 'checkbox', checked: st.skipErrors });
      cb.addEventListener('change', () => {
        st.skipErrors = cb.checked;
        renderImport();
      });
      opts.append(h('label', { class: 'check' }, cb, 'Импортировать без строк с ошибками'));
    }
    if (opts.childNodes.length) nodes.push(h('div', { class: 'map-section' }, opts));

    $('map-body').replaceChildren(...nodes);
    const btn = $('map-submit');
    btn.disabled = fatal || importable <= 0 || (res.errors.length > 0 && !st.skipErrors);
    btn.textContent = importable > 0 ? 'Импортировать ' + importable + ' ' + plural(importable, 'сделку', 'сделки', 'сделок') : 'Импортировать';
  }

  function submitImport(e) {
    e.preventDefault();
    const st = ui.importState;
    if (!st || !st.result || $('map-submit').disabled) return;
    const trades = st.result.trades
      .filter((t, i) => !(st.skipDuplicates && st.dup.has(i)))
      .map(({ row, ...t }) => t);
    if (applyImport(trades, st.mode)) {
      rememberImportMap(st.sig, st.mapping, st.sideMap);
      $('map-dialog').close();
      ui.importState = null;
    }
  }

  function applyImport(trades, mode) {
    let seq = mode === 'replace' ? 1 : data.nextSeq;
    const incoming = trades.map((t) => Object.assign({}, t, { id: newId(seq), seq: seq++ }));
    const next = mode === 'replace' ? incoming : data.trades.concat(incoming);
    const over = Portfolio.findOversell(next);
    if (over) {
      importDialog(
        'Импорт не выполнен',
        [oversellText(over, 'После импорта '), ' Возможно, в отчёте нет более ранних покупок — добавьте их или выберите «Добавить к сделкам в трекере».'],
        [{ label: 'Закрыть', primary: true }]
      );
      return false;
    }
    data.trades = next;
    data.nextSeq = seq;
    endEdit();
    saveData();
    renderAll();
    setStatus('ok', 'Импортировано сделок: ' + incoming.length);
    refreshPrices();
    return true;
  }

  /* ---------- Тема ---------- */

  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: 'Тема: как в системе', light: 'Тема: светлая', dark: 'Тема: тёмная' };
  // Иконки: полукруг — как в системе, солнце — светлая, месяц — тёмная.
  const THEME_ICON = {
    auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
    light:
      '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  };

  function currentTheme() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  }

  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
    try {
      if (t === 'auto') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, t);
    } catch (e) {
      /* тема просто не запомнится */
    }
    const btn = $('theme-btn');
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      THEME_ICON[t] +
      '</svg>';
    btn.title = THEME_LABEL[t];
    btn.setAttribute('aria-label', THEME_LABEL[t]);
  }

  /* ---------- Запуск ---------- */

  function init() {
    loadData();
    loadCache();
    try {
      const r = localStorage.getItem(RANGE_KEY);
      if (r && ['1', '3', '6', '12', 'all'].includes(r)) ui.range = r;
      const tab = localStorage.getItem(INCOME_TAB_KEY);
      if (tab === 'upcoming' || tab === 'received') ui.incomeTab = tab;
    } catch (e) {
      /* по умолчанию «Всё» */
    }
    try {
      localStorage.setItem('portfolio-tracker:probe', '1');
      localStorage.removeItem('portfolio-tracker:probe');
    } catch (e) {
      ui.storageOk = false;
    }

    applyTheme(currentTheme());
    form.date.value = Fmt.todayISO();
    form.date.max = Fmt.todayISO();

    form.addEventListener('submit', onSubmit);
    form.addEventListener('input', updateFormSummary);
    form.addEventListener('change', updateFormSummary);
    $('cancel-edit-btn').addEventListener('click', () => {
      endEdit();
      resetForm();
    });
    $('add-trade-btn').addEventListener('click', () => {
      $('trade-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
      form.ticker.focus({ preventScroll: true });
    });
    $('refresh-btn').addEventListener('click', refreshPrices);
    $('show-closed').addEventListener('change', (e) => {
      ui.showClosed = e.target.checked;
      renderAll();
    });
    $('trade-filter').addEventListener('change', (e) => {
      ui.filter = e.target.value;
      renderTrades();
    });
    // Период общий для графика стоимости и сравнения с индексом.
    const onRange = (e) => {
      const b = e.target.closest('button[data-range]');
      if (!b) return;
      ui.range = b.dataset.range;
      try {
        localStorage.setItem(RANGE_KEY, ui.range);
      } catch (err) {
        /* не критично */
      }
      const vm = compute();
      renderHistory(vm);
      renderBench(vm);
    };
    $('range').addEventListener('click', onRange);
    $('bench-range').addEventListener('click', onRange);
    $('bench-income').addEventListener('change', (e) => {
      data.settings.benchIncome = e.target.checked;
      saveData();
      renderBench(compute());
    });
    $('income-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      ui.incomeTab = b.dataset.tab;
      try {
        localStorage.setItem(INCOME_TAB_KEY, ui.incomeTab);
      } catch (err) {
        /* не критично */
      }
      renderIncome(compute());
    });
    $('tax-rate').addEventListener('change', (e) => {
      const v = Number(e.target.value);
      if (!Income.TAX_RATES.includes(v)) return;
      data.settings.taxRate = v;
      saveData();
      renderAll();
    });
    $('add-income-btn').addEventListener('click', openIncomeDialog);
    incomeForm.addEventListener('submit', saveManualIncome);
    $('inc-cancel').addEventListener('click', () => $('income-dialog').close());
    $('map-form').addEventListener('submit', submitImport);
    $('map-cancel').addEventListener('click', () => {
      $('map-dialog').close();
      ui.importState = null;
    });
    $('export-menu').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-export]');
      if (!b) return;
      $('export-menu').open = false;
      exportCSV(b.dataset.export);
    });
    document.addEventListener('click', (e) => {
      const menu = $('export-menu');
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
    $('import-btn').addEventListener('click', () => $('import-file').click());
    $('import-file').addEventListener('change', onImportFile);
    $('theme-btn').addEventListener('click', () => applyTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]));
    $('price-form').addEventListener('submit', savePrice);
    $('pd-cancel').addEventListener('click', () => $('price-dialog').close());
    $('pd-reset').addEventListener('click', resetPrice);
    $('clear-btn').addEventListener('click', () => {
      if (!window.confirm('Удалить все сделки, ручные цены и ручные выплаты из этого браузера? Перед этим можно сделать экспорт в CSV.')) return;
      data = emptyData();
      cache = emptyCache();
      ui.live.clear();
      endEdit();
      resetForm();
      saveData();
      saveCache();
      setStatus(null);
      renderAll();
    });

    // Синхронизация между вкладками.
    window.addEventListener('storage', (e) => {
      if (e.key === DATA_KEY) {
        loadData();
        renderAll();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - ui.lastRefresh > AUTO_REFRESH_AFTER) refreshPrices();
    });

    renderAll();
    if (!ui.storageOk) {
      setStatus('warn', 'Хранилище браузера недоступно — данные не сохранятся после закрытия страницы. Пользуйтесь экспортом в CSV.');
    }
    refreshPrices();
  }

  init();
})();

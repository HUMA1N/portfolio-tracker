/* Интерфейс трекера: состояние, хранение в браузере, отрисовка, обновление цен. */
(function () {
  'use strict';

  const { Fmt, Portfolio, Csv, Moex, Charts } = window;

  const DATA_KEY = 'portfolio-tracker:data:v1';
  const CACHE_KEY = 'portfolio-tracker:cache:v1';
  const THEME_KEY = 'portfolio-tracker:theme';
  const RANGE_KEY = 'portfolio-tracker:range';
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

  function emptyData() {
    return { trades: [], manualPrices: {}, nextSeq: 1 };
  }

  function emptyCache() {
    return { boards: {}, quotes: {}, history: {} };
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
      for (const k of ['boards', 'quotes', 'history']) {
        if (raw[k] && typeof raw[k] === 'object') c[k] = raw[k];
      }
    }
    for (const [tk, hst] of Object.entries(c.history)) {
      if (!hst || !Array.isArray(hst.closes)) delete c.history[tk];
    }
    cache = c;
  }

  function saveCache() {
    const keep = new Set(data.trades.map((t) => t.ticker));
    for (const k of ['boards', 'quotes', 'history']) {
      for (const tk of Object.keys(cache[k])) if (!keep.has(tk)) delete cache[k][tk];
    }
    if (!writeJSON(CACHE_KEY, cache)) {
      // История занимает больше всего места: без неё кэш точно поместится.
      writeJSON(CACHE_KEY, { boards: cache.boards, quotes: cache.quotes, history: {} });
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
    ui.ledger = ledger;
    return { today, infos, summary, history };
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
    renderPositions(vm, colorOf);
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
        kpi('Реализованная', '—', 'по проданным бумагам')
      );
      return;
    }
    const n = t.openCount;
    box.replaceChildren(
      kpi(
        'Текущая стоимость',
        Fmt.money(t.value),
        n + ' ' + plural(n, 'бумага', 'бумаги', 'бумаг') + ' · себестоимость ' + Fmt.money(t.cost, { digits: 0 }),
        { hero: true }
      ),
      kpi('Прибыль/убыток всего', Fmt.money(t.totalPnl, { sign: true }), Fmt.pct(t.totalPnlPct) + ' к сумме покупок', {
        tone: tone(t.totalPnl),
      }),
      kpi('Нереализованная', Fmt.money(t.unrealized, { sign: true }), Number.isFinite(t.unrealizedPct) ? Fmt.pct(t.unrealizedPct) + ' к себестоимости' : 'нет открытых позиций', {
        tone: tone(t.unrealized),
      }),
      kpi('Реализованная', Fmt.money(t.realized, { sign: true }), 'по проданным бумагам', { tone: tone(t.realized) }),
      kpi('Комиссии', Fmt.money(t.fees), 'уплачено за всё время')
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
    document.querySelectorAll('#range button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === ui.range)));

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
        ['Бумага', 'Кол-во', 'Средняя цена', 'Текущая цена', 'Стоимость', 'Доля', 'Нереализованная прибыль/убыток', 'Реализованная', 'Итого прибыль/убыток'].map((t) =>
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

    const body = h('tbody');
    if (!positions.length && !(ui.showClosed && closed.length)) {
      body.append(
        h('tr', { class: 'empty-row' }, h('td', { colspan: 9, text: data.trades.length ? 'Открытых позиций нет.' : 'Позиций пока нет — добавьте сделку в форме ниже.' }))
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
          h('td', null, moneyWithPct(totals.totalPnl, totals.totalPnlPct))
        )
      );
    }
    table.replaceChildren(head, body);
    if (foot) table.append(foot);
    $('show-closed').parentElement.hidden = !closed.length;
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
    } finally {
      ui.busy = false;
      ui.refreshing = false;
      ui.historyLoading = false;
      ui.lastRefresh = Date.now();
      $('refresh-btn').disabled = false;
    }

    const missing = tickers.filter((tk) => cache.boards[tk] && cache.boards[tk].status !== 'ok');
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

  async function onImportFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      importDialog('Импорт сделок', ['Файл слишком большой (больше 5 МБ).'], [{ label: 'Закрыть', primary: true }]);
      return;
    }
    const text = await readFileText(file);
    const { trades, errors } = Csv.parseTradesCSV(text, Fmt.todayISO());
    if (errors.length) {
      const shown = errors.slice(0, 12);
      importDialog(
        'Файл не импортирован',
        [
          'Исправьте ошибки и попробуйте снова. Ожидаемые столбцы: ' + Csv.TRADE_HEADER.join('; ') + '.',
          h('ul', null, shown.map((m) => h('li', { text: m })), errors.length > shown.length ? h('li', { text: '…и ещё ' + (errors.length - shown.length) }) : null),
        ],
        [{ label: 'Закрыть', primary: true }]
      );
      return;
    }
    if (!trades.length) {
      importDialog('Импорт сделок', ['В файле нет сделок.'], [{ label: 'Закрыть', primary: true }]);
      return;
    }
    if (!data.trades.length) {
      applyImport(trades, 'replace');
      return;
    }
    const n = trades.length;
    importDialog(
      'Импорт сделок',
      [
        'В файле ' + n + ' ' + plural(n, 'сделка', 'сделки', 'сделок') + '. Сейчас в трекере ' + data.trades.length + ' ' +
          plural(data.trades.length, 'сделка', 'сделки', 'сделок') + '.',
      ],
      [
        { label: 'Отмена' },
        { label: 'Добавить к текущим', action: () => applyImport(trades, 'append') },
        { label: 'Заменить', primary: true, action: () => applyImport(trades, 'replace') },
      ]
    );
  }

  function applyImport(trades, mode) {
    let seq = mode === 'replace' ? 1 : data.nextSeq;
    const incoming = trades.map((t) => Object.assign({}, t, { id: newId(seq), seq: seq++ }));
    const next = mode === 'replace' ? incoming : data.trades.concat(incoming);
    const over = Portfolio.findOversell(next);
    if (over) {
      importDialog('Файл не импортирован', [oversellText(over, 'После импорта ')], [{ label: 'Закрыть', primary: true }]);
      return;
    }
    data.trades = next;
    data.nextSeq = seq;
    endEdit();
    saveData();
    renderAll();
    setStatus('ok', 'Импортировано сделок: ' + incoming.length);
    refreshPrices();
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
    $('range').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-range]');
      if (!b) return;
      ui.range = b.dataset.range;
      try {
        localStorage.setItem(RANGE_KEY, ui.range);
      } catch (err) {
        /* не критично */
      }
      renderHistory(compute());
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
      if (!window.confirm('Удалить все сделки и ручные цены из этого браузера? Перед этим можно сделать экспорт в CSV.')) return;
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

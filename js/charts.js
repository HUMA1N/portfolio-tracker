/*
 * SVG-графики без внешних библиотек: кольцевая диаграмма долей и линейный
 * график стоимости с перекрестием и подсказкой. Цвета задаются CSS-классами,
 * поэтому светлая и тёмная темы переключаются без перерисовки.
 */
(function (root) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const Fmt = root.Fmt;

  function svgEl(tag, attrs, parent) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
    if (parent) parent.appendChild(node);
    return node;
  }

  function div(cls, text, parent) {
    const node = document.createElement('div');
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  }

  /* ---------- Подсказка ---------- */

  function tipFor(container) {
    let tip = container.querySelector(':scope > .chart-tip');
    if (!tip) {
      tip = div('chart-tip', null, container);
      tip.setAttribute('role', 'presentation');
    }
    tip.hidden = true;
    return tip;
  }

  // rows: [{ value, label, swatch: 'line'|'dot'|null, cls, tone }]
  function fillTip(tip, title, rows) {
    tip.replaceChildren();
    if (title) div('chart-tip-title', title, tip);
    for (const r of rows) {
      const row = div('chart-tip-row', null, tip);
      if (r.swatch) div('chart-tip-key ' + r.swatch + ' ' + (r.cls || ''), null, row);
      else div('chart-tip-key', null, row);
      div('chart-tip-value' + (r.tone ? ' ' + r.tone : ''), r.value, row);
      div('chart-tip-label', r.label, row);
    }
    tip.hidden = false;
  }

  function placeTip(container, tip, x, y) {
    const cw = container.clientWidth;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = x + 14;
    if (left + tw > cw - 4) left = x - tw - 14;
    if (left < 4) left = Math.max(4, Math.min(cw - tw - 4, x - tw / 2));
    let top = y - th / 2;
    top = Math.max(4, Math.min(container.clientHeight - th - 4, top));
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  /* ---------- Кольцевая диаграмма ---------- */

  function sectorPath(cx, cy, R, r, a0, a1) {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const pt = (rad, a) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
    const [x0, y0] = pt(R, a0);
    const [x1, y1] = pt(R, a1);
    const [x2, y2] = pt(r, a1);
    const [x3, y3] = pt(r, a0);
    const f = (n) => n.toFixed(3);
    return (
      'M' + f(x0) + ' ' + f(y0) +
      'A' + R + ' ' + R + ' 0 ' + large + ' 1 ' + f(x1) + ' ' + f(y1) +
      'L' + f(x2) + ' ' + f(y2) +
      'A' + r + ' ' + r + ' 0 ' + large + ' 0 ' + f(x3) + ' ' + f(y3) + 'Z'
    );
  }

  /*
   * slices: [{ label, value, share, cls }] — порядок задаёт вызывающий код.
   * center: { title, sub }.
   */
  function renderDonut(container, slices, center) {
    container.replaceChildren();
    const size = 200;
    const cx = size / 2;
    const cy = size / 2;
    const R = 98;
    const r = 64;
    const svg = svgEl('svg', {
      viewBox: '0 0 ' + size + ' ' + size,
      class: 'donut',
      role: 'group',
      'aria-label': 'Доли бумаг в портфеле',
    }, container);
    const tip = tipFor(container);
    const total = slices.reduce((s, x) => s + x.value, 0);
    const paths = [];

    const show = (i, evt) => {
      paths.forEach((p, j) => p.classList.toggle('dim', j !== i));
      const s = slices[i];
      fillTip(tip, s.label, [
        { value: Fmt.pct(s.share, { sign: false }), label: 'доля', swatch: 'dot', cls: s.cls },
        { value: Fmt.money(s.value), label: 'стоимость' },
      ]);
      const box = container.getBoundingClientRect();
      let x, y;
      if (evt && evt.clientX != null && evt.pointerType !== undefined) {
        x = evt.clientX - box.left;
        y = evt.clientY - box.top;
      } else {
        const sb = paths[i].getBoundingClientRect();
        x = sb.left + sb.width / 2 - box.left;
        y = sb.top + sb.height / 2 - box.top;
      }
      placeTip(container, tip, x, y);
    };
    const hide = () => {
      paths.forEach((p) => p.classList.remove('dim'));
      tip.hidden = true;
    };

    if (total > 0) {
      let a = 0;
      slices.forEach((s, i) => {
        const span = (s.value / total) * Math.PI * 2;
        let node;
        if (slices.length === 1) {
          node = svgEl('circle', { cx, cy, r: (R + r) / 2, 'stroke-width': R - r, class: 'donut-ring ' + s.cls }, svg);
        } else {
          node = svgEl('path', { d: sectorPath(cx, cy, R, r, a, a + span), class: 'donut-slice ' + s.cls }, svg);
        }
        node.setAttribute('tabindex', '0');
        node.setAttribute('aria-label', s.label + ': ' + Fmt.pct(s.share, { sign: false }) + ', ' + Fmt.money(s.value));
        node.addEventListener('pointermove', (e) => show(i, e));
        node.addEventListener('pointerleave', hide);
        node.addEventListener('focus', () => show(i));
        node.addEventListener('blur', hide);
        paths.push(node);
        a += span;
      });
    } else {
      svgEl('circle', { cx, cy, r: (R + r) / 2, 'stroke-width': R - r, class: 'donut-empty' }, svg);
    }

    const t1 = svgEl('text', { x: cx, y: cy - 2, class: 'donut-center-title', 'text-anchor': 'middle' }, svg);
    t1.textContent = center.title;
    const t2 = svgEl('text', { x: cx, y: cy + 18, class: 'donut-center-sub', 'text-anchor': 'middle' }, svg);
    t2.textContent = center.sub;
  }

  /* ---------- Линейный график ---------- */

  let measureCtx = null;
  function textWidth(s) {
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d');
      measureCtx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    }
    return measureCtx.measureText(s).width;
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
  }

  function yTicks(lo, hi, count) {
    if (hi <= lo) {
      const d = Math.abs(hi) * 0.1 || 1;
      lo -= d;
      hi += d;
    }
    const step = niceStep((hi - lo) / Math.max(1, count - 1));
    const start = Math.floor(lo / step) * step;
    const end = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : v);
    return ticks;
  }

  function xTicks(d0, d1, maxTicks) {
    const span = d1 - d0;
    const out = [];
    if (span < 75) {
      const step = Math.max(1, Math.ceil(span / Math.max(1, maxTicks - 1)));
      for (let n = d0; n <= d1; n += step) out.push({ day: n, label: Fmt.dateShort(Fmt.isoFromDayNumber(n)) });
      return out;
    }
    const first = Fmt.isoFromDayNumber(d0);
    let m = Fmt.addMonths(first.slice(0, 8) + '01', first.endsWith('-01') ? 0 : 1);
    const months = [];
    while (Fmt.dayNumber(m) <= d1) {
      months.push(m);
      m = Fmt.addMonths(m, 1);
    }
    let step = [1, 2, 3, 6, 12, 24, 60].find((s) => Math.ceil(months.length / s) <= maxTicks) || 120;
    let list = months;
    if (step >= 12) list = months.filter((x) => x.slice(5, 7) === '01');
    else if (step > 1) list = months.filter((x) => (+x.slice(5, 7) - 1) % step === 0);
    if (step >= 12) list = list.filter((x, i) => i % (step / 12) === 0);
    list.forEach((iso, i) => {
      const jan = iso.slice(5, 7) === '01';
      const label = step >= 12 ? iso.slice(0, 4) : Fmt.monthLabel(iso, jan || i === 0);
      out.push({ day: Fmt.dayNumber(iso), label });
    });
    return out;
  }

  /*
   * opts: {
   *   points: [{ date, ...значения }],
   *   series: [{ key, label, cls, step }],
   *   tipExtra(point) → [{ value, label, tone }],
   *   ariaLabel,
   * }
   */
  function renderLineChart(container, opts) {
    container.__chart = opts;
    observe(container);
    draw(container);
  }

  function draw(container) {
    const opts = container.__chart;
    const pts = opts.points;
    container.replaceChildren();
    const width = Math.max(280, container.clientWidth);
    container.__lastWidth = container.clientWidth;
    const plotH = width < 560 ? 200 : 260;
    const axisH = 28;
    const height = plotH + axisH + 8;

    const values = [];
    for (const p of pts) for (const s of opts.series) values.push(p[s.key]);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    const pad = (hi - lo) * 0.06;
    lo -= pad;
    hi += pad;
    if (lo < 0 && Math.min(...values) >= 0) lo = 0;
    const ticks = yTicks(lo, hi, plotH < 220 ? 4 : 5);
    const yMin = ticks[0];
    const yMax = ticks[ticks.length - 1];
    const labels = ticks.map((v) => Fmt.compactMoney(v));
    const left = Math.ceil(Math.max(...labels.map(textWidth))) + 14;
    const right = 14;
    const top = 8;
    const plotW = width - left - right;

    const days = pts.map((p) => Fmt.dayNumber(p.date));
    const d0 = days[0];
    const d1 = days[days.length - 1];
    const x = (day) => (d1 === d0 ? left + plotW / 2 : left + ((day - d0) / (d1 - d0)) * plotW);
    const y = (v) => top + (1 - (v - yMin) / (yMax - yMin || 1)) * plotH;

    const svg = svgEl('svg', {
      width,
      height,
      viewBox: '0 0 ' + width + ' ' + height,
      class: 'linechart',
      role: 'img',
      tabindex: 0,
      'aria-label': opts.ariaLabel || '',
    }, container);

    const grid = svgEl('g', { class: 'grid' }, svg);
    ticks.forEach((v, i) => {
      const yy = Math.round(y(v)) + 0.5;
      svgEl('line', { x1: left, x2: width - right, y1: yy, y2: yy, class: v === 0 && yMin < 0 ? 'zero' : '' }, grid);
      const t = svgEl('text', { x: left - 8, y: yy + 4, 'text-anchor': 'end', class: 'axis-label' }, grid);
      t.textContent = labels[i];
    });
    svgEl('line', { x1: left, x2: width - right, y1: top + plotH + 0.5, y2: top + plotH + 0.5, class: 'baseline' }, svg);

    const maxX = Math.max(2, Math.floor(plotW / 72));
    for (const tk of xTicks(d0, d1, maxX)) {
      const xx = x(tk.day);
      if (xx < left - 1 || xx > width - right + 1) continue;
      svgEl('line', { x1: xx, x2: xx, y1: top + plotH, y2: top + plotH + 4, class: 'tick' }, svg);
      const t = svgEl('text', { x: xx, y: top + plotH + 18, 'text-anchor': 'middle', class: 'axis-label' }, svg);
      t.textContent = tk.label;
      // Не даём подписи вылезти за края.
      const w = textWidth(tk.label) / 2;
      if (xx - w < 0) t.setAttribute('text-anchor', 'start');
      else if (xx + w > width) t.setAttribute('text-anchor', 'end');
    }

    for (const s of opts.series) {
      let d = '';
      pts.forEach((p, i) => {
        const xx = x(days[i]).toFixed(2);
        const yy = y(p[s.key]).toFixed(2);
        if (i === 0) d = 'M' + xx + ' ' + yy;
        else if (s.step) d += 'H' + xx + 'V' + yy;
        else d += 'L' + xx + ' ' + yy;
      });
      if (pts.length === 1) d += 'h0.01';
      svgEl('path', { d, class: 'series-line ' + s.cls }, svg);
    }
    // Точки на концах линий.
    const last = pts.length - 1;
    for (const s of opts.series) {
      svgEl('circle', { cx: x(days[last]), cy: y(pts[last][s.key]), r: 4, class: 'end-dot ' + s.cls }, svg);
    }

    // Слой наведения: перекрестие ищет ближайшую дату.
    const hover = svgEl('g', { class: 'hover', visibility: 'hidden' }, svg);
    const cross = svgEl('line', { y1: top, y2: top + plotH, class: 'crosshair' }, hover);
    const dots = opts.series.map((s) => svgEl('circle', { r: 4, class: 'hover-dot ' + s.cls }, hover));
    const hit = svgEl('rect', { x: left, y: top, width: plotW, height: plotH, class: 'hit' }, svg);
    const tip = tipFor(container);
    let current = last;

    const showAt = (i) => {
      current = i;
      const p = pts[i];
      const xx = x(days[i]);
      cross.setAttribute('x1', xx);
      cross.setAttribute('x2', xx);
      opts.series.forEach((s, k) => {
        dots[k].setAttribute('cx', xx);
        dots[k].setAttribute('cy', y(p[s.key]));
      });
      hover.setAttribute('visibility', 'visible');
      const rows = opts.series.map((s) => ({ value: Fmt.money(p[s.key], { digits: 0 }), label: s.label, swatch: 'line', cls: s.cls }));
      fillTip(tip, Fmt.date(p.date), rows.concat(opts.tipExtra ? opts.tipExtra(p) : []));
      const yTop = Math.min(...opts.series.map((s) => y(p[s.key])));
      placeTip(container, tip, xx, Math.max(top + 30, yTop));
    };
    const hide = () => {
      hover.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    };
    const nearest = (clientX) => {
      const box = svg.getBoundingClientRect();
      const px = ((clientX - box.left) / box.width) * width;
      const day = d1 === d0 ? d0 : d0 + ((px - left) / plotW) * (d1 - d0);
      let loI = 0;
      let hiI = days.length - 1;
      while (hiI - loI > 1) {
        const mid = (loI + hiI) >> 1;
        if (days[mid] < day) loI = mid;
        else hiI = mid;
      }
      return Math.abs(days[loI] - day) <= Math.abs(days[hiI] - day) ? loI : hiI;
    };
    hit.addEventListener('pointermove', (e) => showAt(nearest(e.clientX)));
    hit.addEventListener('pointerdown', (e) => showAt(nearest(e.clientX)));
    hit.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => showAt(current));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      const stepBy = e.shiftKey ? 30 : 1;
      let i = current;
      if (e.key === 'ArrowLeft') i = Math.max(0, current - stepBy);
      else if (e.key === 'ArrowRight') i = Math.min(last, current + stepBy);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = last;
      else return;
      e.preventDefault();
      showAt(i);
    });
  }

  const observed = new WeakSet();
  let ro = null;
  function observe(container) {
    if (typeof ResizeObserver !== 'function' || observed.has(container)) return;
    if (!ro) {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const c = entry.target;
          if (c.__chart && c.clientWidth > 0 && c.clientWidth !== c.__lastWidth) draw(c);
        }
      });
    }
    observed.add(container);
    ro.observe(container);
  }

  root.Charts = { renderDonut, renderLineChart };
})(typeof self !== 'undefined' ? self : this);

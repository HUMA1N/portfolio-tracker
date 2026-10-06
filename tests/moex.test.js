const test = require('node:test');
const assert = require('node:assert/strict');
const Moex = require('../js/moex.js');

// Подменяет fetch: маршрутизирует по пути запроса, записывает URL.
function mockFetch(routes) {
  const calls = [];
  Moex.setFetch(async (url) => {
    const u = new URL(url);
    calls.push(u);
    for (const [re, handler] of routes) {
      if (re.test(u.pathname)) {
        const body = typeof handler === 'function' ? handler(u) : handler;
        if (body instanceof Error) throw body;
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  return calls;
}

const block = (columns, data) => ({ columns, data });

test('rows превращает блок ISS в объекты', () => {
  const r = Moex.rows({ x: block(['secid', 'LAST'], [['SBER', 300]]) }, 'x');
  assert.deepEqual(r, [{ SECID: 'SBER', LAST: 300 }]);
  assert.deepEqual(Moex.rows({}, 'x'), []);
});

test('resolveBoard выбирает основной режим рынка акций', async () => {
  const calls = mockFetch([
    [
      /\/securities\/SBER\.json$/,
      {
        boards: block(
          ['secid', 'boardid', 'market', 'engine', 'is_traded', 'is_primary', 'currencyid'],
          [
            ['SBER', 'SMAL', 'shares', 'stock', 1, 0, 'SUR'],
            ['SBER', 'TQBR', 'shares', 'stock', 1, 1, 'SUR'],
            ['SBER', 'RPMA', 'repo', 'stock', 1, 0, 'SUR'],
          ]
        ),
      },
    ],
    [/\/securities\/NOPE\.json$/, { boards: block(['secid', 'boardid'], []) }],
    [/\/securities\/SU26238RMFS4\.json$/, { boards: block(['boardid', 'market', 'engine', 'is_traded', 'is_primary'], [['TQOB', 'bonds', 'stock', 1, 1]]) }],
  ]);
  assert.deepEqual(await Moex.resolveBoard('SBER'), { status: 'ok', board: 'TQBR', currency: 'SUR' });
  assert.equal(calls[0].searchParams.get('iss.meta'), 'off');
  assert.equal(calls[0].searchParams.get('iss.only'), 'boards');
  assert.deepEqual(await Moex.resolveBoard('NOPE'), { status: 'notfound' });
  assert.deepEqual(await Moex.resolveBoard('SU26238RMFS4'), { status: 'unsupported', market: 'bonds' });
});

test('fetchQuotes: LAST, а вне торгов — цена закрытия предыдущего дня', async () => {
  const calls = mockFetch([
    [
      /\/boards\/TQBR\/securities\.json$/,
      {
        securities: block(
          ['SECID', 'BOARDID', 'SHORTNAME', 'PREVPRICE', 'PREVLEGALCLOSEPRICE', 'CURRENCYID'],
          [
            ['SBER', 'TQBR', 'Сбербанк', 299, 299.5, 'SUR'],
            ['GAZP', 'TQBR', 'ГАЗПРОМ ао', 130, 131, 'SUR'],
          ]
        ),
        marketdata: block(
          ['SECID', 'BOARDID', 'LAST', 'LCURRENTPRICE', 'MARKETPRICE', 'SYSTIME'],
          [
            ['SBER', 'TQBR', 301.25, 301.2, 300.9, '2026-10-06 18:45:12'],
            ['GAZP', 'TQBR', null, null, null, '2026-10-06 06:50:00'],
          ]
        ),
      },
    ],
  ]);
  const q = await Moex.fetchQuotes('TQBR', ['SBER', 'GAZP']);
  assert.equal(calls[0].searchParams.get('securities'), 'SBER,GAZP');
  assert.deepEqual(q.SBER, { price: 301.25, kind: 'last', time: '2026-10-06 18:45:12', name: 'Сбербанк', currency: 'SUR' });
  assert.equal(q.GAZP.price, 131);
  assert.equal(q.GAZP.kind, 'prevclose');
});

test('fetchQuotes дробит запрос по 10 бумаг', async () => {
  const calls = mockFetch([[/securities\.json$/, (u) => ({ securities: block(['SECID'], []), marketdata: block(['SECID'], []) })]]);
  const list = Array.from({ length: 23 }, (_, i) => 'T' + i);
  await Moex.fetchQuotes('TQBR', list);
  assert.equal(calls.length, 3);
});

test('fetchCloses листает страницы свечей до конца периода', async () => {
  const days = [];
  for (let d = 1; d <= 30; d++) days.push('2024-01-' + String(d).padStart(2, '0'));
  const PAGE = 12;
  const calls = mockFetch([
    [
      /\/candles\.json$/,
      (u) => {
        const start = Number(u.searchParams.get('start'));
        const slice = days.slice(start, start + PAGE);
        return { candles: block(['open', 'close', 'high', 'low', 'value', 'volume', 'begin', 'end'], slice.map((d, i) => [1, 100 + start + i, 1, 1, 1, 1, d + ' 00:00:00', d + ' 23:59:59'])) };
      },
    ],
  ]);
  const closes = await Moex.fetchCloses('TQBR', 'SBER', '2024-01-01', '2024-01-30');
  assert.equal(closes.length, 30);
  assert.deepEqual(closes[0], ['2024-01-01', 100]);
  assert.deepEqual(closes[29], ['2024-01-30', 129]);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].searchParams.get('interval'), '24');
});

test('сетевой сбой помечается как недоступность API', async () => {
  mockFetch([[/.*/, new TypeError('Failed to fetch')]]);
  await assert.rejects(Moex.resolveBoard('SBER'), (e) => e instanceof Moex.MoexError && e.network === true);
});

test('isRub', () => {
  assert.ok(Moex.isRub('SUR'));
  assert.ok(Moex.isRub(null));
  assert.ok(!Moex.isRub('USD'));
});

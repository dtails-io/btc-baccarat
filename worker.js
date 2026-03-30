const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
// Coinbase Exchange public API — returns recent trades with exact nanosecond timestamps
// No auth required, no US geo-block (it's Coinbase's own US infrastructure)
const TRADES_URL = 'https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=20'
const INTERVAL_MS = 10_000

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY environment variables must be set.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

let lastPrice = null
let lastTickMs = 0  // epoch ms of the last stored tick time

// ── Helpers ──────────────────────────────────────────────────────────────────
function ts()  { return new Date().toISOString() }
function fmt(n) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

// Calculate the :x6:000 tick time that should be used this cycle.
// We fire 500ms AFTER the tick, so the tick is 500ms in the past.
function currentTickTime() {
  const now = new Date()
  const posInCycle = (now.getSeconds() * 1000 + now.getMilliseconds()) % 10_000
  // We fire at :x6.500 so posInCycle ≈ 6500 at fire time
  // The tick itself was at :x6.000 = 500ms ago
  const msAfterTick = posInCycle - 6_000
  const tick = new Date(now.getTime() - msAfterTick)
  tick.setMilliseconds(0)  // snap to exact :x6:000
  return tick
}

// Fetch recent BTC-USD trades and return the price of the trade
// that occurred closest to (but not after) the given tick time.
async function fetchPriceAtTick(tickTime) {
  const res = await fetch(TRADES_URL)
  if (!res.ok) throw new Error(`Coinbase Exchange responded with ${res.status}`)
  const trades = await res.json()

  if (!Array.isArray(trades) || trades.length === 0) {
    throw new Error('No trades returned from Coinbase Exchange')
  }

  const tickMs = tickTime.getTime()

  // Trades are sorted newest first.
  // Find the most recent trade that occurred AT or BEFORE the tick time.
  let best = null
  for (const trade of trades) {
    const tradeMs = new Date(trade.time).getTime()
    if (tradeMs <= tickMs) {
      if (!best || tradeMs > new Date(best.time).getTime()) {
        best = trade
      }
    }
  }

  // Edge case: all returned trades are AFTER the tick (extremely rare — tick
  // just happened and trading was momentarily paused). Use the oldest trade.
  if (!best) {
    best = trades[trades.length - 1]
    console.warn(`${ts()} | All trades post-tick, using oldest available`)
  }

  const ageMs = tickMs - new Date(best.time).getTime()
  console.log(`${ts()} | Trade found ${ageMs}ms before tick (trade_id ${best.trade_id})`)

  return parseFloat(best.price)
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getLastStoredRow() {
  const { data, error } = await supabase
    .from('btc_rounds')
    .select('price_usd, captured_at')
    .order('id', { ascending: false })
    .limit(1)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data || null
}

// ── Main tick handler ─────────────────────────────────────────────────────────
async function fetchAndStore() {
  try {
    const tickTime = currentTickTime()
    const tickMs   = tickTime.getTime()

    // Seed on first run from DB so restarts don't lose continuity
    if (lastPrice === null) {
      const last = await getLastStoredRow()
      if (last) {
        lastPrice  = parseFloat(last.price_usd)
        lastTickMs = new Date(last.captured_at).getTime()
      }
    }

    // Dedup guard — skip if we already recorded this tick (handles brief
    // dual-deployment overlap on Railway redeploys)
    if (tickMs - lastTickMs < 5_000) {
      console.log(`${ts()} | Skipping — tick ${tickTime.toISOString()} already recorded`)
      return
    }

    const price = await fetchPriceAtTick(tickTime)

    if (lastPrice === null) {
      // First ever price — just seed, no outcome yet
      lastPrice  = price
      lastTickMs = tickMs
      console.log(`${ts()} | First price: $${fmt(price)} at ${tickTime.toISOString()} — waiting for next tick`)
      return
    }

    const outcome = price >= lastPrice ? 'player' : 'banker'
    const arrow   = outcome === 'player' ? '▲' : '▼'

    const { error } = await supabase
      .from('btc_rounds')
      .insert({
        captured_at: tickTime.toISOString(),  // exact :x6:000 timestamp
        price_usd:   price,
        outcome
      })

    if (error) {
      console.error(`${ts()} | DB insert error: ${error.message}`)
    } else {
      console.log(`${ts()} | ${tickTime.toISOString()} | $${fmt(price)} ${arrow} ${outcome.toUpperCase()} (prev: $${fmt(lastPrice)})`)
      lastTickMs = tickMs
    }

    lastPrice = price
  } catch (err) {
    console.error(`${ts()} | Error: ${err.message}`)
  }
}

// ── Aligned start ────────────────────────────────────────────────────────────
// Fire 500ms AFTER the :x6 mark so we reliably query trades that occurred
// AT the tick. The trade history lookup then pinpoints the exact price.
function msUntilFirePoint() {
  const now = new Date()
  const posInCycle = (now.getSeconds() * 1000 + now.getMilliseconds()) % 10_000
  const target = 6_500  // :x6.500
  let delay = target - posInCycle
  if (delay <= 0) delay += 10_000
  return delay
}

function startAligned() {
  const delay   = msUntilFirePoint()
  const firesAt = new Date(Date.now() + delay)
  const tickAt  = new Date(firesAt.getTime() - 500)
  console.log(
    `BTC Baccarat worker started.\n` +
    `  Tick target : :${String(tickAt.getSeconds()).padStart(2,'0')}:000\n` +
    `  Fires at    : :${String(firesAt.getSeconds()).padStart(2,'0')}.${String(firesAt.getMilliseconds()).padStart(3,'0')}\n` +
    `  Waiting     : ${(delay / 1000).toFixed(2)}s`
  )

  setTimeout(() => {
    fetchAndStore()
    setInterval(fetchAndStore, INTERVAL_MS)
  }, delay)
}

startAligned()

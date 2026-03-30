const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const COINBASE_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot'
const INTERVAL_MS = 10_000 // 10 seconds

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY environment variables must be set.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

let lastPrice = null

async function fetchBtcPrice() {
  const res = await fetch(COINBASE_URL)
  if (!res.ok) throw new Error(`Coinbase responded with ${res.status}`)
  const json = await res.json()
  return parseFloat(json.data.amount)
}

async function getLastStoredPrice() {
  const { data, error } = await supabase
    .from('btc_rounds')
    .select('price_usd')
    .order('id', { ascending: false })
    .limit(1)
    .single()
  if (error && error.code !== 'PGRST116') throw error
  return data ? parseFloat(data.price_usd) : null
}

async function fetchAndStore() {
  try {
    const price = await fetchBtcPrice()

    if (lastPrice === null) {
      lastPrice = await getLastStoredPrice()
    }

    if (lastPrice === null) {
      lastPrice = price
      console.log(`${ts()} | First price recorded: $${fmt(price)} — waiting for next tick`)
      return
    }

    const outcome = price >= lastPrice ? 'player' : 'banker'

    const { error } = await supabase
      .from('btc_rounds')
      .insert({ price_usd: price, outcome })

    if (error) {
      console.error(`${ts()} | DB insert error: ${error.message}`)
    } else {
      const arrow = outcome === 'player' ? '▲' : '▼'
      console.log(`${ts()} | $${fmt(price)} ${arrow} ${outcome.toUpperCase()} (prev: $${fmt(lastPrice)})`)
    }

    lastPrice = price
  } catch (err) {
    console.error(`${ts()} | Error: ${err.message}`)
  }
}

function ts() {
  return new Date().toISOString()
}

function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Calculate ms until the next :x6 second mark (:06, :16, :26, :36, :46, :56)
function msUntilNextTick() {
  const now = new Date()
  const posInCycle = (now.getSeconds() * 1000 + now.getMilliseconds()) % 10_000
  const target = 6_000
  let delay = target - posInCycle
  if (delay <= 0) delay += 10_000
  return delay
}

function startAligned() {
  const delay = msUntilNextTick()
  const alignsAt = new Date(Date.now() + delay)
  console.log(`BTC Baccarat worker started. Aligning to :${String(alignsAt.getSeconds()).padStart(2, '0')} tick in ${(delay / 1000).toFixed(2)}s...`)

  setTimeout(() => {
    fetchAndStore()
    setInterval(fetchAndStore, INTERVAL_MS)
  }, delay)
}

startAligned()

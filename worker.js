const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'
const INTERVAL_MS = 10_000 // 10 seconds

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_KEY environment variables must be set.')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

let lastPrice = null

async function fetchBtcPrice() {
  const res = await fetch(COINGECKO_URL)
  if (!res.ok) throw new Error(`CoinGecko responded with ${res.status}`)
  const data = await res.json()
  return data.bitcoin.usd
}

async function getLastStoredPrice() {
  const { data, error } = await supabase
    .from('btc_rounds')
    .select('price_usd')
    .order('id', { ascending: false })
    .limit(1)
    .single()
  if (error && error.code !== 'PGRST116') throw error // PGRST116 = no rows
  return data ? parseFloat(data.price_usd) : null
}

async function fetchAndStore() {
  try {
    const price = await fetchBtcPrice()

    // On first run, seed lastPrice from DB (so restarts don't lose continuity)
    if (lastPrice === null) {
      lastPrice = await getLastStoredPrice()
    }

    // If still null (empty table), just record the price with no outcome yet
    if (lastPrice === null) {
      lastPrice = price
      console.log(`${ts()} | First price recorded: $${fmt(price)} — waiting for next tick to determine outcome`)
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

console.log('BTC Baccarat worker started. Fetching every 10 seconds...')
fetchAndStore()
setInterval(fetchAndStore, INTERVAL_MS)

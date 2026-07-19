const axios = require("axios");

// ─────────────────────────────────────────────────────────
// CONFIGURATION
// All values come from Railway environment variables
// ─────────────────────────────────────────────────────────
const CONFIG = {
  oandaApiKey:    process.env.OANDA_API_KEY,
  oandaAccountId: process.env.OANDA_ACCOUNT_ID,
  oandaBase:      process.env.OANDA_BASE_URL || "https://api-fxpractice.oanda.com",
  telegramToken:  process.env.TELEGRAM_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  scanInterval:   5 * 60 * 1000, // scan every 5 minutes
};

// ─────────────────────────────────────────────────────────
// INSTRUMENTS TO MONITOR
// OANDA instrument format: BASE_QUOTE
// Add or remove pairs from this list anytime
// ─────────────────────────────────────────────────────────
const INSTRUMENTS = [
  { name: "XAU_USD",    label: "Gold (XAUUSD)"    },
  { name: "NAS100_USD", label: "Nasdaq (NQ)"       },
  { name: "EUR_USD",    label: "EURUSD"            },
  { name: "GBP_USD",    label: "GBPUSD"            },
  { name: "USD_JPY",    label: "USDJPY"            },
  { name: "NZD_USD",    label: "NZDUSD"            },
  { name: "AUD_USD",    label: "AUDUSD"            },
  { name: "CAD_JPY",    label: "CADJPY"            },
  { name: "GBP_JPY",    label: "GBPJPY"            },
  { name: "EUR_JPY",    label: "EURJPY"            },
  { name: "AUD_JPY",    label: "AUDJPY"            },
  { name: "EUR_GBP",    label: "EURGBP"            },
  { name: "NZD_JPY",    label: "NZDJPY"            },
  { name: "USD_CAD",    label: "USDCAD"            },
  { name: "CHF_JPY",    label: "CHFJPY"            },
];

// ─────────────────────────────────────────────────────────
// TIMEFRAME CONFIGURATIONS
// alertMinutesBefore = how many minutes before close to send alert
// ─────────────────────────────────────────────────────────
const TIMEFRAMES = [
  {
    name:               "4HR",
    granularity:        "H4",
    candleMinutes:      240,
    alertMinutesBefore: 15,
  },
  {
    name:               "Daily",
    granularity:        "D",
    candleMinutes:      1440,
    alertMinutesBefore: 60,
  },
  {
    name:               "Weekly",
    granularity:        "W",
    candleMinutes:      10080,
    alertMinutesBefore: 240,
  },
];

// Track sent alerts to avoid duplicates within same candle
const alertsSent = new Set();

// ─────────────────────────────────────────────────────────
// OANDA API — Fetch candles
// Returns array of candle objects with OHLC data
// ─────────────────────────────────────────────────────────
async function getCandles(instrument, granularity, count = 10) {
  try {
    const response = await axios.get(
      `${CONFIG.oandaBase}/v3/instruments/${instrument}/candles`,
      {
        headers: {
          Authorization:  `Bearer ${CONFIG.oandaApiKey}`,
          "Content-Type": "application/json",
        },
        params: {
          granularity,
          count,
          price: "M", // midpoint (average of bid and ask)
        },
        timeout: 10000,
      }
    );

    return response.data.candles;
  } catch (err) {
    if (err.response?.status === 401) {
      console.error("❌ OANDA API key invalid. Check OANDA_API_KEY env variable.");
    } else if (err.response?.status === 404) {
      console.error(`❌ Instrument not found: ${instrument}`);
    } else {
      console.error(`⚠️  Error fetching ${instrument} ${granularity}: ${err.message}`);
    }
    return [];
  }
}

// ─────────────────────────────────────────────────────────
// DETECT FVG ZONES
// Scans closed candles for Fair Value Gap patterns
// Returns array of FVG objects with zone boundaries
// ─────────────────────────────────────────────────────────
function detectFVGs(candles) {
  const fvgs = [];

  for (let i = 0; i < candles.length - 2; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c3 = candles[i + 2];

    // Only use fully closed candles
    if (!c1.complete || !c2.complete || !c3.complete) continue;

    const c1High = parseFloat(c1.mid.h);
    const c1Low  = parseFloat(c1.mid.l);
    const c3High = parseFloat(c3.mid.h);
    const c3Low  = parseFloat(c3.mid.l);

    // ── BULLISH FVG ──
    // c3 low is ABOVE c1 high — upward impulse left a gap
    if (c3Low > c1High) {
      fvgs.push({
        type:      "BULLISH",
        top:       c3Low,
        bottom:    c1High,
        midpoint:  (c3Low + c1High) / 2,
        size:      c3Low - c1High,
        candleIdx: i + 2,
        time:      c2.time,
      });
    }

    // ── BEARISH FVG ──
    // c3 high is BELOW c1 low — downward impulse left a gap
    if (c3High < c1Low) {
      fvgs.push({
        type:      "BEARISH",
        top:       c1Low,
        bottom:    c3High,
        midpoint:  (c1Low + c3High) / 2,
        size:      c1Low - c3High,
        candleIdx: i + 2,
        time:      c2.time,
      });
    }
  }

  return fvgs;
}

// ─────────────────────────────────────────────────────────
// CHECK REJECTION CONDITION ON LIVE CANDLE
//
// YOUR EXACT RULE:
// 1. The retracing candle can be ANY colour — bullish, bearish, doji
//    Candle colour does not matter at all
//
// 2. The candle must have entered the FVG zone at some point
//    (wick or body touched inside the zone)
//
// 3. The BODY must be closing OUTSIDE the FVG boundary:
//    Bearish FVG → body BOTTOM closes BELOW FVG bottom
//                  (body bottom is below the zone, regardless of body top)
//    Bullish FVG → body TOP closes ABOVE FVG top
//                  (body top is above the zone, regardless of body bottom)
//
// Only the body bottom (bearish) or body top (bullish) matters.
// The other side of the body can be anywhere — inside or outside the zone.
// ─────────────────────────────────────────────────────────
function checkRejection(liveCandle, fvg) {
  const open  = parseFloat(liveCandle.mid.o);
  const close = parseFloat(liveCandle.mid.c);
  const high  = parseFloat(liveCandle.mid.h);
  const low   = parseFloat(liveCandle.mid.l);

  // Body boundaries — works for any candle colour
  const bodyTop    = Math.max(open, close);
  const bodyBottom = Math.min(open, close);

  // Candle must have entered the FVG zone at any point
  // (either wick or body reached inside the zone)
  const enteredZone = high >= fvg.bottom && low <= fvg.top;
  if (!enteredZone) return null;

  // ── BEARISH FVG REJECTION ──
  // Any candle colour is valid
  // Only condition: body BOTTOM is closing BELOW FVG bottom
  // Body top position does not matter — can be anywhere
  if (fvg.type === "BEARISH") {
    if (bodyBottom < fvg.bottom) {
      return {
        direction:    "BEARISH",
        fvgTop:       fvg.top,
        fvgBottom:    fvg.bottom,
        fvgSize:      fvg.size,
        bodyTop,
        bodyBottom,
        currentClose: close,
        signal: "Body closing BELOW bearish FVG bottom → bearish continuation",
      };
    }
  }

  // ── BULLISH FVG REJECTION ──
  // Any candle colour is valid
  // Only condition: body TOP is closing ABOVE FVG top
  // Body bottom position does not matter — can be anywhere
  if (fvg.type === "BULLISH") {
    if (bodyTop > fvg.top) {
      return {
        direction:    "BULLISH",
        fvgTop:       fvg.top,
        fvgBottom:    fvg.bottom,
        fvgSize:      fvg.size,
        bodyTop,
        bodyBottom,
        currentClose: close,
        signal: "Body closing ABOVE bullish FVG top → bullish continuation",
      };
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────
// CALCULATE MINUTES REMAINING UNTIL CANDLE CLOSE
// ─────────────────────────────────────────────────────────
function minutesToClose(candleMinutes) {
  const nowMs      = Date.now();
  const periodMs   = candleMinutes * 60 * 1000;
  const closeMs    = Math.ceil(nowMs / periodMs) * periodMs;
  const remaining  = Math.floor((closeMs - nowMs) / 60000);
  return remaining;
}

// ─────────────────────────────────────────────────────────
// FORMAT TELEGRAM MESSAGE
// ─────────────────────────────────────────────────────────
function formatMessage(instrument, tf, rejection, minutesLeft) {
  const isBear  = rejection.direction === "BEARISH";
  const emoji   = isBear ? "🔴" : "🟢";
  const arrow   = isBear ? "⬇️" : "⬆️";
  const action  = isBear ? "Look for SHORT entry at candle close" : "Look for LONG entry at candle close";

  // Format numbers nicely
  const fmt = (n) => {
    if (n > 100) return n.toFixed(2);   // Gold, NAS100
    return n.toFixed(5);                 // Forex pairs
  };

  return (
    `${emoji} <b>FVG REJECTION ALERT</b> ${arrow}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>Pair:</b> ${instrument.label}\n` +
    `<b>Timeframe:</b> ${tf.name}\n` +
    `<b>Direction:</b> ${rejection.direction}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `<b>FVG Zone:</b>\n` +
    `  Top:    ${fmt(rejection.fvgTop)}\n` +
    `  Bottom: ${fmt(rejection.fvgBottom)}\n` +
    `<b>Candle Body:</b>\n` +
    `  Top:    ${fmt(rejection.bodyTop)}\n` +
    `  Bottom: ${fmt(rejection.bodyBottom)}\n` +
    `<b>Current close:</b> ${fmt(rejection.currentClose)}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `⏰ <b>${minutesLeft} min to ${tf.name} candle close</b>\n` +
    `📋 ${action}\n` +
    `<i>${rejection.signal}</i>`
  );
}

// ─────────────────────────────────────────────────────────
// SEND TELEGRAM MESSAGE
// ─────────────────────────────────────────────────────────
async function sendTelegram(text) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`,
      {
        chat_id:    CONFIG.telegramChatId,
        text,
        parse_mode: "HTML",
      },
      { timeout: 10000 }
    );
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────
// MAIN SCAN LOOP
// Runs every 5 minutes
// For each instrument + timeframe combination:
//   1. Check if we are in the alert window
//   2. Fetch candles from OANDA
//   3. Detect FVGs in closed candles
//   4. Check if live candle is rejecting an FVG with its body
//   5. Send Telegram alert if condition met
// ─────────────────────────────────────────────────────────
async function scan() {
  const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  console.log(`\n[${timestamp}] 🔍 Scanning ${INSTRUMENTS.length} pairs × ${TIMEFRAMES.length} timeframes...`);

  let alertsFiredThisScan = 0;

  for (const instrument of INSTRUMENTS) {
    for (const tf of TIMEFRAMES) {
      try {
        // Check minutes remaining on current candle
        const minsLeft = minutesToClose(tf.candleMinutes);

        // Skip if outside alert window
        if (minsLeft > tf.alertMinutesBefore || minsLeft <= 0) continue;

        // Build unique key for this candle to prevent duplicate alerts
        const candleEpoch = Math.floor(Date.now() / (tf.candleMinutes * 60000));
        const alertKey    = `${instrument.name}_${tf.granularity}_${candleEpoch}`;

        if (alertsSent.has(alertKey)) continue;

        console.log(`  ⏱  ${instrument.label} ${tf.name} — ${minsLeft}min to close, checking FVGs...`);

        // Fetch 9 candles (8 closed + 1 live forming candle)
        const allCandles = await getCandles(instrument.name, tf.granularity, 9);
        if (allCandles.length < 4) continue;

        // Split into closed and live
        const closed = allCandles.filter((c) => c.complete);
        const live   = allCandles.find((c) => !c.complete);
        if (!live || closed.length < 3) continue;

        // Detect FVGs in closed candles
        const fvgs = detectFVGs(closed);
        if (fvgs.length === 0) continue;

        // Only check most recent FVG (formed in last 3 closed candles)
        const recentFVGs = fvgs.filter(
          (f) => f.candleIdx >= closed.length - 3
        );
        if (recentFVGs.length === 0) continue;

        // Check each recent FVG for rejection on live candle
        for (const fvg of recentFVGs) {
          const rejection = checkRejection(live, fvg);

          if (rejection) {
            const message = formatMessage(instrument, tf, rejection, minsLeft);
            await sendTelegram(message);
            alertsSent.add(alertKey);
            alertsFiredThisScan++;

            console.log(
              `  ✅ ALERT SENT: ${instrument.label} ${tf.name} — ${rejection.direction} FVG rejection`
            );
            break;
          }
        }

        // 300ms delay between API calls — respects OANDA rate limits
        await new Promise((r) => setTimeout(r, 300));

      } catch (err) {
        console.error(`  ❌ Error on ${instrument.name} ${tf.name}:`, err.message);
      }
    }
  }

  if (alertsFiredThisScan === 0) {
    console.log("  ℹ️  No FVG rejections detected this scan.");
  } else {
    console.log(`  📨 ${alertsFiredThisScan} alert(s) sent this scan.`);
  }

  // Clean up old alert keys (older than 3 weeks) to prevent memory leak
  const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1000;
  for (const key of alertsSent) {
    const parts    = key.split("_");
    const epoch    = parseInt(parts[parts.length - 1]);
    const tfConfig = TIMEFRAMES.find((t) => key.includes(t.granularity));
    if (tfConfig) {
      const epochMs = epoch * tfConfig.candleMinutes * 60 * 1000;
      if (epochMs < cutoff) alertsSent.delete(key);
    }
  }
}

// ─────────────────────────────────────────────────────────
// VALIDATE CONFIG ON STARTUP
// ─────────────────────────────────────────────────────────
function validateConfig() {
  const required = [
    ["OANDA_API_KEY",    CONFIG.oandaApiKey],
    ["OANDA_ACCOUNT_ID", CONFIG.oandaAccountId],
    ["TELEGRAM_TOKEN",   CONFIG.telegramToken],
    ["TELEGRAM_CHAT_ID", CONFIG.telegramChatId],
  ];

  const missing = required.filter(([, v]) => !v).map(([k]) => k);

  if (missing.length > 0) {
    console.error("❌ Missing environment variables:", missing.join(", "));
    console.error("   Add them in Railway → Variables tab");
    process.exit(1);
  }

  console.log("✅ All environment variables loaded");
}

// ─────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────
async function start() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🤖  FVG Alert Bot — Starting up");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  validateConfig();

  console.log(`📊  Monitoring ${INSTRUMENTS.length} instruments:`);
  INSTRUMENTS.forEach((i) => console.log(`    • ${i.label}`));
  console.log(`⏱️   Timeframes: 4HR (alert 15min before), Daily (60min before), Weekly (240min before)`);
  console.log(`🔄  Scan interval: every 5 minutes`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Send startup confirmation to Telegram
  const startMsg =
    `🤖 <b>FVG Alert Bot is Online</b>\n\n` +
    `Monitoring <b>${INSTRUMENTS.length} pairs</b> across:\n` +
    `• 4HR — alert 15min before close\n` +
    `• Daily — alert 60min before close\n` +
    `• Weekly — alert 240min before close\n\n` +
    `<b>Alert condition:</b>\n` +
    `Candle wick enters FVG zone AND body closes outside zone\n\n` +
    `<i>Bot will notify you before each qualifying candle close.</i>`;

  await sendTelegram(startMsg);

  // Run first scan immediately
  await scan();

  // Then scan every 5 minutes
  setInterval(scan, CONFIG.scanInterval);
}

// Handle unexpected errors gracefully
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
});

start();

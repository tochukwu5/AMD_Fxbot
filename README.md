# FVG Alert Bot

Monitors 15 forex pairs and assets across **4HR, Daily and Weekly** timeframes using the OANDA API. Sends Telegram alerts when a candle body is rejecting an FVG zone before candle close — giving you time to prepare and manually enter the trade.

## Alert Logic
1. FVG forms in recent closed candles
2. Current live candle enters the FVG zone (wick goes in)
3. Candle **body** (not just wick) is closing outside the FVG
4. Alert fires X minutes before the candle closes

## Alert Timing
| Timeframe | Alert fires |
|-----------|------------|
| 4HR | 15 minutes before close |
| Daily | 60 minutes before close |
| Weekly | 240 minutes before close |

## Instruments Monitored
Gold, NAS100, EURUSD, GBPUSD, USDJPY, NZDUSD, AUDUSD, CADJPY, GBPJPY, EURJPY, AUDJPY, EURGBP, NZDJPY, USDCAD, CHFJPY

---

## Deployment Guide

### Step 1 — Create OANDA Practice Account
1. Go to https://oanda.com
2. Click **Open a Demo Account** (completely free)
3. Fill the form and verify your email
4. Log into your dashboard
5. Click your name top right → **Manage API Access**
6. Click **Generate** next to API token
7. **Copy and save the token** — you only see it once
8. Copy your **Account ID** shown on the dashboard (format: 101-001-XXXXXXX-001)

### Step 2 — Create Telegram Bot
1. Open Telegram on your phone
2. Search for **@BotFather** and open it
3. Send the message: `/newbot`
4. BotFather asks for a name — type anything e.g. `FVG Alert Bot`
5. BotFather asks for a username — type anything ending in bot e.g. `tochi_fvg_bot`
6. BotFather gives you a **token** like `7234567890:AAFxxxxxxxxxxxxxxxxxx`
7. **Copy and save this token**
8. Now search for your new bot by its username and open it
9. Press **START** or send any message to it
10. Open this URL in your phone browser (replace YOUR_TOKEN):
    `https://api.telegram.org/botYOUR_TOKEN/getUpdates`
11. You will see JSON — find the number next to `"id":` inside the `"chat"` object
12. **Copy and save that number** — that is your TELEGRAM_CHAT_ID

### Step 3 — Upload Code to GitHub
1. Go to https://github.com and sign in (or create free account)
2. Click the **+** button top right → **New repository**
3. Name it `fvg-alert-bot`
4. Set to **Private** (important — keeps your API keys safe)
5. Click **Create repository**
6. On the next screen click **uploading an existing file**
7. Drag and drop these files:
   - `index.js`
   - `package.json`
   - `.gitignore`
8. Click **Commit changes**

### Step 4 — Deploy on Railway
1. Go to https://railway.app
2. Sign in with your GitHub account
3. Click **New Project**
4. Click **Deploy from GitHub repo**
5. Select your `fvg-alert-bot` repository
6. Railway detects Node.js automatically and starts deploying
7. Wait for the build to finish (about 60 seconds)
8. Click on your project → click the **Variables** tab
9. Add these 4 variables one by one:

| Variable Name | Value |
|--------------|-------|
| OANDA_API_KEY | your oanda api token |
| OANDA_ACCOUNT_ID | your oanda account id |
| TELEGRAM_TOKEN | your telegram bot token |
| TELEGRAM_CHAT_ID | your telegram chat id number |
| OANDA_BASE_URL | https://api-fxpractice.oanda.com |

10. After adding variables Railway automatically restarts the bot
11. Check your Telegram — you should receive the startup message within 30 seconds

### Step 5 — Verify It Works
- Your Telegram receives: **"FVG Alert Bot is Online"**
- Check Railway → **Deployments** → **Logs** to see the scan output
- The bot scans every 5 minutes and logs results

---

## Customising the Bot

### Add or remove pairs
Edit the `INSTRUMENTS` array in `index.js`:
```js
{ name: "EUR_CHF", label: "EURCHF" },
```

### Change alert timing
Edit the `alertMinutesBefore` values in `TIMEFRAMES`:
```js
{ name: "4HR", granularity: "H4", candleMinutes: 240, alertMinutesBefore: 20 }
```

### Switch to live OANDA account
Change OANDA_BASE_URL environment variable to:
`https://api-fxtrade.oanda.com`

---

## OANDA Instrument Names Reference
| Pair | OANDA Name |
|------|-----------|
| Gold | XAU_USD |
| Nasdaq NQ | NAS100_USD |
| EURUSD | EUR_USD |
| GBPUSD | GBP_USD |
| USDJPY | USD_JPY |
| NZDUSD | NZD_USD |
| AUDUSD | AUD_USD |
| USDCAD | USD_CAD |
| GBPJPY | GBP_JPY |
| EURJPY | EUR_JPY |
| AUDJPY | AUD_JPY |
| CADJPY | CAD_JPY |
| NZDJPY | NZD_JPY |
| EURGBP | EUR_GBP |
| CHFJPY | CHF_JPY |

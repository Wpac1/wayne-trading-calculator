"""
Download OHLCV data from Yahoo Finance for any symbol.
Saves to data/gold/ as CSV.

Usage:
    py scripts/download_data.py                              # XAUUSD, last 60d, 15m
    py scripts/download_data.py --symbol US30                # Dow Jones
    py scripts/download_data.py --symbol NAS100 --interval 15m
    py scripts/download_data.py --symbol XAUUSD --period 2y --interval 1d
    py scripts/download_data.py --symbol BTCUSD --interval 1h --start 2025-01-01
    py scripts/download_data.py --symbol MYNAME:GC=F         # raw Yahoo ticker override
"""

import argparse
import json
import sys
from pathlib import Path
from datetime import datetime, timezone

try:
    import yfinance as yf
except ImportError:
    print("yfinance not installed. Run: pip install yfinance")
    sys.exit(1)

try:
    import pandas as pd
except ImportError:
    print("pandas not installed. Run: pip install pandas")
    sys.exit(1)


TICKER_MAP = {
    "XAUUSD":  "GC=F",       # Gold Futures (front-month)
    "XAGUSD":  "SI=F",       # Silver Futures
    "US30":    "YM=F",       # Dow Jones Futures
    "NAS100":  "NQ=F",       # NASDAQ-100 Futures
    "US500":   "ES=F",       # S&P 500 Futures
    "USOIL":   "CL=F",       # Crude Oil WTI Futures
    "EURUSD":  "EURUSD=X",
    "GBPUSD":  "GBPUSD=X",
    "USDJPY":  "USDJPY=X",
    "AUDUSD":  "AUDUSD=X",
    "USDCAD":  "USDCAD=X",
    "BTCUSD":  "BTC-USD",
    "ETHUSD":  "ETH-USD",
}

VALID_INTERVALS = ["1m","2m","5m","15m","30m","60m","1h","90m","1d","5d","1wk","1mo","3mo"]
VALID_PERIODS   = ["1d","5d","1mo","3mo","6mo","1y","2y","5y","10y","ytd","max"]

DATA_DIR = Path(__file__).parent.parent / "data" / "gold"


def parse_args():
    p = argparse.ArgumentParser(description="Download OHLCV data from Yahoo Finance")
    p.add_argument("--symbol",   default="XAUUSD",
                   help=f"Symbol to download. Known: {', '.join(TICKER_MAP.keys())}. "
                        "Or pass 'NAME:YAHOO_TICKER' for a custom mapping.")
    p.add_argument("--interval", default="15m", choices=VALID_INTERVALS,
                   help="Bar interval (default: 15m)")
    p.add_argument("--period",   default=None, choices=VALID_PERIODS,
                   help="Lookback period (e.g. 1y). Ignored if --start is set.")
    p.add_argument("--start",    default=None,
                   help="Start date YYYY-MM-DD (overrides --period)")
    p.add_argument("--end",      default=None,
                   help="End date YYYY-MM-DD (default: today)")
    p.add_argument("--out",      default=None,
                   help="Output filename (auto-generated if omitted)")
    return p.parse_args()


def resolve_ticker(raw: str) -> tuple:
    """Return (clean_symbol, yahoo_ticker). Accepts 'XAUUSD' or 'MYNAME:GC=F'."""
    if ":" in raw:
        name, ticker = raw.split(":", 1)
        return name.upper(), ticker
    up = raw.upper()
    return up, TICKER_MAP.get(up, up)


def default_period(interval: str) -> str:
    """Pick a sensible default period for the given interval."""
    if interval in ("1m",):            return "7d"
    if interval in ("2m","5m","15m",
                    "30m","60m","1h",
                    "90m"):            return "60d"
    return "1y"


def build_filename(symbol: str, interval: str, start, end, period) -> str:
    today = datetime.today().strftime("%Y%m%d")
    if start:
        s = start.replace("-", "")
        e = (end or datetime.today().strftime("%Y-%m-%d")).replace("-", "")
        return f"{symbol}_{interval}_{s}_{e}.csv"
    return f"{symbol}_{interval}_{period or default_period(interval)}_{today}.csv"


def download(ticker: str, interval: str, period, start, end):
    obj = yf.Ticker(ticker)
    kwargs = {"interval": interval, "auto_adjust": True}
    if start:
        kwargs["start"] = start
        if end:
            kwargs["end"] = end
    else:
        kwargs["period"] = period or default_period(interval)

    df = obj.history(**kwargs)
    if df.empty:
        print(f"No data returned. Yahoo may not support '{interval}' for this date range.")
        print("Note: intraday intervals (< 1d) are limited to ~60 days of history.")
        sys.exit(1)

    df.index.name = "datetime"
    df.columns    = [c.lower() for c in df.columns]
    df            = df[["open", "high", "low", "close", "volume"]].copy()
    df.index      = pd.to_datetime(df.index)
    return df


def main():
    args   = parse_args()
    symbol, ticker = resolve_ticker(args.symbol)

    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Downloading  symbol={symbol}  ticker={ticker}  interval={args.interval}", end="")
    if args.start:
        print(f"  start={args.start}" + (f"  end={args.end}" if args.end else ""), end="")
    else:
        print(f"  period={args.period or default_period(args.interval)}", end="")
    print(" …")

    df = download(ticker, args.interval, args.period, args.start, args.end)

    filename = args.out or build_filename(symbol, args.interval, args.start, args.end, args.period)
    out_path = DATA_DIR / filename

    df.to_csv(out_path)
    print(f"Saved {len(df):,} rows  ->  {out_path}")
    print(f"Date range: {df.index[0]}  to  {df.index[-1]}")
    print(df.tail(3).to_string())
    write_gold_index(DATA_DIR)


def write_gold_index(gold_dir: Path):
    """Write data/gold/index.json so the browser can discover all CSV files."""
    files = []
    for f in sorted(gold_dir.glob("*.csv")):
        parts  = f.stem.split("_")
        symbol = parts[0].upper() if parts else f.stem.upper()
        files.append({"file": f.name, "symbol": symbol})
    index = {
        "files":   files,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    out = gold_dir / "index.json"
    out.write_text(json.dumps(index, indent=2), encoding="utf-8")
    print(f"  index  data/gold/index.json  ({len(files)} file(s))")


if __name__ == "__main__":
    main()

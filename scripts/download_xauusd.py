"""
Download XAUUSD (Gold/USD spot) OHLCV data from Yahoo Finance.
Saves to ../data/ as CSV.

Usage:
    python download_xauusd.py                        # last 1 year, daily
    python download_xauusd.py --period 2y            # last 2 years, daily
    python download_xauusd.py --interval 1h          # last 60 days, hourly
    python download_xauusd.py --start 2024-01-01 --end 2025-01-01
    python download_xauusd.py --interval 1h --start 2025-01-01
"""

import argparse
import sys
from pathlib import Path
from datetime import datetime

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


TICKER = "GC=F"  # Gold Futures (front-month) — closest proxy to XAUUSD spot on Yahoo Finance

VALID_INTERVALS = ["1m", "2m", "5m", "15m", "30m", "60m", "1h", "90m", "1d", "5d", "1wk", "1mo", "3mo"]
VALID_PERIODS   = ["1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"]

DATA_DIR = Path(__file__).parent.parent / "data"


def parse_args():
    p = argparse.ArgumentParser(description="Download XAUUSD data from Yahoo Finance")
    p.add_argument("--interval", default="1d", choices=VALID_INTERVALS,
                   help="Bar interval (default: 1d)")
    p.add_argument("--period", default=None, choices=VALID_PERIODS,
                   help="Lookback period (e.g. 1y). Ignored if --start is set.")
    p.add_argument("--start", default=None,
                   help="Start date YYYY-MM-DD (overrides --period)")
    p.add_argument("--end", default=None,
                   help="End date YYYY-MM-DD (default: today)")
    p.add_argument("--out", default=None,
                   help="Output filename (auto-generated if omitted)")
    return p.parse_args()


def build_filename(interval: str, start: str | None, end: str | None, period: str | None) -> str:
    today = datetime.today().strftime("%Y%m%d")
    if start:
        s = start.replace("-", "")
        e = (end or datetime.today().strftime("%Y-%m-%d")).replace("-", "")
        return f"XAUUSD_{interval}_{s}_{e}.csv"
    return f"XAUUSD_{interval}_{period or '1y'}_{today}.csv"


def download(interval: str, period: str | None, start: str | None, end: str | None) -> pd.DataFrame:
    ticker = yf.Ticker(TICKER)

    kwargs = {"interval": interval, "auto_adjust": True}

    if start:
        kwargs["start"] = start
        if end:
            kwargs["end"] = end
    else:
        kwargs["period"] = period or "1y"

    df = ticker.history(**kwargs)

    if df.empty:
        print(f"No data returned. Yahoo Finance may not support '{interval}' for this date range.")
        print("Note: intraday intervals (< 1d) are limited to ~60 days of history.")
        sys.exit(1)

    # Normalise column names
    df.index.name = "datetime"
    df.columns = [c.lower() for c in df.columns]
    df = df[["open", "high", "low", "close", "volume"]].copy()
    df.index = pd.to_datetime(df.index)

    return df


def main():
    args = parse_args()
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Downloading {TICKER} (XAUUSD proxy)  interval={args.interval}", end="")
    if args.start:
        print(f"  start={args.start}" + (f"  end={args.end}" if args.end else ""), end="")
    else:
        print(f"  period={args.period or '1y'}", end="")
    print(" …")

    df = download(args.interval, args.period, args.start, args.end)

    filename = args.out or build_filename(args.interval, args.start, args.end, args.period)
    out_path = DATA_DIR / filename

    df.to_csv(out_path)
    print(f"Saved {len(df):,} rows -> {out_path}")
    print(f"Date range: {df.index[0]}  to  {df.index[-1]}")
    print(df.tail(3).to_string())


if __name__ == "__main__":
    main()

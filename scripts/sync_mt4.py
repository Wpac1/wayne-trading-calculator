"""
Sync ALL MT4 EA exports from MT4 Common/Files into the project data folder.

Auto-discovers every CSV in Common/Files:
  - Statement files (start with # ACCOUNT_SUMMARY) -> data/statement/
  - Everything else (OHLCV)                        -> data/gold/

Run manually:
    py scripts/sync_mt4.py

Or trigger via the dashboard Sync MT4 button (requires py server.py).
"""

import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

MT4_COMMON  = Path.home() / "AppData/Roaming/MetaQuotes/Terminal/Common/Files"
DATA_DIR    = Path(__file__).parent.parent / "data"
GOLD_DIR    = DATA_DIR / "gold"
STMT_DIR    = DATA_DIR / "statement"
SIGNAL_DIR  = DATA_DIR / "signals"   # bot signal / done / error files live here


def _is_statement(path: Path) -> bool:
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.readline().strip().startswith("# ACCOUNT_SUMMARY")
    except Exception:
        return False


def _is_signal_file(path: Path) -> bool:
    """Signal bridge files (wayne_signal/done/error) — not price data."""
    return path.stem.lower().startswith("wayne_")


def sync():
    if not MT4_COMMON.exists():
        print(f"MT4 Common/Files not found: {MT4_COMMON}")
        sys.exit(1)

    csv_files = [f for f in MT4_COMMON.iterdir() if f.suffix.lower() == ".csv"]
    if not csv_files:
        print(f"No CSV files found in {MT4_COMMON}")
        sys.exit(1)

    any_copied = False
    for src in sorted(csv_files):
        if _is_statement(src):
            dst = STMT_DIR / src.name
        elif _is_signal_file(src):
            dst = SIGNAL_DIR / src.name
        else:
            dst = GOLD_DIR / src.name

        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        size_kb = dst.stat().st_size / 1024
        tag = "stmt" if dst.parent == STMT_DIR else ("sig" if dst.parent == SIGNAL_DIR else "ohlcv")
        print(f"  OK  [{tag}]  {src.name}  ->  {dst.relative_to(DATA_DIR.parent)}  ({size_kb:.1f} KB)")
        any_copied = True

    if not any_copied:
        print("Nothing copied.")
        sys.exit(1)

    write_gold_index(GOLD_DIR)


def write_gold_index(gold_dir: Path):
    """Write data/gold/index.json so the browser can discover all CSV files."""
    files = []
    for f in sorted(gold_dir.glob("*.csv")):
        if _is_signal_file(f):
            continue  # skip any signal/done/error files that slipped in
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
    print(f"Syncing MT4 Common/Files -> {DATA_DIR}\n")
    sync()
    print("\nDone.")

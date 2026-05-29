"""
write_signal.py  —  Signal bridge: web app → MT4 Common/Files

Usage (called by server.py):
    py write_signal.py --write  < signal_json
    py write_signal.py --status --id <signal_id>
"""

import argparse
import json
import os
import sys
from pathlib import Path

# MT4 Common/Files is always under %APPDATA%\MetaQuotes\Terminal\Common\Files
def get_mt4_common() -> Path:
    appdata = os.environ.get('APPDATA', '')
    return Path(appdata) / 'MetaQuotes' / 'Terminal' / 'Common' / 'Files'


def write_signal(sig: dict) -> dict:
    sig_id  = str(sig.get('id', ''))
    fname   = f"wayne_signal_{sig_id}.csv"

    lines = [
        f"SYMBOL={sig.get('symbol','').upper()}",
        f"DIRECTION={sig.get('dir','').upper()}",
        f"ORDER_TYPE={sig.get('orderType','PENDING').upper()}",
        f"ENTRY={float(sig.get('entry', 0)):.5f}",
        f"SL={float(sig.get('sl', 0)):.5f}",
        f"TP={float(sig.get('tp', 0)):.5f}",
        f"LOT={float(sig.get('lot', 0.01)):.2f}",
        f"MAGIC={sig_id}",
        f"ID={sig_id}",
        f"TIMESTAMP={sig.get('timestamp', '')}",
        f"STATUS=NEW",
    ]
    content = '\n'.join(lines) + '\n'

    # Write to MT4 Common/Files
    mt4_dir = get_mt4_common()
    mt4_dir.mkdir(parents=True, exist_ok=True)
    mt4_path = mt4_dir / fname
    mt4_path.write_text(content, encoding='ascii')

    # Mirror to local data/signals/
    local_dir = Path(__file__).parent.parent / 'data' / 'signals'
    local_dir.mkdir(parents=True, exist_ok=True)
    (local_dir / fname).write_text(content, encoding='ascii')

    return {'ok': True, 'file': fname, 'path': str(mt4_path)}


def check_status(sig_id: str) -> dict:
    mt4_dir = get_mt4_common()
    sig_id  = str(sig_id)

    # Scan for done file: wayne_done_{ticket}_{id}.csv
    for f in mt4_dir.glob(f'wayne_done_*_{sig_id}.csv'):
        data = _parse_kv(f)
        return {
            'status':    'EXECUTED',
            'ticket':    data.get('TICKET', ''),
            'fillPrice': data.get('FILL_PRICE', ''),
            'id':        sig_id,
        }

    # Scan for error file: wayne_error_{id}.csv
    err_file = mt4_dir / f'wayne_error_{sig_id}.csv'
    if err_file.exists():
        data = _parse_kv(err_file)
        return {
            'status': 'ERROR',
            'reason': data.get('REASON', 'Unknown error'),
            'id':     sig_id,
        }

    # Signal file still waiting
    sig_file = mt4_dir / f'wayne_signal_{sig_id}.csv'
    if sig_file.exists():
        return {'status': 'PENDING', 'id': sig_id}

    # File gone but no done/error — treat as pending (EA may still be processing)
    return {'status': 'PENDING', 'id': sig_id}


def _parse_kv(path: Path) -> dict:
    result = {}
    try:
        for line in path.read_text(encoding='ascii', errors='ignore').splitlines():
            if '=' in line:
                k, _, v = line.partition('=')
                result[k.strip()] = v.strip()
    except Exception:
        pass
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--write',  action='store_true', help='Read signal JSON from stdin and write file')
    p.add_argument('--status', action='store_true', help='Check execution status of a signal')
    p.add_argument('--id',     default='',          help='Signal ID for status check')
    args = p.parse_args()

    if args.write:
        raw = sys.stdin.read().strip()
        try:
            sig = json.loads(raw)
        except json.JSONDecodeError as e:
            print(json.dumps({'ok': False, 'error': f'JSON parse error: {e}'}))
            sys.exit(1)
        result = write_signal(sig)
        print(json.dumps(result))

    elif args.status:
        result = check_status(args.id)
        print(json.dumps(result))

    else:
        p.print_help()
        sys.exit(1)


if __name__ == '__main__':
    main()

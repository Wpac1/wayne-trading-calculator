"""
Wayne Trading Terminal — local dev server.

Serves the app at http://localhost:5500
Provides:
  POST /api/sync    → runs scripts/sync_mt4.py
  GET  /api/symbols → lists CSVs in data/gold/

Usage:
    py server.py
"""

import http.server
import json
import subprocess
import sys
import os
from pathlib import Path

PORT         = 5500
PROJECT_ROOT = Path(__file__).parent


class Handler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path == '/api/symbols':
            result = _list_symbols()
        elif self.path.startswith('/api/signal/status'):
            sig_id = ''
            if '?id=' in self.path:
                sig_id = self.path.split('?id=', 1)[1].split('&', 1)[0]
            result = _signal_status(sig_id)
        else:
            super().do_GET()
            return
        body = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Type',   'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body   = self.rfile.read(length) if length else b''

        if self.path == '/api/sync':
            result = _run_sync()
        elif self.path == '/api/signal/write':
            result = _write_signal(body)
        else:
            self.send_response(404)
            self.end_headers()
            return

        resp = json.dumps(result).encode()
        self.send_response(200)
        self.send_header('Content-Type',   'application/json')
        self.send_header('Content-Length', str(len(resp)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(resp)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.end_headers()

    def log_message(self, fmt, *args):
        pass  # suppress per-request noise


def _list_symbols():
    gold_dir = PROJECT_ROOT / 'data' / 'gold'
    files = []
    if gold_dir.exists():
        for f in sorted(gold_dir.glob('*.csv')):
            if f.stem.lower().startswith('wayne_'):
                continue  # signal / done / error files — not price data
            parts  = f.stem.split('_')
            symbol = parts[0].upper() if parts else f.stem.upper()
            files.append({'file': f.name, 'symbol': symbol})
    return {'files': files}


def _write_signal(body: bytes) -> dict:
    script = PROJECT_ROOT / 'scripts' / 'write_signal.py'
    try:
        r = subprocess.run(
            [sys.executable, str(script), '--write'],
            input=body.decode('utf-8', errors='replace'),
            capture_output=True, text=True, timeout=10,
            cwd=str(PROJECT_ROOT)
        )
        out = (r.stdout or '').strip()
        if r.returncode == 0 and out:
            return json.loads(out)
        return {'ok': False, 'error': (r.stderr or 'write_signal.py failed').strip()}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


def _signal_status(sig_id: str) -> dict:
    script = PROJECT_ROOT / 'scripts' / 'write_signal.py'
    try:
        r = subprocess.run(
            [sys.executable, str(script), '--status', '--id', sig_id],
            capture_output=True, text=True, timeout=10,
            cwd=str(PROJECT_ROOT)
        )
        out = (r.stdout or '').strip()
        if r.returncode == 0 and out:
            return json.loads(out)
        return {'status': 'ERROR', 'reason': (r.stderr or 'status check failed').strip()}
    except Exception as e:
        return {'status': 'ERROR', 'reason': str(e)}


def _run_sync():
    script = PROJECT_ROOT / 'scripts' / 'sync_mt4.py'
    try:
        r = subprocess.run(
            [sys.executable, str(script)],
            capture_output=True, text=True, timeout=30,
            cwd=str(PROJECT_ROOT)
        )
        ok     = (r.returncode == 0)
        output = (r.stdout + r.stderr).strip()
        return {'ok': ok, 'output': output}
    except subprocess.TimeoutExpired:
        return {'ok': False, 'output': 'Timed out after 30 s'}
    except Exception as e:
        return {'ok': False, 'output': str(e)}


if __name__ == '__main__':
    os.chdir(PROJECT_ROOT)
    print(f'Wayne Trading Terminal  →  http://localhost:{PORT}')
    print('Press Ctrl+C to stop.\n')
    with http.server.HTTPServer(('', PORT), Handler) as httpd:
        httpd.serve_forever()

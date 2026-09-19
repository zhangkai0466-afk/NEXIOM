"""One request in, one JSON result out. NEXIOM owns tool invocation and approval."""
from __future__ import annotations
import contextlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(ROOT))

def redact(value, secret):
    if not secret:
        return value
    if isinstance(value, str):
        return value.replace(secret, '[REDACTED]')
    if isinstance(value, list):
        return [redact(item, secret) for item in value]
    if isinstance(value, dict):
        return {redact(str(key), secret): redact(item, secret) for key, item in value.items()}
    return value

def main():
    secret = ''
    try:
        packet = {'operation': 'check'} if '--check' in sys.argv else {'operation': 'list'} if '--list' in sys.argv else json.load(sys.stdin)
        secret = str((packet.get('provider') or {}).get('apiKey') or '')
        operation = packet.get('operation', 'call')
        import boot
        if operation == 'check':
            result = boot.check_dependencies(emit=False)
        elif operation == 'list':
            result = json.loads((ROOT / 'native-tools.json').read_text(encoding='utf-8'))
        elif operation == 'call':
            os.environ['NEXIOM_VISUAL_PROJECT_ROOT'] = str(packet.get('projectRoot') or '')
            os.environ['NEXIOM_VISUAL_MODE'] = str(packet.get('mode') or 'plan')
            os.environ['NEXIOM_VISUAL_NETWORK'] = '1' if packet.get('network') is True else '0'
            os.environ['NEXIOM_VISUAL_PROVIDER_JSON'] = json.dumps(packet.get('provider') or {})
            if packet.get('runsDir'):
                os.environ['NEXIOM_VISUAL_RUNS_DIR'] = str(packet['runsDir'])
            else:
                os.environ.pop('NEXIOM_VISUAL_RUNS_DIR', None)
            with contextlib.redirect_stdout(sys.stderr):
                registry = boot.configure_functions()
                result = registry.call(str(packet.get('name') or ''), packet.get('arguments') or {})
        else:
            raise ValueError('Unsupported native visualization operation.')
        response = {'ok': True, 'result': result}
    except Exception as exc:
        response = {'ok': False, 'error': {'type': type(exc).__name__, 'message': str(exc)}}
    json.dump(redact(response, secret), sys.stdout, ensure_ascii=False, default=str)
    sys.stdout.write('\n')

if __name__ == '__main__':
    main()

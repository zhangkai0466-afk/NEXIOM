"""Offline integration checks: exact-template rendering and adapter boundaries."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class VisualizationBundleTests(unittest.TestCase):
    def run_python(self, code, *, mode='execute'):
        with tempfile.TemporaryDirectory(prefix='nexiom-visual-test-') as project:
            env = {**os.environ, 'NEXIOM_VISUAL_PROJECT_ROOT': project, 'NEXIOM_VISUAL_MODE': mode, 'NEXIOM_VISUAL_NETWORK': '0', 'NEXIOM_VISUAL_PROVIDER_JSON': '{}'}
            env.pop('NEXIOM_VISUAL_RUNS_DIR', None)
            bootstrap = f"import sys; sys.path.insert(0, {str(ROOT)!r}); import boot\n"
            result = subprocess.run([sys.executable, '-I', '-B', '-X', 'utf8', '-c', bootstrap + code], env=env, capture_output=True, text=True, encoding='utf-8', timeout=120)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return result.stdout

    def test_catalog_and_assets(self):
        catalog = json.loads((ROOT / 'catalog.json').read_text(encoding='utf-8'))
        self.assertEqual(len(catalog['templates']), 62)
        self.assertEqual(len(catalog['grammar']), 308)
        self.assertEqual(len(catalog['previews']), 790)
        all_images = catalog['references'] + catalog['previews']
        self.assertEqual(len({entry['id'] for entry in all_images}), len(all_images))
        for entry in all_images:
            self.assertTrue((ROOT / entry['imagePath']).is_file(), entry['imagePath'])
        self.assertNotIn('mcp>=', (ROOT / 'requirements.txt').read_text())
        self.assertFalse((ROOT / 'engine/src/visual_design_mcp').exists())

    def test_plan_and_project_boundaries(self):
        self.run_python('''
import json
from pathlib import Path
server = boot.configure_functions()
assert not any(name == 'mcp' or name.startswith('mcp.') or name == 'paperspec_core' or name.startswith('paperspec_core.') or name == 'visual_design_mcp' or name.startswith('visual_design_mcp.') for name in sys.modules)
assert set(server.functions) == boot.READ_ONLY_TOOLS
assert 'render_preview' not in server.functions
assert 'visual_stage_report' not in server.functions
root = boot.project_root()
outside = root.parent / 'nexiom-secret.csv'
try:
    boot.check_path(str(outside))
    raise AssertionError('outside read allowed')
except PermissionError: pass
try:
    boot.check_path(str(boot.ROOT / 'catalog.json'), output=True)
    raise AssertionError('bundle overwrite allowed')
except PermissionError: pass
inventory = root / 'fake.json'
inventory.write_text(json.dumps({'project_root': str(root.parent), 'sources': [{'source_id': 's', 'path': str(outside), 'sha256': 'x'}]}))
try:
    server.functions['read_visual_research_source'].fn(str(inventory), 's')
    raise AssertionError('nested external read allowed')
except PermissionError: pass
boot._active.set(True)
try:
    (root / 'blocked.txt').write_text('bad')
    raise AssertionError('plan write allowed')
except PermissionError: pass
finally: boot._active.set(False)
assert server.functions['health_check'].fn()['template_count'] == 62
assert server.functions['validate_visual_design_output'].fn('{}')['valid'] is False
''', mode='plan')

    def test_real_template_renders_all_formats_and_rejects_arbitrary_code(self):
        self.run_python('''
import json
from pathlib import Path
server = boot.configure_functions()
from nexiom_visualization.generators.code_generator import generate_code_file
root = boot.project_root()
out = boot.runs_root()
data = root / 'evidence.csv'
data.write_text('x,y\\n1,3\\n2,5\\n3,4\\n4,8\\n', encoding='utf-8')
script = generate_code_file(out / 'line.py', 'line', 'teal-ember-9', {'x_column': 'x', 'y_column': 'y'}, data)
packet = out / 'design.json'
packet.write_text(json.dumps({'figures': [{'figure_id': 'line-check', 'quality_checks_passed': True, 'python_code_path': str(script)}]}))
result = server.functions['render_and_inspect_visual_design'].fn(str(packet), str(out / 'verification'))
rendered = out / 'verification/rendered/line-check'
assert {p.suffix for p in rendered.glob('*')} >= {'.png', '.svg', '.pdf'}, result
assert result['figures'][0]['runtime_rule_checks'][0]['rule_id'] == 'PS-FRAME-001', result
assert result['figures'][0]['runtime_rule_checks'][0]['passed'] is True, result
from unittest.mock import patch
from subprocess import CompletedProcess
with patch('nexiom_visualization.production.subprocess.run', return_value=CompletedProcess([], 0, '{}', '')):
    unverified = server.functions['render_and_inspect_visual_design'].fn(str(packet), str(out / 'verification'))
assert unverified['figures'][0]['status'] == 'blocked_by_render_gate', unverified
assert any(issue['type'] == 'rectangular_axis_frame_not_verified' for issue in unverified['figures'][0]['blocking_issues']), unverified
script.write_text(script.read_text() + '\\nprint("modified")\\n')
try:
    boot.validate_generated_script(script)
    raise AssertionError('arbitrary modified source allowed')
except PermissionError: pass
try:
    server.functions['render_preview'].fn('teal-ember-9', 'response-curves', str(root.parent / 'escape'))
    raise AssertionError('output escape allowed')
except PermissionError: pass
print('Rendered PNG, SVG and PDF from the bundled line template.')
''')

    def test_responses_json_sse_auth_none_and_network_gate(self):
        self.run_python('''
import json, os, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from dataclasses import replace
from adapter import ResponsesModelClient, load_settings
requests = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append((self.path, self.headers.get('Authorization'), body))
        self.send_response(302 if body['model'] == 'redirect' else 200)
        if body['model'] == 'redirect':
            self.send_header('Location', f'http://127.0.0.1:{http.server_port}/leak'); self.end_headers(); return
        if len(requests) == 1:
            self.send_header('Content-Type', 'application/json'); self.end_headers()
            self.wfile.write(json.dumps({'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':'{"ok":true}'}]}]}).encode())
        else:
            self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
            events = [{'type':'response.output_text.delta','delta':'{"ok":true}'},{'type':'response.completed','response':{'status':'completed','output':[]}}]
            for event in events: self.wfile.write(('data: '+json.dumps(event)+'\\n\\n').encode())
http = HTTPServer(('127.0.0.1',0), Handler)
threading.Thread(target=http.serve_forever, daemon=True).start()
os.environ['NEXIOM_VISUAL_PROVIDER_JSON'] = json.dumps({'id':'local','model':'test','endpoint':f'http://127.0.0.1:{http.server_port}/v1','auth':'none'})
settings = load_settings()
client = ResponsesModelClient(settings)
try:
    client.chat(settings.model, 'system', 'user')
    raise AssertionError('disabled network allowed')
except PermissionError: pass
os.environ['NEXIOM_VISUAL_NETWORK'] = '1'
for _ in range(2): assert json.loads(client.chat(settings.model, 'system', 'user')['content']) == {'ok': True}
assert len(requests) == 2
assert all(path == '/v1/responses' and auth is None and 'input' in body and 'messages' not in body for path, auth, body in requests)
server = boot.configure_functions()
from nexiom_visualization.bounded_request import bounded_chat
boot._active.set(True); boot._write.set(True)
try:
    assert json.loads(bounded_chat(client, settings, 'system', 'user', 100)['content']) == {'ok': True}
finally:
    boot._active.set(False); boot._write.set(False)
assert len(requests) == 3
old_provider = os.environ['NEXIOM_VISUAL_PROVIDER_JSON']
redirect_provider = json.loads(old_provider)
redirect_provider.update(model='redirect', auth='api-key', apiKey='test-private-token')
os.environ['NEXIOM_VISUAL_PROVIDER_JSON'] = json.dumps(redirect_provider)
redirect_settings = load_settings()
try:
    ResponsesModelClient(redirect_settings).chat(redirect_settings.model, 'system', 'user')
    raise AssertionError('redirect was followed')
except RuntimeError as exc: assert '302' in str(exc)
assert len(requests) == 4 and not any(path == '/leak' for path, _, _ in requests)
http.shutdown()
''')

    def test_native_gallery_and_real_data_chart(self):
        self.run_python('''
import json, subprocess, sys
from pathlib import Path
root = boot.project_root()
data = root / 'native-data.csv'
data.write_text('x,y\\n1,2\\n2,5\\n3,4\\n4,7\\n')
def call(name, arguments, mode='plan'):
    packet={'operation':'call','name':name,'arguments':arguments,'projectRoot':str(root),'mode':mode,'network':False}
    result=subprocess.run([sys.executable,'-I','-B','-X','utf8',str(boot.ROOT/'native.py')],input=json.dumps(packet),capture_output=True,text=True,encoding='utf-8',timeout=90)
    assert result.returncode == 0, result.stderr
    payload=json.loads(result.stdout)
    assert payload['ok'], payload
    assert 'jsonrpc' not in payload
    return payload['result']
reference=call('get_visual_reference',{'reference_id':'reference-1'})
assert reference['contentItems'][0]['imageUrl'].startswith('data:image/jpeg;base64,')
arguments={'template_id':'line','palette_id':'teal-ember-9','data_file':str(data),'encoding':{'x_column':'x','y_column':'missing'},'output_dir':str(root/'outputs/visual-design/native')}
assert call('render_visual_template',arguments,'execute')['status']=='blocked_by_data_contract'
arguments['encoding']['y_column']='y'
result=call('render_visual_template',arguments,'execute')
assert result['summary']['production_ready'] == 1, result
assert {Path(item['path']).suffix for item in result['figures'][0]['outputs']} == {'.pdf','.png','.svg'}
assert result['figures'][0]['runtime_rule_checks'][0]['passed'] is True, result
''')

if __name__ == '__main__':
    unittest.main(verbosity=2)

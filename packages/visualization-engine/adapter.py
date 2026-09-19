"""NEXIOM configuration and Responses transport; upstream stays unmodified."""
from __future__ import annotations
import json
import os
from pathlib import Path
import time
from urllib import request, error

ROOT = Path(__file__).resolve().parent
READ_ONLY_TOOLS = frozenset({
    'health_check', 'get_visual_research_cards', 'search_visual_research_sources',
    'read_visual_research_source', 'visual_research_progress', 'analyze_data_file',
    'check_request_fulfillment', 'validate_visual_design_output', 'detect_missing_figures',
    'generate_principle_figure_prompt', 'check_code_quality', 'list_available_templates',
    'list_visual_grammar_index', 'search_visual_grammar_terms', 'search_visual_templates',
    'list_available_palettes', 'build_paper_visual_inventory',
    'get_visual_reference',
})

def transport_protocol_descriptor():
    return {'owner': 'NEXIOM', 'protocol': 'openai-responses', 'streaming': True, 'maximum_attempts': 3, 'request_timeout_seconds': 60, 'configuration_source': 'NEXIOM_VISUAL_PROVIDER_JSON', 'external_paperspec_required': False}

def provider():
    value = json.loads(os.getenv('NEXIOM_VISUAL_PROVIDER_JSON', '{}'))
    if not isinstance(value, dict):
        raise ValueError('NEXIOM visualization provider must be a JSON object.')
    return value

def project_root():
    value = os.getenv('NEXIOM_VISUAL_PROJECT_ROOT', '')
    if not value:
        raise ValueError('NEXIOM_VISUAL_PROJECT_ROOT is required.')
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise ValueError('Visualization project directory does not exist.')
    return root

def runs_root():
    project = project_root()
    root = Path(os.getenv('NEXIOM_VISUAL_RUNS_DIR', str(project / 'outputs/visual-design'))).expanduser().resolve()
    if root == project or not root.is_relative_to(project) or root.is_relative_to(ROOT):
        raise ValueError('Visualization output must be a subdirectory of the active project, outside the bundled library.')
    return root

def load_settings():
    from nexiom_visualization.config import Settings, ModelConfig
    config = provider()
    name = str(config.get('id') or 'nexiom-visual-designer')
    model = ModelConfig(name=name, label=str(config.get('name') or name), provider='nexiom-responses', role='visual_designer', model=str(config.get('model') or ''), base_url=str(config.get('endpoint') or ''), api_key=str(config.get('apiKey') or '') if config.get('auth') != 'none' else 'nexiom-no-auth')
    return Settings(project_root=ROOT / 'engine', runs_dir=runs_root(), models=(model,), model_name=name, timeout_seconds=60, max_tokens=16000, retry_attempts=3, retry_backoff_seconds=1, meeting_deadline_seconds=720, stream_responses=True)

def responses_url(endpoint):
    url = str(endpoint).rstrip('/')
    if url.endswith('/responses'):
        return url
    if url.endswith('/chat/completions'):
        url = url[:-len('/chat/completions')]
    return url + '/responses'

def consume_response(response):
    content_type = response.headers.get('Content-Type', '')
    if 'text/event-stream' not in content_type:
        value = json.loads(response.read().decode('utf-8'))
        if value.get('error'):
            raise RuntimeError(str(value['error']))
        return value
    text_parts, final, event_lines = [], None, []
    def handle(lines):
        nonlocal final
        data = '\n'.join(line[5:].lstrip() for line in lines if line.startswith('data:'))
        if not data or data == '[DONE]':
            return
        item = json.loads(data)
        kind = item.get('type', '')
        if kind == 'response.output_text.delta':
            text_parts.append(item.get('delta', ''))
        elif kind in {'response.completed', 'response.done'}:
            final = item.get('response', item)
        elif kind in {'error', 'response.failed', 'response.incomplete'}:
            raise RuntimeError(str(item.get('error') or item.get('response', {}).get('error') or kind))
    for raw in response:
        line = raw.decode('utf-8').rstrip('\r\n')
        if line:
            event_lines.append(line)
        else:
            handle(event_lines)
            event_lines = []
    if event_lines:
        handle(event_lines)
    if final is None:
        raise RuntimeError('Responses stream ended without a completed response.')
    if not final.get('output') and text_parts:
        final['output'] = [{'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': ''.join(text_parts)}]}]
    return final

class _NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class ResponsesModelClient:
    def __init__(self, settings):
        self.settings = settings
        self.route_events = []

    def chat(self, model, system, user, temperature=0.25, deadline_at=None, max_tokens=None):
        if os.getenv('NEXIOM_VISUAL_MODE', 'plan') != 'execute':
            raise PermissionError('Model calls require execute mode.')
        if os.getenv('NEXIOM_VISUAL_NETWORK', '0') != '1':
            raise PermissionError('Network access is disabled for this NEXIOM session.')
        config = provider()
        if not model.base_url or not model.model or (config.get('auth') != 'none' and not config.get('apiKey')):
            raise ValueError('Configure the NEXIOM visualization Responses provider first.')
        payload = {'model': model.model, 'instructions': system, 'input': [{'role': 'user', 'content': [{'type': 'input_text', 'text': user}]}], 'stream': bool(self.settings.stream_responses), 'store': False}
        if max_tokens or self.settings.max_tokens:
            payload['max_output_tokens'] = max_tokens or self.settings.max_tokens
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        if len(body) > 2_000_000:
            raise ValueError('Visualization research request exceeds the 2 MB payload limit; split it into smaller units.')
        headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream' if payload['stream'] else 'application/json'}
        if config.get('auth') != 'none':
            headers['Authorization'] = 'Bearer ' + str(config['apiKey'])
        attempts = min(3, max(1, self.settings.retry_attempts))
        for attempt in range(1, attempts + 1):
            remaining = deadline_at - time.monotonic() if deadline_at is not None else self.settings.timeout_seconds
            if remaining <= 0:
                raise TimeoutError('Visualization model deadline exhausted.')
            try:
                with request.build_opener(_NoRedirect()).open(request.Request(responses_url(model.base_url), data=body, headers=headers, method='POST'), timeout=min(self.settings.timeout_seconds, remaining)) as response:
                    value = consume_response(response)
                break
            except error.HTTPError as exc:
                if exc.code not in {408, 429, 500, 502, 503, 504} or attempt == attempts:
                    raise RuntimeError(f'NEXIOM Responses provider returned HTTP {exc.code}.') from exc
            except (error.URLError, TimeoutError):
                if attempt == attempts:
                    raise
            time.sleep(min(2 ** (attempt - 1), 3))
        if value.get('status') in {'failed', 'incomplete', 'cancelled'}:
            raise RuntimeError(f"Responses generation did not complete: {value.get('status')}")
        content = value.get('output_text') or '\n'.join(part.get('text', '') for output in value.get('output', []) if output.get('type') == 'message' for part in output.get('content', []) if part.get('type') == 'output_text')
        if not content.strip():
            raise RuntimeError('Responses provider returned no public text.')
        self.route_events.append({'event': 'route_attempt_succeeded', 'model_name': model.name, 'route': 'nexiom-responses', 'attempt': attempt})
        return {'model_name': model.name, 'model': model.model, 'role': model.role, 'content': content, 'usage': value.get('usage', {}), 'finish_reason': value.get('status', 'completed'), 'transport_attempts': attempt, 'raw': value, 'request_metrics': {'payload_bytes': len(body)}, 'active_route': 'nexiom-responses', 'route_switches': []}

def install():
    import nexiom_visualization.config as config
    import nexiom_visualization.model_client as model_client
    config.load_settings = load_settings
    model_client.ModelClient = ResponsesModelClient

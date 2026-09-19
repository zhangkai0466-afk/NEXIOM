"""Native visualization execution and project-bound I/O guards."""
from __future__ import annotations
import ast
import contextvars
import functools
import importlib
import inspect
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT), str(ROOT / 'engine/src'), str(ROOT / 'studio/src')]
from adapter import READ_ONLY_TOOLS, install, project_root, runs_root

_active = contextvars.ContextVar('visual_tool_scope', default=False)
_write = contextvars.ContextVar('visual_tool_write', default=False)
_render_command = contextvars.ContextVar('visual_render_command', default=None)
PATH_FIELDS = {'inventory_path', 'plan_path', 'execution_path', 'previous_plan_path', 'data_file', 'python_code_path', 'visual_design_output_json', 'section_content_package_json', 'paper_root', 'data_dir', 'entry_tex', 'project_root', 'research_dir'}
OUTPUT_FIELDS = {'output_dir', 'output_root', 'output_path'}

def check_path(value, *, output=False):
    target = Path(value).expanduser()
    target = (project_root() / target).resolve() if not target.is_absolute() else target.resolve()
    boundary = runs_root() if output else project_root()
    if not target.is_relative_to(boundary) or target.is_relative_to(ROOT):
        raise PermissionError('Visualization paths must stay inside the active project; outputs must stay inside its visualization output directory.')
    return str(target)

def validate_arguments(arguments):
    converted = dict(arguments)
    for key, value in arguments.items():
        if key == 'visual_design_output_json' and isinstance(value, str) and value.lstrip().startswith('{'):
            # The schema validator also accepts inline JSON; render tools use paths.
            converted[key] = value
        elif key in PATH_FIELDS and isinstance(value, str) and value:
            converted[key] = check_path(value)
        elif key in OUTPUT_FIELDS and isinstance(value, str) and value:
            converted[key] = check_path(value, output=True)
        elif key in {'data_files', 'context_files'}:
            converted[key] = [check_path(item) for item in value]
        elif key == 'data_file_by_request' and value:
            converted[key] = {name: check_path(item) for name, item in value.items()}
    return converted

def install_file_guard():
    project, output = project_root(), runs_root()
    runtime_roots = [Path(sys.base_prefix).resolve(), Path(sys.prefix).resolve(), ROOT]
    if os.name == 'nt':
        runtime_roots += [Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts', Path(os.environ.get('LOCALAPPDATA', 'C:/')) / 'Microsoft/Windows/Fonts']
    else:
        runtime_roots += [Path('/usr/share/fonts'), Path('/usr/share/fontconfig'), Path('/etc/fonts')]

    def file_path(value):
        if not isinstance(value, (str, bytes, os.PathLike)):
            return None
        return Path(os.fsdecode(value)).expanduser().resolve()

    def audit(event, args):
        if not _active.get():
            return
        if event == 'open':
            path = file_path(args[0])
            if path is None:
                return
            mode, flags = args[1], args[2]
            writing = (isinstance(mode, str) and any(letter in mode for letter in 'wax+')) or (isinstance(flags, int) and bool(flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)))
            if writing:
                if not _write.get() or not path.is_relative_to(output) or path.is_relative_to(ROOT):
                    raise PermissionError('Visualization write is outside the authorized output directory.')
            elif not path.is_relative_to(project) and not any(path.is_relative_to(root) for root in runtime_roots):
                raise PermissionError('Visualization read is outside the active project and bundled runtime.')
        elif event in {'os.mkdir', 'os.remove', 'os.rmdir', 'os.rename', 'os.replace', 'os.chmod', 'os.utime'}:
            paths = args[:2] if event in {'os.rename', 'os.replace'} else args[:1]
            for value in paths:
                path = file_path(value)
                if path is not None and (not _write.get() or not path.is_relative_to(output) or path.is_relative_to(ROOT)):
                    # mkdir(exist_ok=True) may walk existing output parents.
                    if event == 'os.mkdir' and path.is_dir() and output.is_relative_to(path):
                        continue
                    raise PermissionError('Visualization filesystem mutation is outside its output directory.')
        elif event in {'os.symlink', 'os.link', 'os.system', 'os.exec', 'os.spawn'}:
            raise PermissionError('This operation is unavailable to visualization tools.')
        elif event == 'socket.connect' and (not _write.get() or os.getenv('NEXIOM_VISUAL_NETWORK', '0') != '1'):
            raise PermissionError('Network access is disabled for this visualization operation.')
        elif event == 'subprocess.Popen':
            command = args[1]
            expected = _render_command.get()
            matches = expected is not None and (command == subprocess.list2cmdline(expected) if isinstance(command, str) else tuple(command) == tuple(expected))
            if not _write.get() or not matches:
                raise PermissionError('Only a bundled renderer or model worker may start a process.')
    sys.addaudithook(audit)

def validate_generated_script(script):
    """Saved plans cannot execute arbitrary Python merely by setting quality=true."""
    from nexiom_visualization.generators.code_generator import generate_code
    source = Path(check_path(script)).read_text(encoding='utf-8')
    tree = ast.parse(source)
    config = None
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'CONFIG' for target in node.targets):
            value = node.value
            if isinstance(value, ast.Call) and isinstance(value.func, ast.Attribute) and isinstance(value.func.value, ast.Name) and value.func.value.id == 'json' and value.func.attr == 'loads' and len(value.args) == 1 and isinstance(value.args[0], ast.Constant) and isinstance(value.args[0].value, str):
                config = json.loads(value.args[0].value)
            break
    if not isinstance(config, dict):
        raise PermissionError('Plot source must be generated from an installed NEXIOM visualization template.')
    check_path(config['data_file'])
    expected = generate_code(config['template_id'], config['palette_id'], config['encoding'], config['data_file'], output_formats=config['output_formats'], dpi=config['dpi'], figsize=tuple(config['figsize']))
    if expected.strip() != source.strip():
        raise PermissionError('Saved plot source differs from the registered template. Regenerate it from the installed template before rendering.')

def install_renderer_guard():
    import nexiom_visualization.production as production
    import nexiom_visualization.evidence_pipeline as evidence
    import nexiom_visualization.bounded_request as bounded
    original_run = subprocess.run
    def guarded_run(command, *args, **kwargs):
        if not isinstance(command, (list, tuple)) or len(command) < 2 or Path(str(command[0])).resolve() != Path(sys.executable).resolve():
            raise PermissionError('Visualization rendering only supports the bundled Python renderer.')
        model_worker = list(command[1:]) == ['-m', 'nexiom_visualization.bounded_request']
        if model_worker:
            if os.getenv('NEXIOM_VISUAL_MODE', 'plan') != 'execute' or os.getenv('NEXIOM_VISUAL_NETWORK', '0') != '1':
                raise PermissionError('Model calls require Execute with network access enabled.')
            from adapter import provider
            packet = json.loads(kwargs['input'])
            packet['nexiom_provider'] = provider()
            kwargs['input'] = json.dumps(packet, ensure_ascii=False).encode('utf-8')
        else:
            validate_generated_script(command[1])
            for index, item in enumerate(command):
                if item == '--output-dir' and index + 1 < len(command):
                    check_path(command[index + 1], output=True)
        child_env = dict(os.environ)
        child_env.pop('NEXIOM_VISUAL_PROVIDER_JSON', None)
        if not model_worker:
            child_env['NEXIOM_VISUAL_NETWORK'] = '0'
        kwargs['env'] = child_env
        child_command = [sys.executable, '-I', '-X', 'utf8', '-B', '-u', str(ROOT / 'boot.py'), '--request'] if model_worker else [sys.executable, '-I', '-X', 'utf8', '-B', '-u', str(ROOT / 'boot.py'), '--render', *command[1:]]
        if kwargs.get('text'):
            kwargs.setdefault('encoding', 'utf-8')
        token = _render_command.set(child_command)
        try:
            return original_run(child_command, *args, **kwargs)
        finally:
            _render_command.reset(token)
    from types import SimpleNamespace
    for module in (production, evidence, bounded):
        module.subprocess = SimpleNamespace(run=guarded_run, TimeoutExpired=subprocess.TimeoutExpired)

def configure_functions():
    project_root()
    output = runs_root()
    mode = os.getenv('NEXIOM_VISUAL_MODE', 'plan')
    if mode not in {'plan', 'execute'}:
        raise ValueError('NEXIOM_VISUAL_MODE must be plan or execute.')
    if mode == 'execute':
        (output / '.runtime').mkdir(parents=True, exist_ok=True)
        os.environ['MPLCONFIGDIR'] = str(output / '.runtime/matplotlib')
        os.environ['TMPDIR'] = os.environ['TEMP'] = os.environ['TMP'] = str(output / '.runtime')
    install()
    from nexiom_visualization import server
    install_renderer_guard()
    # Warm optional calculation backends before restricting tool I/O.
    importlib.import_module('nexiom_visualization.research_workflow')
    importlib.import_module('nexiom_visualization.competition_workflow')
    from native_functions import register
    register(server.registry)
    manager = server.registry
    for name in list(manager.functions):
        if mode == 'plan' and name not in READ_ONLY_TOOLS:
            del manager.functions[name]
            continue
        tool = manager.functions[name]
        fn = tool.fn
        def guard_function(function, tool_name):
            @functools.wraps(function)
            def guarded(*args, **kwargs):
                arguments = inspect.signature(function).bind(*args, **kwargs)
                arguments.apply_defaults()
                values = validate_arguments(arguments.arguments)
                active_token = _active.set(True)
                write_token = _write.set(mode == 'execute' and tool_name not in READ_ONLY_TOOLS)
                try:
                    return function(**values)
                finally:
                    _write.reset(write_token)
                    _active.reset(active_token)
            return guarded
        tool.fn = guard_function(fn, name)
    install_file_guard()
    return server.registry

def check_dependencies(emit=True):
    missing = []
    for name in ['jsonschema', 'json_repair', 'matplotlib', 'seaborn', 'scipy', 'numpy', 'jinja2', 'pandas', 'pydantic', 'PIL']:
        try:
            importlib.import_module(name)
        except Exception as exc:
            missing.append({'module': name, 'error': type(exc).__name__})
    result = {'available': not missing, 'version': '1.7.1', 'label': '可视化运行时就绪' if not missing else '可视化 Python 依赖未安装', 'missing': missing}
    if not missing:
        try:
            from nexiom_visualization.template_registry import TEMPLATE_REGISTRY
            from scientific_palette_studio.catalog import load_palettes
            result.update(templateCount=len(TEMPLATE_REGISTRY), paletteCount=len(load_palettes()), externalProjectRequired=False)
        except Exception as exc:
            result.update(available=False, label='内置可视化资源校验失败', error=str(exc))
    if emit:
        print(json.dumps(result, ensure_ascii=False))
    return result

def render_child():
    script = sys.argv[2]
    sys.argv = sys.argv[2:]
    # Load plotting libraries before the I/O guard; then execute only exact templates.
    importlib.import_module('scientific_palette_studio.rendering')
    importlib.import_module('seaborn')
    validate_generated_script(script)
    install_file_guard()
    _active.set(True)
    _write.set(True)
    runpy.run_path(script, run_name='__main__')

def request_child():
    import io
    packet = json.load(sys.stdin)
    os.environ['NEXIOM_VISUAL_PROVIDER_JSON'] = json.dumps(packet.pop('nexiom_provider', {}))
    sys.stdin = io.StringIO(json.dumps(packet))
    from nexiom_visualization.bounded_request import main
    install_file_guard()
    _active.set(True)
    _write.set(True)
    main()

if __name__ == '__main__':
    if '--check' in sys.argv:
        check_dependencies()
    elif len(sys.argv) > 2 and sys.argv[1] == '--render':
        render_child()
    elif len(sys.argv) > 1 and sys.argv[1] == '--request':
        request_child()
    else:
        raise SystemExit('Use native.py for NEXIOM native visualization calls.')

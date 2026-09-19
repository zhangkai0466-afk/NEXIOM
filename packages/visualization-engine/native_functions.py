"""First-class NEXIOM gallery and real-data single-chart operations."""
from __future__ import annotations
import base64
import io
import json
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent

def register(registry):
    @registry.tool()
    def get_visual_reference(reference_id: str) -> dict[str, Any]:
        """读取内置图库参考图的真实图像与适用条件。返回科研截图或模板预览，不把预览中的数值当作项目证据。"""
        from PIL import Image
        catalog = json.loads((ROOT / 'catalog.json').read_text(encoding='utf-8'))
        candidates = {reference_id}
        for prefix in ('reference-', 'preview-'):
            if reference_id.startswith(prefix):
                candidates.add(reference_id[len(prefix):])
        entry = next((item for item in [*catalog['references'], *catalog['previews']] if item['id'] in candidates), None)
        if entry is None:
            raise ValueError('Unknown visualization reference ID.')
        image_path = (ROOT / entry['imagePath']).resolve()
        if not image_path.is_relative_to(ROOT):
            raise PermissionError('Reference asset escapes the native visualization package.')
        with Image.open(image_path) as original:
            image = original.convert('RGB')
            image.thumbnail((1600, 1600))
            output = io.BytesIO()
            image.save(output, format='JPEG', quality=88, optimize=True)
        data_url = 'data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode('ascii')
        return {'reference': entry, 'usage': '图形与配色参考；真实统计结果必须来自当前项目数据。', 'contentItems': [{'type': 'inputImage', 'imageUrl': data_url}]}

    @registry.tool()
    def render_visual_template(template_id: str, palette_id: str, data_file: str, encoding: dict[str, Any], output_dir: str, dpi: int = 300, width: float = 6.4, height: float = 4.0, evidence_facts: dict[str, Any] | None = None) -> dict[str, Any]:
        """从当前项目真实 CSV/TSV 生成单张科研图的 PDF、PNG、SVG。先检验指定模板的数据列、类型与统计证据前提；不调用云模型。"""
        from nexiom_visualization.analyzers.data_analyzer import analyze_data_file
        from nexiom_visualization.generators.code_generator import generate_code_file
        from nexiom_visualization.recommenders.template_matcher import search_template_candidates, validate_template_encoding
        from nexiom_visualization.production import render_and_inspect_figures
        from nexiom_visualization.quality.checker import check_code_file
        from nexiom_visualization.template_registry import TEMPLATE_REGISTRY
        from boot import check_path
        if template_id not in TEMPLATE_REGISTRY:
            raise ValueError('The selected chart has no installed executable template.')
        data = check_path(data_file)
        output = Path(check_path(output_dir, output=True))
        analysis = analyze_data_file(data)
        exact_encoding = validate_template_encoding(template_id, encoding, analysis)
        if not exact_encoding['valid']:
            return {'status': 'blocked_by_data_contract', 'template_id': template_id, 'validation': exact_encoding}
        request = {**(evidence_facts or {}), 'id': 'native-chart', 'kind': 'data_plot', 'template_id': template_id, 'encoding_requirements': encoding}
        selected = next((item for item in search_template_candidates(request, analysis) if item['template_id'] == template_id), None)
        if selected is None or selected['eligibility'] != 'eligible':
            return {'status': 'blocked_by_data_contract', 'template_id': template_id, 'data_sha256': analysis['sha256'], 'validation': selected, 'required_evidence': TEMPLATE_REGISTRY[template_id].get('statistical_preconditions', [])}
        code = generate_code_file(output / 'source' / f'{template_id}.py', template_id, palette_id, selected['encoding_requirements'], data, dpi=dpi, figsize=(width, height))
        quality = check_code_file(code)
        result = render_and_inspect_figures({'figures': [{'figure_id': template_id, 'quality_checks_passed': quality['quality_checks_passed'], 'violations': quality.get('violations', []), 'python_code_path': str(code)}]}, output)
        return {'template_id': template_id, 'palette_id': palette_id, 'data_sha256': analysis['sha256'], 'python_code_path': str(code), 'quality': quality, **result}

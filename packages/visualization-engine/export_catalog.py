"""Generate a portable catalogue from the imported upstream contracts."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path[:0] = [str(ROOT), *[str(ROOT / name / 'src') for name in ('engine', 'studio')]]

def export():
    from nexiom_visualization.recommenders.grammar_index import full_visual_grammar_catalogue, visual_grammar_index_summary
    from nexiom_visualization.template_registry import TEMPLATE_REGISTRY
    from scientific_palette_studio.rendering import CHART_SPECS
    from adapter import READ_ONLY_TOOLS
    grammar = full_visual_grammar_catalogue()
    inventory = json.loads((ROOT / 'engine/corpus/research_plot_reference_inventory.json').read_text(encoding='utf-8'))
    audit = json.loads((ROOT / 'engine/corpus/reference_appearance_audit.json').read_text(encoding='utf-8'))
    appearances = {entry['image']: entry for entry in audit['entries']}
    references = [{**entry, 'id': f"reference-{index + 1}", 'imagePath': f"references/{entry['image']}", 'templateId': entry.get('template_id', ''), 'appearanceAudit': appearances.get(entry['image'], {}), 'tags': ['科研参考图', entry['family']]} for index, entry in enumerate(inventory['entries'])]
    previews = []
    for image in sorted((ROOT / 'previews').rglob('*.png')):
        relative = image.relative_to(ROOT).as_posix()
        local = image.relative_to(ROOT / 'previews')
        palette_id = local.parts[0]
        chart_id = image.stem
        variant = '/'.join(local.parts[1:-1])
        previews.append({'id': f'preview-{hashlib.sha256(relative.encode()).hexdigest()[:20]}', 'name': chart_id.replace('-', ' '), 'paletteId': palette_id, 'chartId': chart_id, 'variant': variant, 'imagePath': relative, 'svgPath': image.with_suffix('.svg').relative_to(ROOT).as_posix() if image.with_suffix('.svg').is_file() else '', 'tags': ['模板预览', palette_id, chart_id, *([variant] if variant else [])]})
    from nexiom_visualization.server import registry
    from native_functions import register
    register(registry)
    descriptors = registry.descriptors(READ_ONLY_TOOLS)
    (ROOT / 'native-tools.json').write_text(json.dumps({'version': '1.7.1', 'tools': descriptors}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tools = [{'name': item['name'], 'description': item['description'], 'readOnly': item['readOnly']} for item in descriptors]
    palettes = json.loads((ROOT / 'studio/data/palettes.json').read_text(encoding='utf-8'))['palettes']
    summary = visual_grammar_index_summary()
    payload = {'schemaVersion': 'nexiom.visual-design-catalog/1', 'version': '1.7.1', 'stats': {**summary, 'templateCount': len(TEMPLATE_REGISTRY), 'grammarCount': len(grammar), 'paletteCount': len(palettes), 'referenceCount': len(references), 'previewCount': len(previews), 'toolCount': len(tools), 'studioRendererCount': len(CHART_SPECS)}, 'templates': list(TEMPLATE_REGISTRY.values()), 'grammar': grammar, 'palettes': palettes, 'references': references, 'previews': previews, 'tools': tools}
    (ROOT / 'catalog.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(payload['stats'], ensure_ascii=False))

if __name__ == '__main__':
    export()

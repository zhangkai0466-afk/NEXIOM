"""Independent, incremental stage outputs; no unbounded model-call campaign."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from .artifacts import write_json
from .evidence_pipeline import run_evidence_visual_pipeline


def _stage_dir(output_root, stage):
    if stage not in {'exploration', 'refinement'}:
        raise ValueError('stage必须为exploration或refinement')
    return Path(output_root).resolve() / stage


def run_visual_stage_unit(inventory_path, output_root, stage, unit_id,
                          research_question, section_context='', previous_plan_path='', render=True,
                          *, settings=None, client=None):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', unit_id) or not research_question.strip():
        raise ValueError('unit_id需1至64位字母数字下划线连字符，并提供研究问题')
    directory = _stage_dir(output_root, stage) / 'units' / unit_id
    if stage == 'refinement' and not section_context.strip():
        raise ValueError('第二层需要框架/章节；第一层清单不是必需输入')
    source = Path(inventory_path).resolve()
    binding = {'stage': stage, 'unit_id': unit_id, 'research_question': research_question,
               'inventory_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
               'section_context': section_context,
               'previous_plan_sha256': hashlib.sha256(Path(previous_plan_path).read_bytes()).hexdigest() if previous_plan_path else ''}
    marker = directory / 'unit_input.json'
    if marker.exists() and json.loads(marker.read_text(encoding='utf-8')) != binding:
        raise ValueError('该单元绑定已变化，请使用新unit_id，避免覆盖旧版本')
    write_json(marker, binding)
    result = run_evidence_visual_pipeline(str(source), str(directory), stage,
        section_context='研究问题：' + research_question + '\n' + section_context,
        previous_plan_path=previous_plan_path, render=render, settings=settings, client=client)
    report = visual_stage_report(output_root, stage)
    return {'plan_path': result['plan_path'], 'gallery_path': result['gallery_path'],
            'unit_status': result['status'], 'candidate_count': len(result['candidates']),
            'stage_report': report}


def visual_stage_report(output_root, stage):
    directory = _stage_dir(output_root, stage)
    units, figures, gaps = [], {}, []
    for marker in sorted(directory.glob('units/*/unit_input.json')):
        binding = json.loads(marker.read_text(encoding='utf-8'))
        path = marker.parent / 'evidence_visual_plan.json'
        if not path.exists():
            units.append({'unit_id': binding['unit_id'], 'status': 'incomplete', 'plan_path': str(path)})
            continue
        plan = json.loads(path.read_text(encoding='utf-8'))
        if plan.get('stage') != stage:
            raise ValueError('单元层标识不一致，拒绝混合交付')
        units.append({'unit_id': binding['unit_id'], 'status': plan['status'],
                      'research_question': binding['research_question'], 'plan_path': str(path)})
        gaps.extend(plan.get('evidence_gaps', []))
        gaps.extend(plan.get('capability_gaps', []))
        for candidate in plan.get('candidates', []):
            key = plan['snapshot_id'] + ':' + candidate['candidate_id']
            figures.setdefault(key, {**candidate, 'source_plan_path': str(path), 'unit_id': binding['unit_id']})
    items = list(figures.values())
    main = [c for c in items if c.get('placement') == 'main_text']
    rendered = [c for c in items if c.get('production_status') == 'rendered_pending_visual_review'
                and c.get('files') and all(Path(f).is_file() for f in c['files'])]
    main_rendered = [c for c in rendered if c.get('placement') == 'main_text']
    short = stage == 'refinement' and len(main_rendered) < 15
    report = {'schema_version': 'visual_stage_report/1.0.0', 'stage': stage,
        'status': 'coverage_review_required' if short else 'selection_and_evidence_review_required',
        'units': units, 'candidate_count': len(items), 'rendered_count': len(rendered),
        'main_candidate_count': len(main), 'main_rendered_count': len(main_rendered),
        'target': {'min': 15, 'max': 20} if stage == 'refinement' else {'min': None, 'max': None},
        'requires_coverage_review': short, 'requires_selection': stage == 'refinement' and len(main)>20,
        'coverage_note': '已登记单元不等于全研究/全框架覆盖；少于15张需查漏并说明证据或能力缺口，不凑图。' if short else '候选数量不代表独立论点数量；同一问题的不同画法由人工遴选，不算多份证据。',
        'gaps': gaps, 'candidates': items,
        'claim_gate': '图片存在不代表通过科学与视觉验收；轻微标签/图例问题留人工调整，不自动模型返修。'}
    path = write_json(directory / 'stage_report.json', report)
    return {k:v for k,v in report.items() if k != 'candidates'} | {'report_path': str(path)}

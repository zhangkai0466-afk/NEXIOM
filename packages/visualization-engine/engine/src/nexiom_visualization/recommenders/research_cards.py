"""Evidence-aware reading cards; catalogue coverage is explicit and paginated."""
from __future__ import annotations
import hashlib
import json
from .grammar_index import full_visual_grammar_catalogue
from ..template_registry import TEMPLATE_REGISTRY

SPECIAL = {
    'binned_density_calibration': {
        'contribution': '检查多个连续响应的预测一致性、点云密度和系统偏差；支持同一验证问题的多面板比较。',
        'evidence': '逐样本ID、响应名称、同量纲实测值与预测值、训练/验证来源；不能用十个概率箱均值冒充个体点云。',
        'preparation': '查找冻结预测文件；按样本ID核对；宽表转长表；按响应计算预测R²、RMSE、MAE；禁止把相关系数平方当预测R²。',
        'alternatives': ['普通预测—实测散点：样本较少时更易查看个体', '残差图：定位异方差与局部偏差', 'Bland–Altman图：问题是测量一致性时考虑'],
        'limits': '二分类概率与0/1标签不能直接套多连续响应密度校准；训练集拟合不证明泛化；各面板不同单位应清楚标注。'},
    'calibration_plot': {
        'contribution': '检查概率声明与事件频率是否相符，补足判别指标不回答的概率可靠性问题。',
        'evidence': '逐样本结局与预测概率及验证口径，或可追溯的箱边界、预测均值、观测率和箱样本量。',
        'preparation': '使用冻结预测；记录分箱规则、每箱样本数和重复观测；置信区间需要有效的不确定性计算。',
        'alternatives': ['可靠性点图：呈现箱级偏差', '校准带：需要对应统计模型', 'Brier分数：概括概率误差但不代替局部诊断'],
        'limits': '不是连续回归预测图；分箱均值不能反推出逐样本误差、ROC或独立样本量。'},
    'radar_profile': {
        'contribution': '展示少量方案在多指标上的优势轮廓与权衡，而非凭面积评出最优。',
        'evidence': '指标定义、方向、归一化基准与同口径方案数值。',
        'preparation': '先核验各指标同向、尺度与归一化基准；不能为美观临时缩放。',
        'alternatives': ['点阵图：精确逐指标比较', '平行坐标：方案较多时', '热力图：紧凑比较但需要明确尺度'],
        'limits': '面积受轴顺序影响；不同归一化基准不能混用；不自动生成综合排名。'},
    'surface_3d': {
        'contribution': '检查双参数响应的曲率、交互和可行区域，服务于参数选择与稳健性讨论。',
        'evidence': '两连续参数的完整网格及同一实验协议下的响应值。',
        'preparation': '先检索已有参数实验；缺网格则提出含范围、步长、评价口径和预算的实验计划；不得补造网格。',
        'alternatives': ['等高线：精确读取水平集', '双参数热力图：降低遮挡', '剖面曲线：突出关键参数截面'],
        'limits': '视角会遮挡；散乱点不等于规则曲面；局部曲面不证明全局最优。'},
    'bar_3d': {
        'contribution': '展示两个离散类别维度的响应组合，强调阵列结构。',
        'evidence': '行类别、列类别、数值及聚合口径，缺失组合与零明确区分。',
        'preparation': '检查组合唯一性与缺失，选择不遮挡的视角并留柱间距。',
        'alternatives': ['分组柱图：更精确比较高度', '热力图：组合较多时', '点阵图：强调小差异'],
        'limits': '透视不适合精确排名；不因高级感优先使用3D；缺失不填零。'},
}

# Shared research protocols supplement, never replace, each entry's own purpose
# and preconditions. Niche entries remain explicitly subject to specialist review.
FAMILY_GUIDES = [
    ('distribution grouped_data statistical demographic', '研究偏态、多峰、尾部、离群与组间分布重叠，决定变换、分层或稳健统计是否必要。',
     '核对观测单位和重复测量；计算组内有效样本数、分位数及缺失；箱宽或带宽须记录。',
     ['ECDF：避免任意箱宽并精确比较分位位置', '箱线/原始散点：兼顾稳健摘要与个体', '直方图：展示频数与局部形态'], '分布图不能自动证明正态、显著差异或群体可分；小样本平滑可能制造结构。'),
    ('relationship scatter matrix multivariate ordination profile', '研究方向、强度、非线性、分层和变量冗余，辅助变量处理与模型结构选择。',
     '逐行配对；检查量纲、缺失、常量和离群；相关摘要同时保留散点；降维须记录缩放和拟合数据来源。',
     ['散点/分面散点：检查非线性与离群', '相关矩阵：概括多变量方向但需配合形态证据', '分层趋势：检查总体与组内关系是否相反'], '相关不证明因果；聚类可视分离不等于外部预测有效；降维轴不是原始变量。'),
    ('bar column_bar comparison categorical', '研究类别、方法或方案的差异，帮助排序、筛选和权衡。',
     '先明确数值为计数、比例、均值或效应；比例核对分母；区间与检验需真实计算；保留组间与组内间隔。',
     ['点图：紧凑比较数值', '森林图：突出效应与区间', '分布图：摘要可能掩盖组内差异时'], '柱高不证明显著；相同均值不代表分布相同；计数与比例不可混淆。'),
    ('validation diagnostic uncertainty', '研究误差、校准、区分度和不确定性，明确模型可用条件。',
     '核对逐样本预测、结局、划分/折次与预处理调参校准数据流；重复预测先明确统计单位；区间计算需说明重采样层级。',
     ['残差诊断：定位偏差结构', '区间图：显示估计精度', '分层验证图：定位失效群体'], '训练拟合不证明泛化；哈希可追溯不等于无泄漏；相关平方不代替预测R²。'),
    ('function sensitivity surface three_dimensional contour_heatmap waterfall_surface experimental_design decision', '研究参数响应、交互、可行性与多目标权衡，支持方案选择与失效边界说明。',
     '从已有实验记录提取参数和响应，核对相同评价口径；缺实验则提交范围、步长、固定条件与预算；不自行插值填补证据。',
     ['截面曲线：突出单参数影响', '等高线/热力图：双参数精确比较', 'Pareto散点：展示不可兼得的目标'], '可视化响应不证明因果或全局最优；不同情景混合摘要可能误导。'),
    ('line line_symbol timeseries longitudinal control quality_control', '研究时间趋势、变化点、周期、过程异常与动态响应。',
     '核对时间顺序、间隔、缺测、聚合频率及个体ID；预测采用时间可行的验证；控制界限应来自明确基准。',
     ['时间折线：保留真实顺序', '分面轨迹：避免个体平均掩盖异质性', '残差/变化量图：区分水平与波动'], '连线不代表连续观测；平滑不证明趋势；未来数据不能泄漏进过去预测。'),
    ('composition pie_doughnut ternary_composition set', '研究组成、占比与集合重叠，识别主导部分与结构差异。',
     '核对共同分母、互斥/重叠关系、总和约束和零值；组成比较注意闭合约束。',
     ['堆叠条：比较构成', '点图：精确比较占比', 'UpSet：集合交叉较复杂时'], '占比增加不意味着绝对数量增加；集合重叠不能当互斥类别求和。'),
    ('flow categorical_flow_network network hierarchy hierarchical diagram schedule', '研究对象、流程、层级、连接或资源安排，解释背景、方法结构或方案实现。',
     '从原题与方案识别节点和边；区分真实流量与示意连接；数量守恒、层级和时间约束分别核验；背景图不冒充算法流程。',
     ['节点—边图：连接关系', '流程图：操作与分支', '表格或时间轴：精确安排与约束'], '箭头不能凭空赋予因果或实际流量；结构示意与计算结果必须区分。'),
    ('spatial vector vector_streamline image polar polar_radial', '研究空间分布、方向、路径与场结构，支持区域或方向性解释。',
     '核对坐标参考、单位、方向角约定、空间采样与边界；插值需要单独依据并标明未观测区域。',
     ['空间散点：保留采样位置', '矢量图：强调方向和大小', '剖面/分区图：降低空间遮挡'], '图上接近不自动证明实际可达；插值不是新增观测；投影可能改变面积或距离。'),
    ('explainability', '研究模型预测依赖与特征贡献，形成可检验的解释线索。',
     '使用冻结模型并记录解释算法、背景样本和贡献尺度；解释值必须与对应输入逐样本对齐。',
     ['贡献蜂群：分布与方向', '依赖图：非线性与交互', '局部瀑布：单个样本的分解'], '模型贡献不等于因果效应；相关特征的贡献分配依赖方法与背景。'),
    ('survival', '研究事件时间、删失和组间生存过程。',
     '核对事件定义、起点、随访时间、删失与风险集；时间点风险人数与区间须可追溯。',
     ['生存曲线：时间过程', '风险表：随访支持量', '效应区间图：模型比较'], '删失不能当作未发生事件的完整随访；曲线分离不自动证明比例风险。'),
]


def research_cards():
    cards = []
    for item in full_visual_grammar_catalogue():
        spec = TEMPLATE_REGISTRY.get(item.get('template_id'), {})
        special = SPECIAL.get(item.get('template_id'), {})
        guide = next((g for g in FAMILY_GUIDES if item['family'] in g[0].split()), None)
        card = dict(item)
        card.update({
            'card_id': 'G' + hashlib.sha256((item['name'] + item.get('template_id', '')).encode()).hexdigest()[:14],
            'contribution': special.get('contribution', item['reader_question']),
            'required_evidence': special.get('evidence', {'shape': item.get('data_shape'), 'column_roles': spec.get('required_columns', []), 'types': spec.get('required_column_types', {}), 'preconditions': item.get('statistical_preconditions', [])}),
            'preparation': special.get('preparation', guide[2] if guide else '先核验该领域图形的专门定义和统计前提，再寻找相应证据；当前条目需补充专门研究，不从图名反推数据。'),
            'alternatives': special.get('alternatives', guide[3] if guide else ['先与同一问题的简单表格/二维图比较；尚无已核验专门替代图清单']),
            'cannot_establish': special.get('limits', (item.get('avoid_when') or '') + ('；'+guide[4] if guide else '；专门前提未核验前不得据此生成研究结论。')),
            'family_research_role': guide[1] if guide else '专门领域用途需进一步核验，不能按通用图形自动处理。',
            'research_questions': [item['reader_question'], '哪些结果会推翻预期论点？', '相比更简单的图，此图增加什么独立信息？'],
            'detail_level': 'specialized' if special else 'existing_catalogue',
            'needs_task_specific_review': not bool(special),
            'optional_columns': spec.get('optional_columns', []),
            'appearance_policy': '先满足论证和证据，再选择组合与外观；配色优先读取审美平台，参考截图只指导色彩关系，不臆测精确色值。偏好不是强制入选，渐变不是新的统计图型；参考外观未经渲染验收不能声称已复现。',
        })
        cards.append(card)
    return cards


def get_visual_research_cards(family: str = '', offset: int = 0, limit: int = 12):
    if offset < 0 or not 1 <= limit <= 30:
        raise ValueError('offset>=0且limit为1至30。')
    all_cards = research_cards()
    selected = [c for c in all_cards if not family or c['family'] == family]
    page = selected[offset:offset+limit]
    version = hashlib.sha256(json.dumps(all_cards, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return {'schema_version': 'visual_research_cards/1.0.0', 'catalogue_hash': version,
            'families': {f: sum(c['family'] == f for c in all_cards) for f in sorted({c['family'] for c in all_cards})},
            'total': len(selected), 'offset': offset, 'next_offset': offset+len(page) if offset+len(page)<len(selected) else None,
            'cards': page, 'coverage_rule': '分页未读完不代表全库已审视；existing_catalogue条目需结合具体任务进一步研究，不能视为逐项专家核验。'}

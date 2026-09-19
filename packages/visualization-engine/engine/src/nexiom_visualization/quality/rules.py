from __future__ import annotations


PS_FILL_001 = (
    "柱图默认使用同色系浅填充与有色细描边，禁止粗黑框；bar/barh 必须显式给出非黑 edgecolor 和正 linewidth。"
    "面积、散点、饼、节点不得使用黑色描边，必须显式使用 edgecolor(s)=none/FILL_EDGE，面积和饼同时使用 linewidth=0。"
    "渐变柱只在顺序或层级语义明确、柱体足够宽且不要求灰度复印时使用；坐标轴、误差线、参考线和箱线图统计结构线可用中性灰。"
)

PS_LAYER_001 = (
    "所有网格线、横纵参考线和坐标辅助线必须先于核心图形建立，使用 axes.axisbelow=True 且 zorder<=1；"
    "柱、折线、散点、热图等核心图形必须使用 zorder>=2，任何轴线不得穿过或分割核心图形。"
)

PS_FRAME_001 = (
    "二维直角坐标图的数据绘图区必须由上、右、下、左四条统一中性灰细线闭合为矩形，"
    "不得隐藏上、右边框或把边框移至零点；上、右默认不重复添加刻度和标签，真正的次坐标轴保留其刻度。"
    "此规则不适用于结构图、饼图、极坐标、三维图和连续色条；连续色条仍不画边框。"
    "边框保持在数据层下方。"
)

VISUAL_HARD_RULES = {
    "PS-FILL-001": PS_FILL_001,
    "PS-LAYER-001": PS_LAYER_001,
    "PS-FRAME-001": PS_FRAME_001,
}

VISUAL_HARD_RULES_PROMPT = "\n".join(f"{rule_id}: {rule}" for rule_id, rule in VISUAL_HARD_RULES.items())

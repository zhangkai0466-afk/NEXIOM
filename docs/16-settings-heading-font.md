# 0.3.8 设置页强调文字

0.3.7 设置小节标题使用14px/600，行标题使用13px/550。CDP实际字体检查确认，两者的中文均匹配MicrosoftYaHeiUI-Bold：系统字体只有400和700，中间字重并没有对应字形。125%显示缩放下，小字粗笔画显得拥挤；此前的灰度抗锯齿修正没有改变这一字体匹配。

本版为设置内容区的标题与强调文字内置Noto Sans SC可变字体（OFL 1.1），真实支持100–900字重。分组标题为15px/550/22px，设置行标题为14px/500/22px；保留视觉层级，给密集汉字更多笔画间隙。字体不依赖用户安装或在线CDN，完整WOFF2约7.8 MB，适用于动态项目名称；说明文字、导航、正文、代码和公式继续各自的字体设置。

字体来源、精确上游blob和转换方法见 `assets/fonts/noto-sans-sc/PROVENANCE.md`，许可证随便携版分发到 `licenses/fonts/noto-sans-sc/`。源文件只做WOFF2格式转换，未裁减字符或固定可变轴。

原尺寸对照为 `output/playwright/heading-before.png` 与 `headings-0.3.8-1.25-light-crop.png`。发布版检查脚本 `settings-heading-review.cjs` 覆盖100%、125%、150%缩放、浅暗主题、本地字体实际加载、设置分类和溢出情况；记录为 `headings-0.3.8-review.json`。这项调整改善字体轮廓和字重，不增加屏幕物理分辨率。

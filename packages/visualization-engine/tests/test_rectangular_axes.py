"""Exercise the shared generated renderer against real Matplotlib artists."""
import json
from pathlib import Path
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest

from jinja2 import Environment, FileSystemLoader
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parents[1]


class RectangularAxesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        environment = Environment(loader=FileSystemLoader(ROOT / "engine/templates"))
        config = {"template_id": "line", "encoding": {}, "figsize": [6.4, 4.0]}
        source = environment.get_template("_base_header.py.jinja2").render(config_json_literal=repr(json.dumps(config)))
        cls.renderer = ModuleType("nexiom_frame_test_renderer")
        sys.modules[cls.renderer.__name__] = cls.renderer
        exec(compile(source, "generated_frame_test.py", "exec"), cls.renderer.__dict__)
        cls.palette = SimpleNamespace(background="#FFFFFF", ink="#202124")

    @classmethod
    def tearDownClass(cls):
        sys.modules.pop(cls.renderer.__name__, None)

    def tearDown(self):
        plt.close("all")
        self.renderer.TEMPLATE_ID = "line"
        self.renderer.RUNTIME_RULE_CHECKS.clear()

    def assert_closed_frame(self, fig, ax):
        report = self.renderer.check_rectangular_axis_frames(fig)
        self.assertTrue(report["passed"], report)
        self.assertTrue(ax.get_frame_on())
        for side in ("left", "right", "top", "bottom"):
            self.assertTrue(ax.spines[side].get_visible(), side)
            self.assertEqual(ax.spines[side].get_linewidth(), 0.7)
            self.assertEqual(ax.spines[side].get_zorder(), 1)

    def test_default_frame_has_no_duplicate_top_right_ticks(self):
        with matplotlib.rc_context({"xtick.top": True, "ytick.right": True, "xtick.labeltop": True, "ytick.labelright": True}):
            fig, ax = plt.subplots()
            ax.plot([1, 2, 3], [2, 4, 3], zorder=3)
            self.renderer.style_axis(ax, self.palette)
            report = self.renderer.apply_deterministic_layout(fig)
        self.assert_closed_frame(fig, ax)
        self.assertEqual(report["rule_checks"][0]["verification"], "matplotlib_artists_after_draw")
        for axis in (ax.xaxis, ax.yaxis):
            self.assertTrue(any(tick.tick1line.get_visible() for tick in axis.get_major_ticks()))
            self.assertFalse(any(tick.tick2line.get_visible() or tick.label2.get_visible() for tick in axis.get_major_ticks()))

    def test_hidden_shifted_trimmed_spines_restored_without_changing_data(self):
        fig, ax = plt.subplots()
        self.renderer.apply_axis_layer(ax, {"grid_axis": "both", "reference_lines": [{"y": 0}]})
        bars = ax.bar([1, 2], [2, -1], edgecolor="#367A9A", linewidth=0.9, zorder=3)
        ax.spines[["top", "right"]].set_visible(False)
        ax.spines["bottom"].set_position("zero")
        ax.spines["left"].set_position(("data", 0))
        ax.spines["top"].set_bounds(1.2, 1.8)
        ax.set_frame_on(False)
        limits = (ax.get_xlim(), ax.get_ylim())
        self.renderer.apply_deterministic_layout(fig)
        self.assert_closed_frame(fig, ax)
        self.assertEqual((ax.get_xlim(), ax.get_ylim()), limits)
        self.assertEqual([bar.get_height() for bar in bars], [2, -1])
        self.assertTrue(all(line.get_zorder() <= 1 for line in ax.lines))
        self.assertTrue(all(bar.get_zorder() > ax.xaxis.get_zorder() for bar in bars))

    def test_log_inverted_axes_and_equal_aspect_remain_closed(self):
        for inverted in (False, True):
            with self.subTest(inverted=inverted):
                fig, ax = plt.subplots()
                ax.plot([1, 10, 100], [0.1, 1, 10], zorder=3)
                ax.set_xscale("log")
                ax.set_yscale("log")
                ax.set_aspect("equal", adjustable="box")
                if inverted:
                    ax.invert_xaxis()
                    ax.invert_yaxis()
                self.renderer.apply_deterministic_layout(fig)
                self.assert_closed_frame(fig, ax)

    def test_twin_axes_keep_their_real_top_and_right_scales(self):
        fig, ax = plt.subplots()
        ax.plot([1, 2, 3], [2, 4, 3], zorder=3)
        right = ax.twinx()
        right.plot([1, 2, 3], [100, 200, 150], zorder=3)
        top = ax.twiny()
        top.plot([10, 20, 30], [2, 4, 3], zorder=3)
        self.renderer.apply_deterministic_layout(fig)
        for axis in (ax, right, top):
            self.assert_closed_frame(fig, axis)
        self.assertEqual(right.yaxis.get_ticks_position(), "right")
        self.assertEqual(top.xaxis.get_ticks_position(), "top")
        self.assertTrue(any(tick.label2.get_visible() for tick in right.yaxis.get_major_ticks()))
        self.assertTrue(any(tick.label2.get_visible() for tick in top.xaxis.get_major_ticks()))

    def test_shared_subplot_labels_stay_hidden(self):
        fig, axes = plt.subplots(2, 1, sharex=True)
        for ax in axes:
            ax.plot([1, 2, 3], [2, 4, 3], zorder=3)
        self.renderer.apply_deterministic_layout(fig)
        self.assertFalse(any(tick.label1.get_visible() for tick in axes[0].xaxis.get_major_ticks()))
        self.assertTrue(any(tick.label1.get_visible() for tick in axes[1].xaxis.get_major_ticks()))

    def test_heatmap_frame_does_not_add_colorbar_border(self):
        fig, ax = plt.subplots()
        image = ax.imshow(np.arange(9).reshape(3, 3), zorder=3)
        colorbar = self.renderer.add_borderless_colorbar(fig, image, ax=ax)
        colorbar.ax.set_label("custom-colorbar-label")
        self.renderer.apply_deterministic_layout(fig)
        self.assert_closed_frame(fig, ax)
        self.assertFalse(colorbar.outline.get_visible())
        self.assertTrue(all(not spine.get_visible() for spine in colorbar.ax.spines.values()))
        self.assertEqual(self.renderer.check_rectangular_axis_frames(fig)["axes"][1]["reason"], "colorbar")

    def test_polar_3d_and_axis_off_panels_are_exempt(self):
        fig = plt.figure()
        polar = fig.add_subplot(131, projection="polar")
        polar.plot([0, 1, 2], [1, 2, 1], zorder=3)
        surface = fig.add_subplot(132, projection="3d")
        surface.plot([0, 1], [0, 1], [0, 1])
        diagram = fig.add_subplot(133)
        diagram.text(0.5, 0.5, "A -> B")
        diagram.set_axis_off()
        before = {side: spine.get_visible() for side, spine in polar.spines.items()}
        report = self.renderer.apply_deterministic_layout(fig)
        self.assertEqual({side: spine.get_visible() for side, spine in polar.spines.items()}, before)
        self.assertFalse(diagram.axison)
        self.assertTrue(all(item["status"] == "not_applicable" for item in report["rule_checks"][0]["axes"]))

    def test_pie_frame_stays_off(self):
        self.renderer.TEMPLATE_ID = "pie"
        fig, ax = plt.subplots()
        ax.pie([1, 2, 3])
        self.renderer.style_axis(ax, self.palette)
        report = self.renderer.apply_deterministic_layout(fig)
        self.assertFalse(ax.get_frame_on())
        self.assertEqual(report["rule_checks"][0]["axes"][0]["reason"], "pie")

    def test_runtime_checker_detects_broken_spine_and_save_rechecks(self):
        fig, ax = plt.subplots()
        ax.plot([1, 2, 3], [2, 4, 3], zorder=3)
        self.renderer.style_axis(ax, self.palette)
        ax.spines["right"].set_visible(False)
        fig.canvas.draw()
        self.assertFalse(self.renderer.check_rectangular_axis_frames(fig)["passed"])
        with tempfile.TemporaryDirectory(prefix="nexiom-axis-frame-") as temporary:
            target = Path(temporary) / "custom output" / "nested"
            paths = self.renderer.save_figure(fig, target, "chart", ["svg"], 120, self.palette)
            self.assertTrue(paths[0].is_file())
            report = json.loads((target / "chart.quality.json").read_text(encoding="utf-8"))
            self.assertTrue(report["rule_checks"][0]["passed"])
            self.assertEqual(self.renderer.RUNTIME_RULE_CHECKS, report["rule_checks"])
        self.assert_closed_frame(fig, ax)


if __name__ == "__main__":
    unittest.main(verbosity=2)

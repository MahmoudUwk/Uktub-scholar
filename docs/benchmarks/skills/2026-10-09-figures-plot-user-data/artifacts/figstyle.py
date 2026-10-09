"""Figure helpers for the uktub-figures skill. Needs only matplotlib (and numpy, which it depends on).

Copy this file next to the project's figure scripts (manuscript/figures/figstyle.py) so a figure stays reproducible after the session:

    from figstyle import COLUMN, TEXT, WIDE, PALETTE, use_style, figure, save
    use_style()
    fig, ax = figure(width=TEXT)
    ax.errorbar(x, mean, yerr=sd, color=PALETTE["blue"], marker="o", label="ours")
    ax.set_xlabel("Training-set size (examples)"); ax.set_ylabel("Accuracy (fraction correct)")
    save(fig, "manuscript/figures/accuracy_vs_size")   # .pdf, .png preview, .plotdata.json; prints the audit

`save` writes a vector PDF (TrueType fonts embedded) at the printed size, a PNG preview for looking at the result (never include the
preview in the paper), and a record of every plotted series. It prints `audit: clean` or lists each defect it found; fix the defects.
"""
import json
import math
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.text as mtext  # noqa: E402
from cycler import cycler  # noqa: E402
from matplotlib.container import BarContainer, ErrorbarContainer  # noqa: E402

COLUMN, TEXT, WIDE = 3.25, 5.5, 6.75  # inches: one column, a full text block, a two-column spread

# Okabe-Ito: distinguishable under the common colour-vision deficiencies and in greyscale. Colour belongs to the things compared;
# draw baselines, chance levels and guides in GREY.
PALETTE = {
    "blue": "#0072B2", "orange": "#E69F00", "green": "#009E73", "vermillion": "#D55E00",
    "sky": "#56B4E9", "purple": "#CC79A7", "yellow": "#F0E442", "black": "#000000",
}
GREY = "#7F7F7F"
MIN_FONT_PT = 5
_SIZES = (COLUMN, TEXT, WIDE)


def use_style(family="sans-serif", base=8):
    """Print-size defaults: one sans-serif face, small text, no top/right spines, vector-friendly fonts."""
    plt.rcParams.update({
        "font.family": family,
        "font.sans-serif": ["Helvetica", "Arial", "Liberation Sans", "DejaVu Sans"],
        "font.size": base, "axes.labelsize": base, "axes.titlesize": base,
        "xtick.labelsize": base - 1, "ytick.labelsize": base - 1, "legend.fontsize": base - 1,
        "axes.linewidth": 0.6, "xtick.major.width": 0.6, "ytick.major.width": 0.6,
        "lines.linewidth": 1.2, "lines.markersize": 4, "errorbar.capsize": 2,
        "axes.spines.top": False, "axes.spines.right": False, "legend.frameon": False,
        "axes.prop_cycle": cycler(color=[PALETTE[k] for k in ("blue", "orange", "green", "vermillion", "sky", "purple", "black")]),
        "pdf.fonttype": 42, "ps.fonttype": 42, "svg.fonttype": "none",
    })


def figure(width=TEXT, aspect=0.62, **kw):
    """One axes at the final printed width (never build large and rescale)."""
    fig, ax = plt.subplots(figsize=(width, width * aspect), constrained_layout=True, **kw)
    return fig, ax


def figure_grid(nrows, ncols, width=TEXT, aspect=0.62, **kw):
    """A grid of panels at the final printed width; pass sharey=True when panels share a quantity."""
    fig, axes = plt.subplots(nrows, ncols, figsize=(width, width * aspect), constrained_layout=True, **kw)
    return fig, axes


def panel_labels(axes, first="a"):
    """Bold lowercase panel letters at the top-left of each axes, in reading order."""
    flat = list(axes.flat) if hasattr(axes, "flat") else list(axes)
    for i, ax in enumerate(flat):
        ax.text(-0.02, 1.04, chr(ord(first) + i), transform=ax.transAxes, fontsize=9, fontweight="bold", va="bottom", ha="right")


def _num(v):
    f = float(v)
    return None if math.isnan(f) or math.isinf(f) else f


def plotted_series(fig):
    """Every plotted line, bar group and scatter of the figure, as plain numbers (what the picture actually shows)."""
    out = []
    for i, ax in enumerate(fig.axes):
        # errorbar() keeps its label on the container, not on the data line
        eb_label = {id(c.lines[0]): c.get_label() for c in ax.containers if isinstance(c, ErrorbarContainer) and c.lines[0] is not None}
        for line in ax.get_lines():
            if line.get_marker() in ("_", "|") and line.get_linestyle() in ("None", "none", ""):
                continue  # error-bar caps
            x, y = line.get_xdata(orig=False), line.get_ydata(orig=False)
            if len(x) >= 2:
                out.append({"axes": i, "kind": "line", "label": eb_label.get(id(line), line.get_label()), "x": [_num(v) for v in x], "y": [_num(v) for v in y]})
        for c in ax.containers:
            if isinstance(c, BarContainer):
                out.append({"axes": i, "kind": "bar", "label": c.get_label(),
                            "x": [_num(p.get_x() + p.get_width() / 2) for p in c.patches], "y": [_num(p.get_height()) for p in c.patches]})
        for coll in ax.collections:
            offsets = getattr(coll, "get_offsets", lambda: [])()
            if len(offsets) >= 2 and type(coll).__name__ == "PathCollection":
                out.append({"axes": i, "kind": "scatter", "label": coll.get_label(), "x": [_num(p[0]) for p in offsets], "y": [_num(p[1]) for p in offsets]})
    return out


def audit(fig):
    """Real defects only: width, missing axis labels, a title that belongs in the caption, unreadable text, text off the canvas."""
    issues = []
    width = fig.get_size_inches()[0]
    if min(abs(width - s) for s in _SIZES) > 0.02:
        issues.append(f"width {width:g} in is not a page width (COLUMN {COLUMN}, TEXT {TEXT}, WIDE {WIDE}); build at the printed size")
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    canvas = fig.bbox
    for i, ax in enumerate(fig.axes):
        if not (ax.lines or ax.patches or ax.collections or ax.images):
            continue
        if ax.get_title():
            issues.append(f"axes {i} has a title ({ax.get_title()!r}); the caption is the title")
        if not ax.get_xlabel():
            issues.append(f"axes {i} has no x label (say what it is, with units)")
        if not ax.get_ylabel():
            issues.append(f"axes {i} has no y label (say what it is, with units)")
        placed = [ax.xaxis.label, ax.yaxis.label, ax.title, *ax.texts]
        if ax.get_legend() is not None:
            placed += ax.get_legend().get_texts()
        for t in placed:
            if t.get_text().strip() and t.get_visible():
                b = t.get_window_extent(renderer)
                if b.x0 < canvas.x0 - 1 or b.x1 > canvas.x1 + 1 or b.y0 < canvas.y0 - 1 or b.y1 > canvas.y1 + 1:
                    issues.append(f"text off the canvas: {t.get_text()[:40]!r}")
    for t in fig.findobj(mtext.Text):
        if t.get_text().strip() and t.get_visible() and t.get_fontsize() < MIN_FONT_PT:
            issues.append(f"text under {MIN_FONT_PT} pt ({t.get_fontsize():g} pt): {t.get_text()[:40]!r}")
    return issues


def save(fig, base):
    """Write base.pdf (vector), base.png (preview) and base.plotdata.json, print the audit, return the list of defects."""
    folder = os.path.dirname(base)
    if folder:
        os.makedirs(folder, exist_ok=True)
    issues = audit(fig)
    series = plotted_series(fig)
    fig.savefig(base + ".pdf")
    fig.savefig(base + ".png", dpi=200)
    w, h = fig.get_size_inches()
    with open(base + ".plotdata.json", "w", encoding="utf8") as f:
        json.dump({"width_in": w, "height_in": h, "series": series}, f, indent=1)
    print(f"wrote {base}.pdf ({w:g} x {h:.2f} in, vector), {base}.png (preview only), {base}.plotdata.json ({len(series)} series)")
    if issues:
        print(f"audit: {len(issues)} issue(s)")
        for text in issues:
            print(f"  - {text}")
    else:
        print("audit: clean")
    plt.close(fig)
    return issues

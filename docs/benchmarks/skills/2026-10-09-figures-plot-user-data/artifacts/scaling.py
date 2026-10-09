import csv
import sys
from collections import defaultdict
import matplotlib.ticker as ticker
import numpy as np

sys.path.insert(0, "manuscript/figures")
from figstyle import COLUMN, PALETTE, GREY, use_style, figure, save

def main():
    data = defaultdict(lambda: defaultdict(list))
    with open("data/accuracy.csv", mode="r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            method = row["method"]
            size = int(row["train_size"])
            acc = float(row["accuracy"])
            data[method][size].append(acc)

    use_style()
    fig, ax = figure(width=COLUMN)

    # Ours: PALETTE["blue"], solid line, circular markers
    sizes_ours = sorted(data["ours"].keys())
    means_ours = [np.mean(data["ours"][s]) for s in sizes_ours]
    sds_ours = [np.std(data["ours"][s], ddof=1) for s in sizes_ours]
    ax.errorbar(
        sizes_ours,
        means_ours,
        yerr=sds_ours,
        color=PALETTE["blue"],
        linestyle="-",
        marker="o",
        label="Ours",
    )

    # Baseline: GREY, dashed line, square markers
    sizes_base = sorted(data["baseline"].keys())
    means_base = [np.mean(data["baseline"][s]) for s in sizes_base]
    sds_base = [np.std(data["baseline"][s], ddof=1) for s in sizes_base]
    ax.errorbar(
        sizes_base,
        means_base,
        yerr=sds_base,
        color=GREY,
        linestyle="--",
        marker="s",
        label="Baseline",
    )

    ax.set_xscale("log")
    ax.set_xticks(sizes_ours)
    ax.set_xticklabels([str(s) for s in sizes_ours])
    ax.get_xaxis().set_minor_locator(ticker.NullLocator())

    ax.set_xlabel("Training-set size (examples, log scale)")
    ax.set_ylabel("Accuracy (fraction correct)")
    ax.set_ylim(0.4, 0.75)
    handles, labels = ax.get_legend_handles_labels()
    from matplotlib.container import ErrorbarContainer
    clean_handles = [h[0] if isinstance(h, ErrorbarContainer) else h for h in handles]
    ax.legend(clean_handles, labels, loc="upper left")

    save(fig, "manuscript/figures/accuracy_scaling")

if __name__ == "__main__":
    main()

# Regenerates leaderboard.png and think_ab.png from results.json.
# Usage: python3 charts.py  (run from this directory)
import json

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

pub = json.load(open('results.json'))
rows = pub['results'] if isinstance(pub, dict) and 'results' in pub else pub
data = []
for m in rows:
    data.append({
        'model': m['model'], 'overall': m['overall'] * 100,
        'flips': m['flippedTotal'], 'ctok': m['batteryTokens'],
        'think': m.get('thinkMode'),
    })
data.sort(key=lambda r: (-r['overall'], r['flips'], r['ctok']))

# ---- leaderboard ----
fig, ax = plt.subplots(figsize=(11, max(8, len(data) * 0.32)))
names = [d['model'] for d in data][::-1]
scores = [d['overall'] for d in data][::-1]
colors = ['#2e7d32' if s == 100 else '#1976d2' if s >= 95 else '#f9a825' if s >= 85 else '#c62828' for s in scores]
bars = ax.barh(names, scores, color=colors)
for bar, d in zip(bars, data[::-1]):
    ax.text(bar.get_width() + 0.4, bar.get_y() + bar.get_height() / 2,
            f"{d['overall']:.0f}%  ·  {d['ctok']:,} ctok", va='center', fontsize=7)
ax.set_xlim(0, 118)
ax.set_xlabel('Overall score (deterministic checks, 3 reps)')
ax.set_title('Local Model Eval — Leaderboard (score · cost)', fontsize=13, pad=12)
ax.tick_params(axis='y', labelsize=7.5)
from matplotlib.patches import Patch
ax.legend(handles=[
    Patch(color='#2e7d32', label='100%'), Patch(color='#1976d2', label='95–99%'),
    Patch(color='#f9a825', label='85–94%'), Patch(color='#c62828', label='<85%'),
], loc='lower right', fontsize=8)
plt.tight_layout()
plt.savefig('leaderboard.png', dpi=160)
plt.close()

# ---- think A/B (models with both on and off rows) ----
base = {}
for d in data:
    if '@think=' not in d['model']:
        continue
    name, mode = d['model'].split('@think=')
    base.setdefault(name, {})[mode] = d
pairs = {k: v for k, v in base.items() if 'on' in v and 'off' in v}
names = sorted(pairs, key=lambda k: pairs[k]['on']['overall'] - pairs[k]['off']['overall'])
fig, ax = plt.subplots(figsize=(10, max(6, len(names) * 0.5)))
y = range(len(names))
on = [pairs[n]['on']['overall'] for n in names]
off = [pairs[n]['off']['overall'] for n in names]
ax.hlines(y, off, on, color='#9e9e9e', linewidth=1.5, zorder=1)
ax.scatter(on, y, color='#7b1fa2', label='think=on', zorder=2, s=45)
ax.scatter(off, y, color='#00838f', label='think=off', zorder=2, s=45)
ax.set_yticks(list(y))
ax.set_yticklabels(names, fontsize=8.5)
ax.set_xlabel('Overall score')
ax.set_title('Think A/B — thinking value is a per-model property', fontsize=13, pad=12)
ax.legend(loc='upper left', fontsize=9)
ax.grid(axis='x', alpha=0.25)
plt.tight_layout()
plt.savefig('think_ab.png', dpi=160)
plt.close()
print(f'charts regenerated: leaderboard ({len(data)} rows), think A/B ({len(names)} pairs)')

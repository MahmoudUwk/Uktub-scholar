# Builds rows.json: real supported/unsupported (claim, passage) pairs from claim-verification-v2, encoded exactly as the product's torch-free Python encoder does,
# plus the logits the SAME Q8 graph gives on ONNX Runtime CPU: the reference a browser run is compared with.
import importlib.util, json, os, random, re, sys
import numpy as np, onnxruntime as ort
from tokenizers import Tokenizer
REPO = '/home/mahmoud/Desktop/AI_Projects/UktubAI/Uktub-scholar'
M = os.path.expanduser('~/.cache/uktub-scholar/models/eos-onnx-6369be38417e')
spec = importlib.util.spec_from_file_location('d2onnx', REPO + '/scripts/decision2_onnx.py'); mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
tok = Tokenizer.from_file(M + '/tokenizer.json')
claims = json.load(open(REPO + '/benchmarks/datasets/claim-verification-v2/claims.json'))['claims']
home = os.path.expanduser('~/.cache/uktub-bench')
def chunk(paper, quote):
    t = open(f'{home}/v2-corpus/text/{paper}.txt', encoding='utf-8', errors='ignore').read()
    w = (quote or '').split()[:5]; m = re.search(r'\s+'.join(re.escape(x) for x in w), t) if w else None
    if not m: return None
    s = max(0, m.start() - 500); return t[s:s + 1500]
random.seed(11); T = [c for c in claims if c['label'] == 'TRUE']; F = [c for c in claims if c['type'] in ('perturbed', 'contradiction')]
random.shuffle(T); random.shuffle(F); rows = []
for c in T:
    ch = chunk(c['paper'], c['evidence_quote'])
    if ch and sum(r['label'] == 'TRUE' for r in rows) < 3: rows.append({'label': 'TRUE', 'state': ch, 'claim': c['claim']})
for c in F:
    ch = chunk(c['paper'], c['evidence_quote'] or c['altered_from_quote'])
    if ch and sum(r['label'] == 'FALSE' for r in rows) < 3: rows.append({'label': 'FALSE', 'state': ch, 'claim': c['claim']})
sess = ort.InferenceSession(M + '/onnx/model_quantized.onnx', providers=['CPUExecutionProvider'])
print('inputs:', [(i.name, i.type, i.shape) for i in sess.get_inputs()], '| outputs:', [(o.name, o.shape) for o in sess.get_outputs()])
out = []
for r in rows:
    ids, opt, ans = mod.encode_prompt(tok, r['state'], r['claim'])
    x = np.array([ids], dtype=np.int64)
    (lg,) = sess.run(None, {'input_ids': x, 'attention_mask': np.ones_like(x), 'answer_pos': np.array([ans], dtype=np.int64), 'option_pos': np.array([opt], dtype=np.int64)})
    z = lg[0].astype(np.float64); p = np.exp(z - z.max()); p /= p.sum()
    out.append({'label': r['label'], 'ids': ids, 'answer_pos': ans, 'option_pos': opt, 'logits': z.tolist(), 'p_true': float(p[0]), 'tokens': len(ids)})
json.dump(out, open(os.path.dirname(os.path.abspath(__file__)) + '/rows.json', 'w'))
print('rows:', [(o['label'][0], o['tokens'], round(o['p_true'], 4)) for o in out])

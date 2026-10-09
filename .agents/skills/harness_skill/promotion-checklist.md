# Candidate Promotion Checklist

- [ ] Diff contains no benchmark/task-specific logic.
- [ ] Candidate evaluated under the same protocol as incumbent.
- [ ] Failed/missing runs counted consistently.
- [ ] Score is at least `S_best - delta`.
- [ ] Added cost is justified by measured gain, or within-band candidate materially reduces cost / tests a new structural mechanism.
- [ ] Domain guards pass.
- [ ] Exact diff, hypothesis, score delta, cost delta, and decision are logged.
- [ ] Rollback snapshot exists before promotion.
- [ ] Held-out/OOD surfaces were not used to tune this candidate.

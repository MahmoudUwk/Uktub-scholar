# Work brief for Hermes (template; copy to `<workdir>/TASK.md` and fill every line)

Hermes knows nothing of the conversation. Everything it needs is here or in files in the working directory. Pre-decide what the task depends on so it never has to stop and ask.

You are a worker subagent. Do the task below completely, then stop and report.

CONTEXT: <what this is for, in two or three sentences; which project, which convention to match; point it at one or two example files in the working directory and say "match their style">

WORKING DIRECTORY: <the scratch directory it starts in; the files it may read and edit; paths outside it that it may read, run or write, each named>

MACHINE STATE (what is already running or limited): <for example "a benchmark is timing the GPU; do not use the GPU, run on CPU only" or "the GPU is free, 8 GB"; network allowed or not; may it install packages and into which environment; may it download, from where, how large>

DECIDED (do not re-litigate): <pinned revisions and file names, the protocol or interface to implement, wording that must be reproduced exactly, the library versions to use>

TASK: <numbered steps. For code, test first: write the tests, see them fail for the right reason against a stub, then implement and see them pass. For anything that runs third-party code, first read that code and write `REVIEW.md` (network calls, subprocess, eval or exec, file writes outside its cache); if it does any of those, stop and report instead of running it.>

DONE WHEN: <a command whose output proves it, and what that output must show>

DO NOT: commit, push, publish, send anything, spend money, read credentials, or touch anything not named above.

REPORT (at most 10 lines): the files written or changed, the proof that the task is done (the command and its result), anything unclear or decided on your own, and anything that needs the orchestrator's review.

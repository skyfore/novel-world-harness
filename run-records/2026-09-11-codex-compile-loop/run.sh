#!/bin/bash
set -u
cd /root/workplace/novel-world-harness || exit 1
NODE=/root/.nvm/versions/node/v22.19.0/bin/node
"$NODE" --import tsx run-records/2026-09-11-codex-compile-loop/worker.ts
compiler_exit=$?
"$NODE" --import tsx run-records/2026-09-11-codex-compile-loop/notify.ts "$compiler_exit"
callback_exit=$?
if [ "$callback_exit" -ne 0 ]; then exit "$callback_exit"; fi
exit "$compiler_exit"

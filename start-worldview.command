#!/bin/bash
cd "$(dirname "$0")"
open http://localhost:8787 >/dev/null 2>&1 || true
node server.mjs

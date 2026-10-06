---
name: wake-testing
description: Wake testing conventions for this repo
metadata:
  type: project
---

Fixtures are synthetic; never commit real session data. Run scripts/test.sh after every
non-trivial change, and the qrcode scanner regression needs a real fixture file.

#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Runs the tests of the cetli extension with node (>= 22) against fakes of the GNOME APIs.
set -eu
cd "$(dirname "${BASH_SOURCE[0]}")"
node --import ./register.mjs --test placement.test.mjs extension.test.mjs static.test.mjs

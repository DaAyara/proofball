#!/usr/bin/env bash
# Fetches TxLINE's published IDL files so we can check our hand written
# CPI bindings in programs/proofball/src/txline.rs against the real
# thing, and ideally replace them with generated code instead.
#
# Run this first thing once you are in Codespaces with network access.
set -euo pipefail

mkdir -p docs/txline-idl

echo "Fetching devnet IDL..."
curl -fsSL https://txline-docs.txodds.com/documentation/programs/devnet.md \
  -o docs/txline-idl/devnet.md

echo "Fetching mainnet IDL..."
curl -fsSL https://txline-docs.txodds.com/documentation/programs/mainnet.md \
  -o docs/txline-idl/mainnet.md

echo "Fetching OpenAPI spec for the off chain API..."
curl -fsSL https://txline-docs.txodds.com/api-reference/openapi.json \
  -o docs/txline-idl/openapi.json

echo ""
echo "Done. Files are in docs/txline-idl/"
echo "Next: open devnet.md, find the validateStat instruction, and check"
echo "that it matches programs/proofball/src/txline.rs. If it differs,"
echo "fix txline.rs to match the real thing before testing settlement."

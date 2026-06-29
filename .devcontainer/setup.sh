#!/usr/bin/env bash
# Runs automatically the first time the Codespace builds.
# Installs Solana CLI and Anchor CLI, since the base devcontainer
# image only gives us Rust and Node.
set -e

echo "Installing Solana CLI..."
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
echo 'export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

echo "Installing Anchor version manager..."
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest

echo "Generating a local wallet for devnet testing..."
solana-keygen new --no-bip39-passphrase --silent --outfile ~/.config/solana/id.json || true
solana config set --url devnet

echo "Installing node dependencies..."
npm install
(cd verify && npm install)

echo ""
echo "Setup done. Next steps:"
echo "  1. solana airdrop 2 --url devnet"
echo "  2. bash scripts/download_idl.sh"
echo "  3. anchor build"

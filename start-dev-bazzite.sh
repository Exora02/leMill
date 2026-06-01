#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

CONTAINER_NAME="lemill-dev"

echo "=== leMill Bazzite/Distrobox Launcher ==="

# Check if distrobox is installed (standard on Bazzite)
if ! command -v distrobox &> /dev/null; then
    echo "Error: 'distrobox' could not be found. This script requires a Distrobox-equipped OS like Bazzite."
    exit 1
fi

# Ensure the lemill-dev container exists
if ! distrobox list | grep -q "$CONTAINER_NAME"; then
    echo "Container '$CONTAINER_NAME' not found. Please run 'distrobox create -n $CONTAINER_NAME --image ubuntu:latest' first."
    exit 1
fi

echo "Starting devenv environment inside '$CONTAINER_NAME'..."

# Start the environment
# We use bash -l so it loads the Nix environment variables before running devenv
distrobox enter "$CONTAINER_NAME" -- bash -l -c "devenv sh -c 'devenv up'"

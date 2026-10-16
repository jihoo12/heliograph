#!/bin/sh
# Builds dist/ and copies it into docs/lib for the GitHub Pages demo.
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist docs/lib
esbuild src/index.js --bundle --format=esm --minify --outfile=dist/heliograph.min.js
esbuild src/index.js --bundle --format=iife --global-name=Heliograph --minify --outfile=dist/heliograph.iife.js
esbuild src/heliograph.css --minify --outfile=dist/heliograph.min.css
cp src/heliograph.css dist/heliograph.css
cp dist/* docs/lib/

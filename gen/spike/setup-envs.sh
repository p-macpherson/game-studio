#!/usr/bin/env bash
# Python environments for the M4a spike, one per model family (their dependencies conflict).
set -euo pipefail
GEN="${GEN:-$HOME/.local/share/game-studio/gen}"
TORCH_CU130=(--index-url https://download.pytorch.org/whl/cu130 --extra-index-url https://pypi.org/simple)

mk() { [[ -d "$GEN/envs/$1" ]] || uv venv -q --python 3.11 "$GEN/envs/$1"; }
pip() { local env=$1; shift; VIRTUAL_ENV="$GEN/envs/$env" uv pip install -q "$@"; }

echo ">> image (FLUX.2 Klein)"
mk image
pip image "${TORCH_CU130[@]}" torch==2.14.1 torchvision
pip image 'diffusers>=0.36' transformers accelerate sentencepiece protobuf pillow

echo ">> hunyuan3d (shape + texture; texture extensions are compiled later, once the CUDA toolkit is installed)"
mk hunyuan3d
pip hunyuan3d "${TORCH_CU130[@]}" torch==2.14.1 torchvision
pip hunyuan3d -r "$GEN/src/Hunyuan3D-2/requirements.txt" 'transformers==4.49.0' 'diffusers==0.32.2'  # newer transformers renames the DINOv2 weights
pip hunyuan3d -e "$GEN/src/Hunyuan3D-2"
echo ">> unirig (rigging)"
# UniRig needs flash-attn, spconv and torch_scatter/torch_cluster. All three have prebuilt wheels only for
# older torch/CUDA combinations: torch 2.7.0 + CUDA 12.6 is the newest they share (the driver runs it fine).
mk unirig
pip unirig --index-url https://download.pytorch.org/whl/cu126 --extra-index-url https://pypi.org/simple torch==2.7.0 torchvision==0.22.0
FA=https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu12torch2.7cxx11abiTRUE-cp311-cp311-linux_x86_64.whl
pip unirig "flash_attn @ $FA" spconv-cu126==2.3.8 \
	torch_scatter torch_cluster --find-links https://data.pyg.org/whl/torch-2.7.0+cu126.html
pip unirig -r "$GEN/src/UniRig/requirements.txt" --find-links https://data.pyg.org/whl/torch-2.7.0+cu126.html "flash_attn @ $FA" 'numpy==1.26.4'
echo ">> envs done"

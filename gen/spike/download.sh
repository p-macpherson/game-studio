#!/usr/bin/env bash
# Downloads only the weights the M4a spike needs (safetensors, one variant each) into $GEN/models/<org>/<repo>.
set -euo pipefail
GEN="${GEN:-$HOME/.local/share/game-studio/gen}"
hf() { uvx --quiet --from 'huggingface_hub[cli,hf_xet]==2.4.0' hf download "$@"; }
# get REPO INCLUDE... [-- EXCLUDE...]: each pattern needs its own --include/--exclude flag.
get() {
	local repo=$1 flag=--include args=(); shift
	for p in "$@"; do if [[ $p == -- ]]; then flag=--exclude; else args+=("$flag" "$p"); fi; done
	echo ">> $repo"
	hf "$repo" --local-dir "$GEN/models/$repo" "${args[@]}" >/dev/null
}

get black-forest-labs/FLUX.2-klein-4B 'model_index.json' 'scheduler/*' 'tokenizer/*' 'text_encoder/*' 'transformer/*' 'vae/*'
get tencent/Hunyuan3D-2mini 'hunyuan3d-dit-v2-mini-turbo/config.yaml' 'hunyuan3d-dit-v2-mini-turbo/*.safetensors' 'hunyuan3d-vae-v2-mini-turbo/config.yaml' 'hunyuan3d-vae-v2-mini-turbo/*.safetensors'
get tencent/Hunyuan3D-2mv 'hunyuan3d-dit-v2-mv-turbo/config.yaml' 'hunyuan3d-dit-v2-mv-turbo/*.safetensors'
get tencent/Hunyuan3D-2 'hunyuan3d-vae-v2-0-turbo/*' 'hunyuan3d-delight-v2-0/*' 'hunyuan3d-paint-v2-0-turbo/*' -- '*.ckpt' 'hunyuan3d-paint-v2-0-turbo/unet/diffusion_pytorch_model.safetensors'  # the code loads the .bin; the safetensors is a different (IP-adapter) variant
get VAST-AI/UniRig 'skeleton/articulation-xl_quantization_256/*' 'skin/articulation-xl/*'
echo ">> done"; du -sh "$GEN/models"/*/*

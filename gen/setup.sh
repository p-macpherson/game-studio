#!/usr/bin/env bash
# Installs everything local asset generation needs, idempotently (re-run it to repair or update):
#   $GAME_STUDIO_GEN (default ~/.local/share/game-studio/gen)
#     src/      upstream model repos, pinned, with our patches (gen/patches/)
#     models/   weights (safetensors where the code accepts them; ~42 GB)
#     envs/     one Python environment per model family (their dependencies conflict)
#     hf/       a Hugging Face cache for the few small files libraries fetch by name
# Needs: git, uv, blender, an NVIDIA GPU, and the CUDA toolkit (nvcc) to build Hunyuan3D's texture rasteriser.
set -euo pipefail

GEN="${GAME_STUDIO_GEN:-$HOME/.local/share/game-studio/gen}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CUDA_HOME="${CUDA_HOME:-/opt/cuda}"
HF_CLI=(uvx --quiet --from 'huggingface_hub[cli,hf_xet]==2.4.0' hf)
mkdir -p "$GEN"/{src,models,envs,hf,logs}

step() { echo; echo "== $*"; }
fail() { echo "error: $*" >&2; exit 1; }

step "Checking prerequisites"
for tool in git uv blender nvidia-smi; do command -v "$tool" >/dev/null || fail "$tool is not installed"; done
[[ -x "$CUDA_HOME/bin/nvcc" ]] || fail "the CUDA toolkit wasn't found at $CUDA_HOME (install the 'cuda' package, or set CUDA_HOME)"
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader

# clone NAME URL COMMIT: a pinned checkout with every gen/patches/NAME-*.patch applied.
clone() {
	local name=$1 url=$2 commit=$3 dir="$GEN/src/$1"
	[[ -d "$dir/.git" ]] || git clone --quiet "$url" "$dir"
	if [[ "$(git -C "$dir" rev-parse HEAD)" != "$commit" ]]; then
		git -C "$dir" fetch --quiet origin "$commit" 2>/dev/null || git -C "$dir" fetch --quiet origin
		git -C "$dir" checkout --quiet --force "$commit"
	fi
	for patch in "$HERE"/patches/"${name,,}"-*.patch; do
		[[ -e "$patch" ]] || continue
		if git -C "$dir" apply --reverse --check "$patch" 2>/dev/null; then
			echo "   $(basename "$patch"): already applied"
		else
			git -C "$dir" apply "$patch" && echo "   $(basename "$patch"): applied"
		fi
	done
}

# get REPO REVISION INCLUDE... [-- EXCLUDE...]: selected files of a Hugging Face repo, at an exact commit, into
# models/REPO (skips what's there). Pinned so a repair or a second machine gets the weights the code was tested with.
get() {
	local repo=$1 revision=$2 flag=--include args=(); shift 2
	for p in "$@"; do if [[ $p == -- ]]; then flag=--exclude; else args+=("$flag" "$p"); fi; done
	echo "   $repo"
	HF_HOME="$GEN/hf" "${HF_CLI[@]}" download "$repo" --revision "$revision" --local-dir "$GEN/models/$repo" "${args[@]}" >/dev/null
}

env_python() { echo "$GEN/envs/$1/bin/python"; }
mkenv() { [[ -x "$(env_python "$1")" ]] || uv venv -q --python 3.11 "$GEN/envs/$1"; }
# pip ENV ARGS...: installs into an environment, held to the versions in gen/locks/ENV.txt (every package, direct or
# not, as last known to work together) when that file exists.
pip() {
	local env=$1 lock="$HERE/locks/$1.txt"; shift
	local held=(); [[ -f "$lock" ]] && held=(-c "$lock")
	VIRTUAL_ENV="$GEN/envs/$env" uv pip install -q "${held[@]}" "$@"
}
TORCH_CU130=(--index-url https://download.pytorch.org/whl/cu130 --extra-index-url https://pypi.org/simple)

step "Model repos"
clone Hunyuan3D-2 https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git f8db63096c8282cb27354314d896feba5ba6ff8a
clone UniRig https://github.com/VAST-AI-Research/UniRig.git 6793c6640ff01c8fb389f3993434124bb43d2933

step "Model weights (about 42 GB the first time)"
get black-forest-labs/FLUX.2-klein-4B e7b7dc27f91deacad38e78976d1f2b499d76a294 'model_index.json' 'scheduler/*' 'tokenizer/*' 'text_encoder/*' 'transformer/*' 'vae/*'
get tencent/Hunyuan3D-2mini f90a0f7df7d5e6f71109cf333f6a95a0ae3194a6 'hunyuan3d-dit-v2-mini-turbo/config.yaml' 'hunyuan3d-dit-v2-mini-turbo/*.safetensors' 'hunyuan3d-vae-v2-mini-turbo/config.yaml' 'hunyuan3d-vae-v2-mini-turbo/*.safetensors'
get tencent/Hunyuan3D-2mv 3a761b539b29fe4ff64714813aa9560fd66f5de0 'hunyuan3d-dit-v2-mv-turbo/config.yaml' 'hunyuan3d-dit-v2-mv-turbo/*.safetensors'
# The paint code loads unet/diffusion_pytorch_model.bin; the .safetensors beside it is a different (IP-adapter) variant.
get tencent/Hunyuan3D-2 9cd649ba6913f7a852e3286bad86bfa9a2d83dcf 'hunyuan3d-vae-v2-0-turbo/*' 'hunyuan3d-delight-v2-0/*' 'hunyuan3d-paint-v2-0-turbo/*' -- '*.ckpt' 'hunyuan3d-paint-v2-0-turbo/unet/diffusion_pytorch_model.safetensors'
get VAST-AI/UniRig 36842e2b5947e9e60f89275b83208c8e74071c63 'skeleton/articulation-xl_quantization_256/*' 'skin/articulation-xl/*'
# UniRig only needs this model's config (its skeleton model is built on OPT's architecture).
HF_HOME="$GEN/hf" "${HF_CLI[@]}" download facebook/opt-350m --revision 08ab08cc4b72ff5593870b5d527cf4230323703c config.json >/dev/null

step "Music: GeneralUser GS SoundFont (v2.0.3; free for any music, including commercial)"
SF2="$GEN/models/soundfonts/GeneralUser-GS.sf2"
if [[ -s "$SF2" ]]; then
	echo "   already downloaded"
else
	mkdir -p "$(dirname "$SF2")"
	curl -fsSL -o "$SF2.part" https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/684543d5e5efaef08d02be50dcda8d552478fa60/GeneralUser-GS.sf2
	mv "$SF2.part" "$SF2"
	echo "   downloaded"
fi
for cmd in fluidsynth ffmpeg; do
	command -v "$cmd" >/dev/null || echo "   warning: $cmd isn't installed; music rendering needs it (sudo pacman -S $cmd)"
done

step "Sound effects: Stable Audio Open Small + CLAP (Stability AI Community License: free under \$1M annual revenue)"
# Gated on Hugging Face: accept the licence at https://huggingface.co/stabilityai/stable-audio-open-small and log
# this cache in once with: HF_HOME=$GEN/hf uvx --from 'huggingface_hub[cli,hf_xet]==2.4.0' hf auth login
get stabilityai/stable-audio-open-small ea2772170fc06f80dfd02bea6e57a44d9d4bc9d3 model.safetensors model_config.json LICENSE \
	|| echo "   warning: couldn't download Stable Audio Open Small (accept its licence and log in, see above); sound generation is off"
get laion/larger_clap_general ada0c23a36c4e8582805bb38fec3905903f18b41
# The model's T5 text encoder is loaded by name; the worker runs offline from this cache.
HF_HOME="$GEN/hf" "${HF_CLI[@]}" download t5-base --revision a9723ea7f1b39c1eae772870f3b547bf6ef7e6c1 config.json spiece.model tokenizer.json model.safetensors >/dev/null

step "Environment: image (FLUX.2 Klein)"
mkenv image
pip image "${TORCH_CU130[@]}" torch==2.14.1 torchvision
pip image 'diffusers==0.43.0' 'transformers==5.23.0' accelerate sentencepiece protobuf pillow

step "Environment: hunyuan3d (shape + texture)"
mkenv hunyuan3d
pip hunyuan3d "${TORCH_CU130[@]}" torch==2.14.1 torchvision
# Newer transformers renames the DINOv2 weights Hunyuan3D-2 loads.
pip hunyuan3d -r "$GEN/src/Hunyuan3D-2/requirements.txt" 'transformers==4.49.0' 'diffusers==0.32.2'
pip hunyuan3d -e "$GEN/src/Hunyuan3D-2"
if "$(env_python hunyuan3d)" -c 'import torch, custom_rasterizer, mesh_processor' 2>/dev/null; then
	echo "   texture extensions: already built"
else
	echo "   building texture extensions (custom_rasterizer needs nvcc)"
	for ext in custom_rasterizer differentiable_renderer; do
		(cd "$GEN/src/Hunyuan3D-2/hy3dgen/texgen/$ext" && CUDA_HOME="$CUDA_HOME" PATH="$CUDA_HOME/bin:$GEN/envs/hunyuan3d/bin:$PATH" \
			TORCH_CUDA_ARCH_LIST="${TORCH_CUDA_ARCH_LIST:-$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -1)}" \
			VIRTUAL_ENV="$GEN/envs/hunyuan3d" uv pip install -q --no-build-isolation .)
	done
fi

step "Environment: unirig (rigging)"
# flash-attn, spconv and torch_scatter/torch_cluster only have prebuilt wheels together for torch 2.7.0 + CUDA 12.6.
mkenv unirig
pip unirig --index-url https://download.pytorch.org/whl/cu126 --extra-index-url https://pypi.org/simple torch==2.7.0 torchvision==0.22.0
FA=https://github.com/Dao-AILab/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu12torch2.7cxx11abiTRUE-cp311-cp311-linux_x86_64.whl
pip unirig -r "$GEN/src/UniRig/requirements.txt" --find-links https://data.pyg.org/whl/torch-2.7.0+cu126.html \
	"flash_attn @ $FA" spconv-cu126==2.3.8 torch_scatter torch_cluster 'numpy==1.26.4'
# UniRig's skin checkpoint pickles its config as a python-box Box: allow exactly that class for torch's safe loader.
cat > "$("$(env_python unirig)" -c 'import site; print(site.getsitepackages()[0])')/sitecustomize.py" <<'PY'
# Game Studio: UniRig's skin checkpoint pickles its config as a python-box Box. Allow exactly that class
# for torch.load(weights_only=True) instead of disabling the safe loader.
try:
    import box
    import torch.serialization

    torch.serialization.add_safe_globals([box.Box])
except ImportError:
    pass
PY
# UniRig looks for checkpoints under experiments/ when it can't download them (the worker runs offline).
mkdir -p "$GEN/src/UniRig/experiments/skeleton" "$GEN/src/UniRig/experiments/skin"
ln -sfn "$GEN/models/VAST-AI/UniRig/skeleton/articulation-xl_quantization_256" "$GEN/src/UniRig/experiments/skeleton/articulation-xl_quantization_256"
ln -sfn "$GEN/models/VAST-AI/UniRig/skin/articulation-xl" "$GEN/src/UniRig/experiments/skin/articulation-xl"

step "Environment: stable-audio (sound effects)"
# stable-audio-tools 0.0.20 pins Python < 3.11 and torch 2.7.1. Its inference code imports pytorch_lightning (only
# declared by its train extra), and its pinned PyWavelets is built for NumPy 1.
if [[ ! -x "$(env_python stable-audio)" ]]; then uv venv -q --python 3.10 "$GEN/envs/stable-audio"; fi
pip stable-audio --index-url https://download.pytorch.org/whl/cu128 --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match \
	torch==2.7.1 torchaudio==2.7.1 stable-audio-tools==0.0.20 pytorch_lightning==2.5.5 'numpy<2' soundfile

step "Checking the environments"
"$(env_python image)" -c 'import torch, diffusers; assert torch.cuda.is_available(); print("   image ok", torch.__version__)'
"$(env_python hunyuan3d)" -c 'import torch, hy3dgen, custom_rasterizer, mesh_processor; assert torch.cuda.is_available(); print("   hunyuan3d ok", torch.__version__)'
"$(env_python unirig)" -c 'import torch, flash_attn, spconv.pytorch, torch_scatter, bpy; assert torch.cuda.is_available(); print("   unirig ok", torch.__version__)'
"$(env_python stable-audio)" -c 'import torch, stable_audio_tools.inference.generation, transformers; assert torch.cuda.is_available(); print("   stable-audio ok", torch.__version__)'
du -sh "$GEN/models" | sed 's/^/   weights: /'
echo "Asset generation is ready."

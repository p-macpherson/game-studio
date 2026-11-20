# P3-SAM spike (part segmentation for rigid rigs)

Findings are in the vault note `M4 3D Models.md` ("Part segmentation spike"). Not integrated.

Setup used (outside the repo, in `~/.local/share/game-studio/gen/spike-p3sam/`):

```sh
S=~/.local/share/game-studio/gen/spike-p3sam
git clone https://github.com/Tencent-Hunyuan/Hunyuan3D-Part.git $S/src   # e96be06
# P3-SAM/model.py: sonata.load(os.environ.get("SONATA_CKPT", "sonata"), repo_id="facebook/sonata")  (was download_root='/root/sonata')
uv venv --python 3.11 $S/env    # then UniRig's wheel set: torch 2.7.0 + torchvision 0.22.0 (cu126), flash-attn 2.8.3,
                                # spconv-cu126, torch_scatter, numpy 1.26.4, plus timm huggingface_hub trimesh fpsample
                                # numba scikit-learn safetensors addict omegaconf (re-pin torch after timm)
hf download facebook/sonata sonata.pth                            # CC-BY-NC 4.0 weights
hf download tencent/Hunyuan3D-Part p3sam/p3sam.safetensors
SONATA_CKPT=.../sonata.pth $S/env/bin/python run.py robot.glb out/robot      # 25 s, 6.9 GB VRAM (PROMPT_BS=4)
blender -b -P viz.py -- out/robot out/robot-parts                          # parts in colours
blender -b -P rigidify.py -- animated.glb out/robot rigid.glb              # each part bound to its dominant bone
```

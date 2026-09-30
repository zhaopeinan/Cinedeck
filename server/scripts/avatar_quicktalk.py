#!/usr/bin/env python3
"""Prepare photo/video+audio and run OpenTalking QuickTalk bench for one avatar job."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import wave
from pathlib import Path


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd)


def find_input(job_dir: Path, prefixes: tuple[str, ...], exts: tuple[str, ...]) -> Path:
    for p in sorted(job_dir.iterdir()):
        if not p.is_file():
            continue
        name = p.name.lower()
        if any(name.startswith(pref) for pref in prefixes) and p.suffix.lower() in exts:
            return p
    raise FileNotFoundError(f"No matching file in {job_dir} for {prefixes}{exts}")


def audio_duration_sec(wav_path: Path) -> float:
    with wave.open(str(wav_path), "rb") as wf:
        return wf.getnframes() / float(wf.getframerate())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-dir", required=True)
    parser.add_argument("--asset-root", default="/workspace/models/quicktalk")
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--max-audio-seconds", type=float, default=120.0)
    parser.add_argument(
        "--skip-prepare",
        action="store_true",
        help="Use prebuilt template.mp4 + audio_16k.wav from host worker",
    )
    args = parser.parse_args()

    job_dir = Path(args.job_dir).resolve()
    template = job_dir / "template.mp4"
    audio_wav = job_dir / "audio_16k.wav"
    output = job_dir / "output.mp4"
    metrics_path = job_dir / "metrics.json"

    if args.skip_prepare:
        if not template.exists() or template.stat().st_size < 1000:
            raise RuntimeError("缺少预处理 template.mp4（--skip-prepare）")
        if not audio_wav.exists() or audio_wav.stat().st_size < 100:
            raise RuntimeError("缺少预处理 audio_16k.wav（--skip-prepare）")
        duration = audio_duration_sec(audio_wav)
        template_secs = None
        photo_name = None
        audio_name = audio_wav.name
    else:
        photo = find_input(job_dir, ("photo",), (".jpg", ".jpeg", ".png"))
        audio_in = find_input(job_dir, ("audio",), (".wav", ".mp3", ".m4a", ".aac"))
        photo_name = photo.name
        audio_name = audio_in.name

        run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(audio_in),
                "-t",
                str(args.max_audio_seconds),
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(audio_wav),
            ]
        )
        duration = audio_duration_sec(audio_wav)
        if duration <= 0.2:
            raise RuntimeError("Audio too short after conversion")

        # Prefer uploaded/prebuilt motion template if present
        src_video = None
        for pref in ("template_src",):
            try:
                src_video = find_input(job_dir, (pref,), (".mp4", ".mov", ".webm", ".avi"))
                break
            except FileNotFoundError:
                pass

        if src_video is not None:
            template_secs = min(60.0, max(3.0, duration))
            run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(src_video),
                    "-t",
                    f"{template_secs:.3f}",
                    "-r",
                    "25",
                    "-vf",
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:v",
                    "libx264",
                    "-an",
                    str(template),
                ]
            )
        else:
            template_secs = min(5.0, max(3.0, duration))
            run(
                [
                    "ffmpeg",
                    "-y",
                    "-loop",
                    "1",
                    "-i",
                    str(photo),
                    "-t",
                    f"{template_secs:.3f}",
                    "-r",
                    "25",
                    "-vf",
                    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:v",
                    "libx264",
                    "-tune",
                    "stillimage",
                    str(template),
                ]
            )

    if duration <= 0.2:
        raise RuntimeError("Audio too short after conversion")

    # Patch transformers torch.load gate for torch<2.6 + prefer safetensors HuBERT
    import transformers.modeling_utils as mu
    import transformers.utils.import_utils as iu

    iu.check_torch_load_is_safe = lambda: None  # noqa: E731
    mu.check_torch_load_is_safe = lambda: None  # noqa: E731

    sys.argv = [
        "quicktalk_bench",
        "--asset-root",
        str(args.asset_root),
        "--template-video",
        str(template),
        "--audio",
        str(audio_wav),
        "--output",
        str(output),
        "--device",
        str(args.device),
    ]
    from apps.cli import quicktalk_bench as bench

    bench.main()
    if not output.exists() or output.stat().st_size < 1000:
        raise RuntimeError("QuickTalk did not produce output.mp4")

    summary = {
        "output": str(output),
        "audio_duration_sec": duration,
        "template_seconds": template_secs,
        "photo": photo_name,
        "audio": audio_name,
        "skip_prepare": bool(args.skip_prepare),
        "size_bytes": output.stat().st_size,
    }
    metrics_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"AVATAR_JOB_FAILED: {exc}", file=sys.stderr, flush=True)
        raise

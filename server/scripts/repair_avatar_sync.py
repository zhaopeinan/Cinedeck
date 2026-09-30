#!/usr/bin/env python3
"""Repair avatar A/V sync + lip-lag compensation without re-running Duix."""
import os
import shutil
import subprocess
import json

PID = "abca95d0-e61e-48ac-a429-2b97fa5cefa5"
BASE = f"/data/projects/{PID}"
JOBS = "/opt/opentalking/avatar-jobs"
# Optional Duix lip lag compensation (default off — compose A/V sync is the main fix).
LIP_LAG = float(os.environ.get("AVATAR_LIP_LAG_SEC", "0"))


def run(cmd):
    print(">", " ".join(cmd[:10]), "...")
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"FAIL {cmd[:3]}: {r.stderr[-800:]}")
    return r


def remux(duix_video, drive_audio, out_path, lip_lag=LIP_LAG):
    audio_dur = float(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nk=1:nw=1", drive_audio,
    ], text=True).strip())
    try:
        video_dur = float(subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=duration",
            "-of", "default=nk=1:nw=1", duix_video,
        ], text=True).strip() or "0")
    except Exception:
        video_dur = 0.0

    end_pad = max(0.0, audio_dur - max(0.0, video_dur - lip_lag))
    parts = ["setpts=PTS-STARTPTS", "fps=25"]
    if lip_lag > 0.001:
        parts += [f"trim=start={lip_lag:.3f}", "setpts=PTS-STARTPTS"]
    if end_pad > 0.02:
        parts.append(f"tpad=stop_mode=clone:stop_duration={end_pad:.3f}")
    parts += [f"trim=duration={audio_dur:.3f}", "setpts=PTS-STARTPTS"]
    vf = ",".join(parts)

    tmp = out_path + ".tmp.mp4"
    run([
        "ffmpeg", "-y", "-i", duix_video, "-i", drive_audio,
        "-filter_complex", f"[0:v]{vf}[v]",
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        "-t", f"{audio_dur:.3f}",
        "-movflags", "+faststart", tmp,
    ])
    os.replace(tmp, out_path)
    print(
        f"  wrote {out_path} audio={audio_dur:.3f} video_was={video_dur:.3f} "
        f"lip_lag={lip_lag:.3f} end_pad={end_pad:.3f}"
    )


def main():
    print(f"LIP_LAG={LIP_LAG}s")
    p19_job = f"{JOBS}/proj-{PID}-p19-1785049259704"
    assert os.path.exists(f"{p19_job}-c0/output.mp4")

    # Prefer original Duix raw if present; else chunk output (pre-lip-lag)
    for c in ("c0", "c1"):
        raw = f"{p19_job}-{c}/duix_raw.mp4"
        src = raw if os.path.exists(raw) else f"{p19_job}-{c}/output.mp4"
        audio = f"{p19_job}-{c}/audio.wav"
        clean = f"/tmp/p19_{c}_clean.mp4"
        print(f"=== remux chunk {c} from {src} ===")
        remux(src, audio, clean)

    list_file = "/tmp/p19_concat.txt"
    with open(list_file, "w") as f:
        f.write("file '/tmp/p19_c0_clean.mp4'\nfile '/tmp/p19_c1_clean.mp4'\n")
    concat_raw = "/tmp/p19_concat_raw.mp4"
    print("=== concat reencode ===")
    run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", list_file,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "18",
        "-c:a", "aac", "-b:a", "192k", concat_raw,
    ])

    full_audio = f"{BASE}/audio_cache/slide_19_audio.wav"
    out19 = f"{BASE}/avatar/page_19.mp4"
    print("=== final P19 remux (lip lag on full audio) ===")
    # Chunks already had lag applied; final remux should NOT double-apply lag.
    remux(concat_raw, full_audio, out19, lip_lag=0.0)

    for pi in (1, 10):
        print(f"=== remux P{pi} ===")
        src = f"{BASE}/avatar/page_{pi}.mp4"
        bak = src + ".bak_presync"
        # Use original backup if available (no prior lag); else current file
        source = bak if os.path.exists(bak) else src
        audio = f"{BASE}/audio_cache/slide_{pi}_audio.wav"
        remux(source, audio, src, lip_lag=LIP_LAG)

    print("=== VERIFY ===")
    for pi in (1, 10, 19):
        av = f"{BASE}/avatar/page_{pi}.mp4"
        au = f"{BASE}/audio_cache/slide_{pi}_audio.wav"
        ad = float(subprocess.check_output([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nk=1:nw=1", au,
        ], text=True).strip())
        vd = float(subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=duration",
            "-of", "default=nk=1:nw=1", av,
        ], text=True).strip() or "0")
        st = subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=start_time",
            "-of", "default=nk=1:nw=1", av,
        ], text=True).strip()
        print(f"P{pi}: audio={ad:.3f} video={vd:.3f} start={st} diff={vd - ad:.3f}")
    print("REPAIR_OK")


if __name__ == "__main__":
    main()

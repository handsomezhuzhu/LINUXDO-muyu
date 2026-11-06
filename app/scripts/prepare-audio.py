from pathlib import Path
import hashlib
import subprocess
import wave

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT / "third_party" / "mokugyo" / "607215__jonopodmore__mokugyo.flac"
OUTPUT = PROJECT / "public" / "media" / "knock.wav"
DURATION = 0.42

if not SOURCE.exists():
    raise SystemExit(
        "Missing the CC0 source recording. See THIRD_PARTY_NOTICES.md for the source URL."
    )
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(
    [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(SOURCE),
        "-t", str(DURATION),
        "-af", "highpass=f=45,volume=4dB,alimiter=limit=0.95:attack=1:release=25:level=disabled,afade=t=out:st=0.31:d=0.11",
        "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le",
        str(OUTPUT),
    ],
    check=True,
)
with wave.open(str(OUTPUT), "rb") as audio:
    seconds = audio.getnframes() / audio.getframerate()
    if audio.getnchannels() != 1 or not 0.40 <= seconds <= 0.44:
        raise RuntimeError("Unexpected output audio format or duration")
for path in (SOURCE, OUTPUT):
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    print(f"{path.name}: {path.stat().st_size} bytes, sha256={digest}")
print(f"Prepared {seconds:.3f}s of real mokugyo audio at {OUTPUT}")

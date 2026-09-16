#!/usr/bin/env python3
"""Bounded streaming technical analysis of PCM WAV, not a listening review."""
import array
import hashlib
import json
import math
from pathlib import Path
import sys
import wave

path = Path(sys.argv[1])
if path.stat().st_size > 536870912: raise ValueError("WAV analysis cap is 512 MiB")
with wave.open(str(path), "rb") as wav:
    width, channels, rate, frames = wav.getsampwidth(), wav.getnchannels(), wav.getframerate(), wav.getnframes()
    if width not in (1, 2, 3, 4): raise ValueError("Unsupported PCM width")
    if not 1 <= channels <= 32 or not rate: raise ValueError("Invalid channel count or sample rate")
    count = clips = 0
    peak = total = squares = 0.0
    first = last = None
    while True:
        data = wav.readframes(65536)
        if not data: break
        if width == 1: values = (v - 128 for v in data)
        elif width in (2, 4):
            values = array.array("h" if width == 2 else "i", data)
            if sys.byteorder != "little": values.byteswap()
        else: values = (int.from_bytes(data[i:i+3], "little", signed=True) for i in range(0, len(data), 3))
        scale = float(1 << (8 * width - 1))
        for raw in values:
            v = raw / scale
            if first is None: first = v
            last = v
            count += 1
            peak = max(peak, abs(v))
            total += v
            squares += v*v
            if raw <= -scale or raw >= scale-1: clips += 1
with path.open("rb") as source: digest = hashlib.file_digest(source, "sha256").hexdigest()
print(json.dumps({"format": "PCM WAV", "sample_rate": rate, "channels": channels,
 "sample_width_bytes": width, "frames": frames, "samples": count,
 "duration_seconds": frames / rate, "peak": peak,
 "rms": math.sqrt(squares/count) if count else 0, "dc_offset": total/count if count else 0,
 "hard_clip_samples": clips, "endpoint_sample_difference": abs((last or 0) - (first or 0)),
 "nonempty": count > 0, "sha256": digest, "bytes": path.stat().st_size,
 "scope": "technical PCM inspection only; no subjective listening or mastering claim"}))

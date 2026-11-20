"""M5a spike: score -> MIDI -> FluidSynth -> seamless OGG loop. Standard library only (MIDI written by hand).

    python3 render_spike.py <soundfont.sf2> <out_dir>

An 8-bar loop (drums, bass, pad, lead) at 100 bpm. The loop is rendered three times in one MIDI, and the middle
pass is cut out: its start already holds the reverb/release tail of the bars before it, so it loops seamlessly.
"""
import os
import struct
import subprocess
import sys
import time
import wave

TPQ = 480
TEMPO = 100
BARS = 8
RATE = 44100


def vlq(n: int) -> bytes:
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append(0x80 | (n & 0x7F))
        n >>= 7
    return bytes(reversed(out))


def track(events: list[tuple[int, bytes]]) -> bytes:
    data, now = b"", 0
    for tick, msg in sorted(events, key=lambda e: (e[0], e[1][0] & 0xF0 != 0x80)):  # note-offs first at a tick
        data += vlq(tick - now) + msg
        now = tick
    data += b"\x00\xff\x2f\x00"
    return b"MTrk" + struct.pack(">I", len(data)) + data


def notes(ch: int, items: list[tuple[float, float, int, int]], passes: int) -> list[tuple[int, bytes]]:
    """items: (beat, length in beats, midi note, velocity) within one loop; repeated `passes` times."""
    ev = []
    loop_ticks = BARS * 4 * TPQ
    for p in range(passes):
        for beat, length, note, vel in items:
            t = p * loop_ticks + int(beat * TPQ)
            ev.append((t, bytes([0x90 | ch, note, vel])))
            ev.append((t + int(length * TPQ) - 1, bytes([0x80 | ch, note, 0])))
    return ev


def song(passes: int) -> bytes:
    N = lambda name: {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}[name[0]] + (1 if "#" in name else -1 if "b" in name[1:] else 0) + 12 * (int(name[-1]) + 1)  # noqa: E731
    chords = [["D3", "F3", "A3"], ["Bb2", "D3", "F3"], ["C3", "E3", "G3"], ["A2", "C#3", "E3"]] * 2  # Dm Bb C A, twice
    roots = ["D2", "Bb1", "C2", "A1"] * 2
    melody = [  # (beat, length, note) over 8 bars
        (0, 1, "A4"), (1, 0.5, "D5"), (1.5, 0.5, "E5"), (2, 1, "F5"), (3, 1, "E5"),
        (4, 1.5, "D5"), (5.5, 0.5, "C5"), (6, 2, "Bb4"),
        (8, 1, "C5"), (9, 0.5, "E5"), (9.5, 0.5, "F5"), (10, 1, "G5"), (11, 1, "E5"),
        (12, 3, "C#5"), (15, 1, "A4"),
        (16, 1, "A4"), (17, 0.5, "D5"), (17.5, 0.5, "E5"), (18, 1, "F5"), (19, 1, "A5"),
        (20, 1.5, "G5"), (21.5, 0.5, "F5"), (22, 2, "D5"),
        (24, 1, "E5"), (25, 1, "C#5"), (26, 1, "E5"), (27, 1, "G5"), (28, 4, "D5"),
    ]
    tracks = []
    meta = b"\x00\xff\x51\x03" + struct.pack(">I", 60_000_000 // TEMPO)[1:]
    tracks.append(b"MTrk" + struct.pack(">I", len(meta) + 4) + meta + b"\x00\xff\x2f\x00")
    progs = {0: 48, 1: 33, 2: 73}  # strings ensemble, fingered bass, flute
    for ch, prog in progs.items():
        ev = [(0, bytes([0xC0 | ch, prog])), (0, bytes([0xB0 | ch, 91, 50]))]  # program, reverb send
        if ch == 0:
            ev += notes(0, [(bar * 4, 4, N(n), 55) for bar, ch_ in enumerate(chords) for n in ch_], passes)
        elif ch == 1:
            ev += notes(1, [(bar * 4 + b, 0.9, N(roots[bar]), 90) for bar in range(BARS) for b in (0, 1.5, 2, 3)], passes)
        else:
            ev += notes(2, [(b, l, N(n), 85) for b, l, n in melody], passes)
        tracks.append(track(ev))
    drums = []
    for bar in range(BARS):
        for b in range(8):
            drums.append((bar * 4 + b * 0.5, 0.25, 42, 60 if b % 2 else 80))  # closed hat
        drums += [(bar * 4, 0.5, 36, 100), (bar * 4 + 2.5, 0.5, 36, 80), (bar * 4 + 1, 0.5, 38, 90), (bar * 4 + 3, 0.5, 38, 95)]
    tracks.append(track(notes(9, drums, passes)))
    return b"MThd" + struct.pack(">IHHH", 6, 1, len(tracks), TPQ) + b"".join(tracks)


def main() -> None:
    sf2, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    mid = os.path.join(out, "loop3.mid")
    open(mid, "wb").write(song(3))
    wav3 = os.path.join(out, "loop3.wav")
    t = time.time()
    subprocess.run(["fluidsynth", "-ni", "-q", "-g", "0.6", "-r", str(RATE), "-F", wav3, sf2, mid], check=True)
    render_s = time.time() - t
    loop_s = BARS * 4 * 60 / TEMPO
    n = round(loop_s * RATE)
    with wave.open(wav3) as w:
        frames = w.readframes(w.getnframes())
        ch, width = w.getnchannels(), w.getsampwidth()
    frame = ch * width
    middle = frames[n * frame : 2 * n * frame]
    loop_wav = os.path.join(out, "loop.wav")
    with wave.open(loop_wav, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(width)
        w.setframerate(RATE)
        w.writeframes(middle)
    ogg = os.path.join(out, "loop.ogg")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", loop_wav, "-c:a", "libvorbis", "-q:a", "5", ogg], check=True)
    # Seam check: the jump from the loop's last sample to its first, against typical sample-to-sample steps.
    import array
    s = array.array("h", middle)
    left = s[0::2]
    steps = sorted(abs(left[i + 1] - left[i]) for i in range(0, len(left) - 1, 7))
    seam = abs(left[0] - left[-1])
    print(f"loop {loop_s:.2f} s, rendered 3 passes in {render_s:.2f} s; seam jump {seam}, median step {steps[len(steps) // 2]}, p99 step {steps[int(len(steps) * 0.99)]}")
    print(f"files: {ogg} ({os.path.getsize(ogg) // 1024} KB)")


if __name__ == "__main__":
    main()

import asyncio
import edge_tts
import sys

TEXT_FILE = sys.argv[1]
VOICE = sys.argv[2]
OUTPUT = sys.argv[3]
SRT_OUTPUT = sys.argv[4] if len(sys.argv) > 4 else None

with open(TEXT_FILE, "r", encoding="utf-8") as f:
    TEXT = f.read()

async def main():
    communicate = edge_tts.Communicate(TEXT, VOICE, rate="+10%")

    if SRT_OUTPUT:
        words = []  # [{text, start_ms, end_ms}]

        with open(OUTPUT, "wb") as audio_file:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_file.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    start_ms = chunk["offset"] // 10000
                    dur_ms   = chunk["duration"] // 10000
                    words.append({
                        "text":     chunk["text"],
                        "start_ms": start_ms,
                        "end_ms":   start_ms + dur_ms,
                    })

        # Agrupar palabras en frases de máximo 6 palabras
        WORDS_PER_PHRASE = 6
        phrases = []
        i = 0
        while i < len(words):
            group = words[i : i + WORDS_PER_PHRASE]
            phrases.append({
                "text":     " ".join(w["text"] for w in group),
                "start_ms": group[0]["start_ms"],
                "end_ms":   group[-1]["end_ms"],
            })
            i += WORDS_PER_PHRASE

        # Escribir SRT
        def ms_to_srt(ms):
            h  = ms // 3600000
            m  = (ms % 3600000) // 60000
            s  = (ms % 60000)   // 1000
            cs = ms % 1000
            return f"{h:02}:{m:02}:{s:02},{cs:03}"

        with open(SRT_OUTPUT, "w", encoding="utf-8") as f:
            for idx, phrase in enumerate(phrases, start=1):
                f.write(f"{idx}\n")
                f.write(f"{ms_to_srt(phrase['start_ms'])} --> {ms_to_srt(phrase['end_ms'])}\n")
                f.write(f"{phrase['text']}\n\n")
    else:
        await communicate.save(OUTPUT)

asyncio.run(main())

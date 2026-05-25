import asyncio
import edge_tts
import sys
import json

TEXT_FILE = sys.argv[1]
VOICE = sys.argv[2]
OUTPUT = sys.argv[3]
VTT_OUTPUT = sys.argv[4] if len(sys.argv) > 4 else None

with open(TEXT_FILE, "r", encoding="utf-8") as f:
    TEXT = f.read()

async def main():
    communicate = edge_tts.Communicate(TEXT, VOICE, rate="+10%")
    
    if VTT_OUTPUT:
        # Generar audio y subtítulos con timestamps
        submaker = edge_tts.SubMaker()
        with open(OUTPUT, "wb") as audio_file:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_file.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    submaker.feed(chunk)
        
        with open(VTT_OUTPUT, "w", encoding="utf-8") as vtt_file:
            vtt_file.write(submaker.get_srt())
    else:
        await communicate.save(OUTPUT)

asyncio.run(main())

import asyncio
import edge_tts
import sys

TEXT_FILE = sys.argv[1]
VOICE = sys.argv[2]
OUTPUT = sys.argv[3]

with open(TEXT_FILE, "r", encoding="utf-8") as f:
    TEXT = f.read()

async def main():
    communicate = edge_tts.Communicate(TEXT, VOICE, rate="+10%")
    await communicate.save(OUTPUT)

asyncio.run(main())

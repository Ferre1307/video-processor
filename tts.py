import asyncio
import edge_tts
import sys

TEXT = sys.argv[1]
VOICE = sys.argv[2]
OUTPUT = sys.argv[3]

async def main():
    communicate = edge_tts.Communicate(TEXT, VOICE, rate="+20%")
    await communicate.save(OUTPUT)

asyncio.run(main())

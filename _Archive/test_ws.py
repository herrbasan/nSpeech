import asyncio
import websockets
import json

async def test():
    try:
        async with websockets.connect('ws://127.0.0.1:8000/ws/tts') as ws:
            await ws.send(json.dumps({'text': 'Hello world', 'output_format': 'mp3'}))
            msg = await ws.recv()
            print('Received:', msg)
    except Exception as e:
        print('Error:', e)

asyncio.run(test())

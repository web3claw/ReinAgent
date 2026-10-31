import asyncio
import json
import base64
import websockets
from typing import Optional, Dict, Any, List

class ChromeCDP:
    def __init__(self):
        with open('/home/web3claw/.config/google-chrome/DevToolsActivePort') as f:
            self.port = f.readline().strip()
            self.path = f.readline().strip()
        self.ws_url = f"ws://127.0.0.1:{self.port}{self.path}"
        self.ws = None
        self.msg_id = 1
        self.pending_responses = {}
        self.event_handlers = {}
        self._reader_task = None

    async def connect(self):
        self.ws = await websockets.connect(self.ws_url, max_size=100*1024*1024)
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self):
        try:
            while True:
                msg_text = await self.ws.recv()
                msg = json.loads(msg_text)
                if 'id' in msg:
                    fut = self.pending_responses.pop(msg['id'], None)
                    if fut and not fut.done():
                        fut.set_result(msg)
                elif 'method' in msg:
                    method = msg['method']
                    if method in self.event_handlers:
                        for handler in self.event_handlers[method]:
                            handler(msg.get('params', {}))
        except asyncio.CancelledError:
            pass
        except Exception as e:
            # print("Read loop error:", e)
            pass

    async def call(self, method: str, params: Optional[Dict[str, Any]] = None, session_id: Optional[str] = None) -> Dict[str, Any]:
        req_id = self.msg_id
        self.msg_id += 1
        payload = {'id': req_id, 'method': method}
        if params is not None:
            payload['params'] = params
        if session_id:
            payload['sessionId'] = session_id
        
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        self.pending_responses[req_id] = fut
        await self.ws.send(json.dumps(payload))
        return await fut

    async def get_targets(self) -> List[Dict[str, Any]]:
        res = await self.call('Target.getTargets')
        return res.get('result', {}).get('targetInfos', [])

    async def attach(self, target_id: str) -> str:
        res = await self.call('Target.attachToTarget', {'targetId': target_id, 'flatten': True})
        return res.get('result', {}).get('sessionId')

    async def evaluate(self, session_id: str, expression: str) -> Any:
        res = await self.call('Runtime.evaluate', {
            'expression': expression,
            'returnByValue': True,
            'awaitPromise': True
        }, session_id=session_id)
        if 'exceptionDetails' in res.get('result', {}):
            raise RuntimeError(f"JS Exception: {res['result']['exceptionDetails']}")
        return res.get('result', {}).get('result', {}).get('value')

    async def screenshot(self, session_id: str, save_path: str) -> str:
        res = await self.call('Page.captureScreenshot', session_id=session_id)
        data = base64.b64decode(res['result']['data'])
        with open(save_path, 'wb') as f:
            f.write(data)
        return save_path

    async def navigate(self, session_id: str, url: str):
        await self.call('Page.navigate', {'url': url}, session_id=session_id)

    async def new_tab(self, url: str) -> Dict[str, Any]:
        res = await self.call('Target.createTarget', {'url': url})
        target_id = res['result']['targetId']
        session_id = await self.attach(target_id)
        return {'targetId': target_id, 'sessionId': session_id}

    async def close(self):
        if self._reader_task:
            self._reader_task.cancel()
        if self.ws:
            await self.ws.close()

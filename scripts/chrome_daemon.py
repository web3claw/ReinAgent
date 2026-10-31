#!/usr/bin/env python3
"""
Chrome 常驻长连接守护服务 (Chrome CDP Daemon)
保持单一持久 WebSocket 连接，通过轻量级 HTTP 服务暴露页面操作接口，
彻底避免频繁断开重连触发 Chrome 144+ 'Allow remote debugging' 弹窗。
"""

import asyncio
import json
import base64
import websockets
from http.server import HTTPServer, BaseHTTPRequestHandler
import threading

CHROME_WS = None
PENDING_RESPONSES = {}
MSG_ID = 1
LOCK = asyncio.Lock()
MAIN_LOOP = None

def get_devtools_ws_url():
    with open('/home/web3claw/.config/google-chrome/DevToolsActivePort') as f:
        port = f.readline().strip()
        path = f.readline().strip()
    return f"ws://127.0.0.1:{port}{path}"

async def cdp_call(method: str, params=None, session_id=None):
    global MSG_ID, CHROME_WS
    async with LOCK:
        req_id = MSG_ID
        MSG_ID += 1
        payload = {'id': req_id, 'method': method}
        if params is not None:
            payload['params'] = params
        if session_id:
            payload['sessionId'] = session_id
        
        fut = MAIN_LOOP.create_future()
        PENDING_RESPONSES[req_id] = fut
        await CHROME_WS.send(json.dumps(payload))
    return await fut

async def cdp_listen_loop():
    global CHROME_WS
    while True:
        try:
            msg_text = await CHROME_WS.recv()
            msg = json.loads(msg_text)
            if 'id' in msg:
                fut = PENDING_RESPONSES.pop(msg['id'], None)
                if fut and not fut.done():
                    fut.set_result(msg)
        except Exception as e:
            print("CDP WS receive error:", e)
            await asyncio.sleep(1)

class DaemonHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8')
        data = json.loads(body) if body else {}
        action = self.path
        
        result = {}
        try:
            if action == '/targets':
                fut = asyncio.run_coroutine_threadsafe(cdp_call('Target.getTargets'), MAIN_LOOP)
                res = fut.result(timeout=10)
                result = res.get('result', {}).get('targetInfos', [])
            elif action == '/attach':
                target_id = data.get('targetId')
                fut = asyncio.run_coroutine_threadsafe(
                    cdp_call('Target.attachToTarget', {'targetId': target_id, 'flatten': True}),
                    MAIN_LOOP
                )
                res = fut.result(timeout=10)
                result = {'sessionId': res.get('result', {}).get('sessionId')}
            elif action == '/evaluate':
                session_id = data.get('sessionId')
                expr = data.get('expression')
                fut = asyncio.run_coroutine_threadsafe(
                    cdp_call('Runtime.evaluate', {
                        'expression': expr,
                        'returnByValue': True,
                        'awaitPromise': True
                    }, session_id=session_id),
                    MAIN_LOOP
                )
                res = fut.result(timeout=20)
                if 'exceptionDetails' in res.get('result', {}):
                    result = {'error': res['result']['exceptionDetails']}
                else:
                    result = {'value': res.get('result', {}).get('result', {}).get('value')}
            elif action == '/screenshot':
                session_id = data.get('sessionId')
                save_path = data.get('savePath', '/tmp/chrome_shot.png')
                fut = asyncio.run_coroutine_threadsafe(
                    cdp_call('Page.captureScreenshot', session_id=session_id),
                    MAIN_LOOP
                )
                res = fut.result(timeout=15)
                raw = base64.b64decode(res['result']['data'])
                with open(save_path, 'wb') as f:
                    f.write(raw)
                result = {'saved': save_path, 'bytes': len(raw)}
            elif action == '/new_tab':
                url = data.get('url', 'about:blank')
                fut = asyncio.run_coroutine_threadsafe(
                    cdp_call('Target.createTarget', {'url': url}),
                    MAIN_LOOP
                )
                res = fut.result(timeout=10)
                tid = res['result']['targetId']
                fut2 = asyncio.run_coroutine_threadsafe(
                    cdp_call('Target.attachToTarget', {'targetId': tid, 'flatten': True}),
                    MAIN_LOOP
                )
                res2 = fut2.result(timeout=10)
                result = {'targetId': tid, 'sessionId': res2.get('result', {}).get('sessionId')}
            else:
                result = {'error': f'Unknown action {action}'}
            
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode('utf-8'))
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode('utf-8'))

    def log_message(self, format, *args):
        pass

def run_http_server():
    server = HTTPServer(('127.0.0.1', 19823), DaemonHandler)
    print("HTTP bridge listening on 127.0.0.1:19823")
    server.serve_forever()

async def async_main():
    global CHROME_WS, MAIN_LOOP
    MAIN_LOOP = asyncio.get_running_loop()
    ws_url = get_devtools_ws_url()
    print("Connecting permanent WebSocket to Chrome:", ws_url)
    CHROME_WS = await websockets.connect(ws_url, max_size=100*1024*1024)
    print("Connected! Permanent session active.")
    
    # Start HTTP bridge in thread
    t = threading.Thread(target=run_http_server, daemon=True)
    t.start()
    
    await cdp_listen_loop()

if __name__ == '__main__':
    asyncio.run(async_main())

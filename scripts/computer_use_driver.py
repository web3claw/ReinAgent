#!/usr/bin/env python3
"""
ReinAgent Computer Use Driver
基于 Linux /dev/uinput 内核硬件级驱动 + xwd 原生窗口截屏
实现无死角、100% 穿透的真实桌面端自动化操作走查
"""

import os
import fcntl
import struct
import time
import subprocess
from typing import Tuple, Optional

# uinput ioctls
UI_SET_EVBIT   = 0x40045564
UI_SET_KEYBIT  = 0x40045565
UI_SET_RELBIT  = 0x40045566
UI_SET_ABSBIT  = 0x40045567
UI_DEV_CREATE  = 0x5501
UI_DEV_DESTROY = 0x5502

EV_SYN = 0x00
SYN_REPORT = 0x00
EV_KEY = 0x01
EV_REL = 0x02
EV_ABS = 0x03

REL_X = 0x00
REL_Y = 0x01
REL_WHEEL = 0x08

ABS_X = 0x00
ABS_Y = 0x01

BTN_LEFT = 0x110
BTN_RIGHT = 0x111
BTN_MIDDLE = 0x112
BTN_TOUCH = 0x14a

# Standard keycodes (Linux input-event-codes.h)
KEY_ENTER = 28
KEY_ESC = 1
KEY_BACKSPACE = 14
KEY_TAB = 15
KEY_SPACE = 57
KEY_LEFTSHIFT = 42

class ComputerUse:
    def __init__(self, window_name: str = "ReinAgent"):
        self.window_name = window_name
        self.fd = None
        self.screen_w = 2560
        self.screen_h = 1440
        self._detect_screen_size()
        self._init_device()
        self.win_id, self.win_x, self.win_y, self.win_w, self.win_h = self.find_window()

    def _detect_screen_size(self):
        try:
            out = subprocess.check_output(['xrandr']).decode()
            for line in out.splitlines():
                if '*' in line:
                    res = line.strip().split()[0]
                    w, h = res.split('x')
                    self.screen_w = int(w)
                    self.screen_h = int(h)
                    break
        except Exception:
            pass

    def _init_device(self):
        self.fd = os.open('/dev/uinput', os.O_WRONLY | os.O_NONBLOCK)
        
        # Enable EV_KEY
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_KEY)
        for btn in [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_TOUCH, KEY_ENTER, KEY_ESC, KEY_BACKSPACE, KEY_TAB, KEY_SPACE, KEY_LEFTSHIFT]:
            fcntl.ioctl(self.fd, UI_SET_KEYBIT, btn)
        for code in range(1, 128):
            try:
                fcntl.ioctl(self.fd, UI_SET_KEYBIT, code)
            except Exception:
                pass
            
        # Enable EV_REL
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_REL)
        fcntl.ioctl(self.fd, UI_SET_RELBIT, REL_X)
        fcntl.ioctl(self.fd, UI_SET_RELBIT, REL_Y)
        fcntl.ioctl(self.fd, UI_SET_RELBIT, REL_WHEEL)

        # Enable EV_ABS
        fcntl.ioctl(self.fd, UI_SET_EVBIT, EV_ABS)
        fcntl.ioctl(self.fd, UI_SET_ABSBIT, ABS_X)
        fcntl.ioctl(self.fd, UI_SET_ABSBIT, ABS_Y)

        name = b"ReinAgent Absolute Pointer".ljust(80, b'\x00')
        input_id = struct.pack('HHHH', 0x03, 0x01, 0x01, 0x01)
        ff = struct.pack('i', 0)
        absmax = [0] * 64; absmin = [0] * 64; absfuzz = [0] * 64; absflat = [0] * 64
        absmax[0] = self.screen_w
        absmax[1] = self.screen_h
        user_dev = name + input_id + ff + struct.pack('64i', *absmax) + struct.pack('64i', *absmin) + struct.pack('64i', *absfuzz) + struct.pack('64i', *absflat)
        os.write(self.fd, user_dev)
        fcntl.ioctl(self.fd, UI_DEV_CREATE)
        time.sleep(0.3)

    def find_window(self) -> Tuple[int, int, int, int, int]:
        out = subprocess.check_output(['xdotool', 'search', '--name', self.window_name]).decode().strip().split()
        if not out:
            raise RuntimeError(f"Window '{self.window_name}' not found!")
        win_id = int(out[-1])
        info = subprocess.check_output(['xwininfo', '-id', str(win_id)]).decode()
        abs_x, abs_y, w, h = 0, 0, 0, 0
        for line in info.splitlines():
            line = line.strip()
            if line.startswith("Absolute upper-left X:"):
                abs_x = int(line.split(":")[1])
            elif line.startswith("Absolute upper-left Y:"):
                abs_y = int(line.split(":")[1])
            elif line.startswith("Width:"):
                w = int(line.split(":")[1])
            elif line.startswith("Height:"):
                h = int(line.split(":")[1])
            elif line.startswith("Relative upper-left X:"):
                rel_x = int(line.split(":")[1])
            elif line.startswith("Relative upper-left Y:"):
                rel_y = int(line.split(":")[1])
        return win_id, abs_x, abs_y, w, h

    def _emit(self, ev_type, code, val):
        data = struct.pack('qqHHi', 0, 0, ev_type, code, val)
        os.write(self.fd, data)

    def mouse_move_to(self, rel_x: int, rel_y: int):
        subprocess.run(['xdotool', 'windowactivate', '--sync', str(self.win_id)])
        abs_x = self.win_x + rel_x
        abs_y = self.win_y + rel_y
        self._emit(EV_ABS, ABS_X, abs_x)
        self._emit(EV_ABS, ABS_Y, abs_y)
        self._emit(EV_SYN, SYN_REPORT, 0)
        time.sleep(0.08)

    def click(self, rel_x: Optional[int] = None, rel_y: Optional[int] = None, delay: float = 0.08):
        if rel_x is not None and rel_y is not None:
            self.mouse_move_to(rel_x, rel_y)
        # Touch & Left click
        self._emit(EV_KEY, BTN_TOUCH, 1)
        self._emit(EV_KEY, BTN_LEFT, 1)
        self._emit(EV_SYN, SYN_REPORT, 0)
        time.sleep(delay)
        self._emit(EV_KEY, BTN_TOUCH, 0)
        self._emit(EV_KEY, BTN_LEFT, 0)
        self._emit(EV_SYN, SYN_REPORT, 0)
        time.sleep(0.15)

    def scroll(self, clicks: int):
        # positive clicks = scroll up, negative = scroll down
        val = 1 if clicks > 0 else -1
        for _ in range(abs(clicks)):
            self._emit(EV_REL, REL_WHEEL, val)
            self._emit(EV_SYN, SYN_REPORT, 0)
            time.sleep(0.02)

    def type_text(self, text: str):
        # xdotool type is reliable for text input once focused
        subprocess.run(['xdotool', 'type', '--delay', '20', text])

    def press_key(self, key_name: str):
        subprocess.run(['xdotool', 'key', key_name])

    def screenshot(self, save_path: str) -> str:
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        xwd_path = f"/tmp/cu_shot_{time.time()}.xwd"
        cmd1 = f"xwd -id {self.win_id} -out {xwd_path}"
        cmd2 = f"ffmpeg -y -i {xwd_path} {save_path} >/dev/null 2>&1"
        res1 = subprocess.run(cmd1, shell=True)
        if res1.returncode != 0:
            raise RuntimeError(f"xwd failed: {res1.returncode}")
        res2 = subprocess.run(cmd2, shell=True)
        if res2.returncode != 0:
            raise RuntimeError(f"ffmpeg conversion failed: {res2.returncode}")
        if os.path.exists(xwd_path):
            os.remove(xwd_path)
        return save_path

    def close(self):
        if self.fd:
            try:
                fcntl.ioctl(self.fd, UI_DEV_DESTROY)
                os.close(self.fd)
            except Exception:
                pass
            self.fd = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()

if __name__ == "__main__":
    import sys
    cu = ComputerUse()
    print(f"Connected to window {cu.win_id} at ({cu.win_x}, {cu.win_y}), size {cu.win_w}x{cu.win_h}")
    
    if len(sys.argv) > 1:
        cmd = sys.argv[1]
        if cmd in ("shot", "screenshot"):
            path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/test_cu_shot.png"
            cu.screenshot(path)
            print(f"Screenshot saved to {path}")
        elif cmd == "click":
            x = int(sys.argv[2])
            y = int(sys.argv[3])
            cu.click(x, y)
            print(f"Clicked ({x}, {y})")
        elif cmd == "move":
            x = int(sys.argv[2])
            y = int(sys.argv[3])
            cu.mouse_move_to(x, y)
            print(f"Moved to ({x}, {y})")
        elif cmd == "type":
            text = sys.argv[2]
            cu.type_text(text)
            print(f"Typed text: {text}")
        elif cmd == "key":
            key_name = sys.argv[2]
            cu.press_key(key_name)
            print(f"Pressed key: {key_name}")
    else:
        cu.screenshot("/tmp/test_cu_shot.png")
        print("Screenshot captured successfully!")
    cu.close()

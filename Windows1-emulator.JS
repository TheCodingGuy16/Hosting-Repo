// Windows 1.0 Emulator — TurboWarp custom extension
// Loads copy/v86 (x86 emulator, WASM) and boots a Windows 1.01 floppy image
// inside your Scratch/TurboWarp project.
//
// HOW TO USE:
// 1. Host this file somewhere with a raw URL (e.g. push it to a public GitHub
//    repo and use the raw.githubusercontent.com link, or GitHub Pages).
// 2. In TurboWarp: "Load Custom Extension" -> paste the raw URL.
// 3. TurboWarp will ask to run it unsandboxed — you must say yes, since this
//    extension needs direct DOM access to create v86's screen and load its
//    (external) script/asset files.
//
// IMPORTANT — CORS NOTE:
// v86's library file and the default Windows 1.01 test image are fetched from
// third-party CDNs below. If your browser console shows CORS/network errors
// when booting, the fix is to self-host libv86.js, v86.wasm, seabios.bin,
// vgabios.bin, and your disk image on a CORS-friendly host (GitHub raw or
// GitHub Pages both send permissive CORS headers) and change the URL
// constants below to point at your own copies. The v86 GitHub repo
// (https://github.com/copy/v86) has the bios files under /bios and the built
// library under /build; the Windows 1.01 test image is normally fetched from
// https://i.copy.sh/windows101.img.

(function (Scratch) {
  'use strict';

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('The Windows 1.0 Emulator extension must be run unsandboxed.');
  }

  // ---- Configuration: swap these for self-hosted copies if CORS blocks you ----
  const V86_LIB_URL = 'https://cdn.jsdelivr.net/gh/copy/v86@master/build/libv86.js';
  const V86_WASM_URL = 'https://cdn.jsdelivr.net/gh/copy/v86@master/build/v86.wasm';
  const BIOS_URL = 'https://cdn.jsdelivr.net/gh/copy/v86@master/bios/seabios.bin';
  const VGABIOS_URL = 'https://cdn.jsdelivr.net/gh/copy/v86@master/bios/vgabios.bin';
  const DEFAULT_IMAGE_URL = 'https://i.copy.sh/windows101.img';

  // Scancode Set 1 map for a US QWERTY layout (make codes; break = make | 0x80)
  const SCANCODES = {
    'esc': 0x01, 'backspace': 0x0e, 'tab': 0x09 === 0 ? 0x0f : 0x0f, 'enter': 0x1c,
    'space': 0x39, 'capslock': 0x3a, 'leftshift': 0x2a, 'rightshift': 0x36,
    'ctrl': 0x1d, 'alt': 0x38,
    'up': 0x48, 'down': 0x50, 'left': 0x4b, 'right': 0x4d,
    '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06,
    '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0a, '0': 0x0b,
    '-': 0x0c, '=': 0x0d, '[': 0x1a, ']': 0x1b, ';': 0x27,
    "'": 0x28, '`': 0x29, '\\': 0x2b, ',': 0x33, '.': 0x34, '/': 0x35,
    'a': 0x1e, 'b': 0x30, 'c': 0x2e, 'd': 0x20, 'e': 0x12, 'f': 0x21,
    'g': 0x22, 'h': 0x23, 'i': 0x17, 'j': 0x24, 'k': 0x25, 'l': 0x26,
    'm': 0x32, 'n': 0x31, 'o': 0x18, 'p': 0x19, 'q': 0x10, 'r': 0x13,
    's': 0x1f, 't': 0x14, 'u': 0x16, 'v': 0x2f, 'w': 0x11, 'x': 0x2d,
    'y': 0x15, 'z': 0x2c
  };
  const SHIFTED_SYMBOLS = {
    '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7',
    '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']',
    ':': ';', '"': "'", '~': '`', '|': '\\', '<': ',', '>': '.', '?': '/'
  };

  const ARROW_EXTENDED = { up: true, down: true, left: true, right: true };

  class Windows1Emulator {
    constructor() {
      this.emulator = null;
      this.container = null;
      this.libPromise = null;
      this.status = 'not booted';
    }

    getInfo() {
      return {
        id: 'win1emulator',
        name: 'Windows 1.0 Emulator',
        color1: '#008080',
        blocks: [
          {
            opcode: 'boot',
            blockType: Scratch.BlockType.COMMAND,
            text: 'boot Windows 1.0 using disk image [URL]',
            arguments: {
              URL: { type: Scratch.ArgumentType.STRING, defaultValue: DEFAULT_IMAGE_URL }
            }
          },
          {
            opcode: 'showScreen',
            blockType: Scratch.BlockType.COMMAND,
            text: 'show emulator screen at x:[X] y:[Y] width:[W] height:[H]',
            arguments: {
              X: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              Y: { type: Scratch.ArgumentType.NUMBER, defaultValue: 0 },
              W: { type: Scratch.ArgumentType.NUMBER, defaultValue: 480 },
              H: { type: Scratch.ArgumentType.NUMBER, defaultValue: 360 }
            }
          },
          { opcode: 'hideScreen', blockType: Scratch.BlockType.COMMAND, text: 'hide emulator screen' },
          { opcode: 'focusScreen', blockType: Scratch.BlockType.COMMAND, text: 'focus emulator screen (for keyboard/mouse input)' },
          {
            opcode: 'sendKey',
            blockType: Scratch.BlockType.COMMAND,
            text: 'press key [KEY]',
            arguments: { KEY: { type: Scratch.ArgumentType.STRING, defaultValue: 'enter' } }
          },
          {
            opcode: 'typeText',
            blockType: Scratch.BlockType.COMMAND,
            text: 'type text [TEXT]',
            arguments: { TEXT: { type: Scratch.ArgumentType.STRING, defaultValue: 'hello' } }
          },
          { opcode: 'isRunning', blockType: Scratch.BlockType.BOOLEAN, text: 'emulator is running?' },
          { opcode: 'getStatus', blockType: Scratch.BlockType.REPORTER, text: 'emulator status' },
          { opcode: 'reset', blockType: Scratch.BlockType.COMMAND, text: 'reset / stop emulator' }
        ]
      };
    }

    // ---- internals ----

    _loadScript(url) {
      return new Promise((resolve, reject) => {
        const existing = document.querySelector('script[data-win1emu="v86lib"]');
        if (existing) { resolve(); return; }
        const script = document.createElement('script');
        script.src = url;
        script.dataset.win1emu = 'v86lib';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load v86 library from ' + url));
        document.head.appendChild(script);
      });
    }

    _ensureLib() {
      if (!this.libPromise) {
        this.libPromise = this._loadScript(V86_LIB_URL);
      }
      return this.libPromise;
    }

    _ensureContainer() {
      if (this.container) return this.container;
      const container = document.createElement('div');
      container.id = 'win1emu-screen-container';
      container.tabIndex = 0; // needed so it can receive keyboard focus/events
      container.style.position = 'fixed';
      container.style.left = '0px';
      container.style.top = '0px';
      container.style.width = '480px';
      container.style.height = '360px';
      container.style.zIndex = '99999';
      container.style.background = '#000';
      container.style.overflow = 'hidden';
      container.style.display = 'none';

      const canvas = document.createElement('canvas');
      const textLayer = document.createElement('div');
      textLayer.style.color = '#ccc';
      textLayer.style.whiteSpace = 'pre';
      container.appendChild(canvas);
      container.appendChild(textLayer);

      document.body.appendChild(container);
      this.container = container;
      return container;
    }

    async boot(args) {
      this.status = 'loading v86 library...';
      try {
        await this._ensureLib();
      } catch (e) {
        this.status = 'failed to load v86 (check CORS / network, see file comments)';
        console.error(e);
        return;
      }

      const container = this._ensureContainer();
      container.style.display = 'block';

      if (this.emulator) {
        try { this.emulator.stop(); } catch (e) { /* ignore */ }
        this.emulator = null;
      }

      this.status = 'booting...';
      try {
        this.emulator = new V86({
          screen_container: container,
          wasm_path: V86_WASM_URL,
          bios: { url: BIOS_URL },
          vga_bios: { url: VGABIOS_URL },
          fda: { url: Scratch.Cast.toString(args.URL) },
          memory_size: 32 * 1024 * 1024,
          vga_memory_size: 2 * 1024 * 1024,
          autostart: true
        });

        this.emulator.add_listener('emulator-ready', () => {
          this.status = 'running';
        });
      } catch (e) {
        this.status = 'boot failed: ' + e.message;
        console.error(e);
      }
    }

    showScreen(args) {
      const container = this._ensureContainer();
      container.style.left = Scratch.Cast.toNumber(args.X) + 'px';
      container.style.top = Scratch.Cast.toNumber(args.Y) + 'px';
      container.style.width = Scratch.Cast.toNumber(args.W) + 'px';
      container.style.height = Scratch.Cast.toNumber(args.H) + 'px';
      container.style.display = 'block';
    }

    hideScreen() {
      if (this.container) this.container.style.display = 'none';
    }

    focusScreen() {
      if (this.container) this.container.focus();
    }

    _pressScancode(code, extended) {
      if (!this.emulator) return;
      const seq = extended ? [0xe0, code] : [code];
      const brk = extended ? [0xe0, code | 0x80] : [code | 0x80];
      this.emulator.keyboard_send_scancodes(seq);
      this.emulator.keyboard_send_scancodes(brk);
    }

    sendKey(args) {
      if (!this.emulator) return;
      const key = Scratch.Cast.toString(args.KEY).toLowerCase();
      const code = SCANCODES[key];
      if (code === undefined) {
        console.warn('Windows 1.0 Emulator: unknown key "' + key + '"');
        return;
      }
      this._pressScancode(code, !!ARROW_EXTENDED[key]);
    }

    _pressChar(char) {
      if (!this.emulator) return;
      const lower = char.toLowerCase();
      const isUpper = char !== lower && SCANCODES[lower] !== undefined;
      const shiftedBase = SHIFTED_SYMBOLS[char];

      if (isUpper) {
        this.emulator.keyboard_send_scancodes([SCANCODES.leftshift]);
        this._pressScancode(SCANCODES[lower], false);
        this.emulator.keyboard_send_scancodes([SCANCODES.leftshift | 0x80]);
      } else if (shiftedBase) {
        this.emulator.keyboard_send_scancodes([SCANCODES.leftshift]);
        this._pressScancode(SCANCODES[shiftedBase], false);
        this.emulator.keyboard_send_scancodes([SCANCODES.leftshift | 0x80]);
      } else if (char === ' ') {
        this._pressScancode(SCANCODES.space, false);
      } else if (SCANCODES[lower] !== undefined) {
        this._pressScancode(SCANCODES[lower], false);
      }
      // unsupported characters are silently skipped
    }

    typeText(args) {
      if (!this.emulator) return;
      const text = Scratch.Cast.toString(args.TEXT);
      for (const char of text) {
        this._pressChar(char);
      }
    }

    isRunning() {
      return !!(this.emulator && this.status === 'running');
    }

    getStatus() {
      return this.status;
    }

    reset() {
      if (this.emulator) {
        try { this.emulator.stop(); } catch (e) { /* ignore */ }
        this.emulator = null;
      }
      if (this.container) this.container.style.display = 'none';
      this.status = 'not booted';
    }
  }

  Scratch.extensions.register(new Windows1Emulator());
})(Scratch);

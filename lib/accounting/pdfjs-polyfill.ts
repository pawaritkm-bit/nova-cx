/**
 * pdfjs-polyfill.ts — polyfill browser globals ที่ pdfjs-dist (ภายใน pdf-parse) อ้างอิงตอน "โหลดโมดูล"
 *   บน Node/Vercel serverless (ไม่มี DOM) → ป้องกัน "ReferenceError: DOMMatrix is not defined"
 *   ที่ทำให้ตัวอ่าน PDF (auto-read/retry-locked) crash ตอน import
 *
 * ★ ต้อง import ไฟล์นี้ "ก่อน" import pdf-parse เสมอ (วางเป็น import แรกของไฟล์ที่ใช้ pdf-parse)
 * ★ DOMMatrix ทำงานจริงระดับ affine 2D (พอสำหรับ text extraction ของ pdfjs) · Path2D/ImageData เป็น stub
 */

class DOMMatrixPolyfill {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  m11 = 1; m12 = 0; m13 = 0; m14 = 0;
  m21 = 0; m22 = 1; m23 = 0; m24 = 0;
  m31 = 0; m32 = 0; m33 = 1; m34 = 0;
  m41 = 0; m42 = 0; m43 = 0; m44 = 1;
  is2D = true;

  constructor(init?: number[] | Float32Array | Float64Array | string | DOMMatrixPolyfill) {
    if (Array.isArray(init) || init instanceof Float32Array || init instanceof Float64Array) {
      const v = Array.from(init as ArrayLike<number>);
      if (v.length === 6) this.setValues(v[0], v[1], v[2], v[3], v[4], v[5]);
      else if (v.length === 16) {
        this.setValues(v[0], v[1], v[4], v[5], v[12], v[13]);
        this.is2D = false;
      }
    } else if (init && typeof init === "object") {
      const o = init as DOMMatrixPolyfill;
      this.setValues(o.a, o.b, o.c, o.d, o.e, o.f);
    }
  }

  private setValues(a: number, b: number, c: number, d: number, e: number, f: number) {
    this.a = this.m11 = a; this.b = this.m12 = b;
    this.c = this.m21 = c; this.d = this.m22 = d;
    this.e = this.m41 = e; this.f = this.m42 = f;
    return this;
  }

  /** คูณเมทริกซ์ affine 2D (this * other) → เมทริกซ์ใหม่ */
  multiply(o: DOMMatrixPolyfill): DOMMatrixPolyfill {
    const r = new DOMMatrixPolyfill();
    r.setValues(
      this.a * o.a + this.c * o.b,
      this.b * o.a + this.d * o.b,
      this.a * o.c + this.c * o.d,
      this.b * o.c + this.d * o.d,
      this.a * o.e + this.c * o.f + this.e,
      this.b * o.e + this.d * o.f + this.f,
    );
    return r;
  }
  multiplySelf(o: DOMMatrixPolyfill): DOMMatrixPolyfill {
    const r = this.multiply(o);
    return this.setValues(r.a, r.b, r.c, r.d, r.e, r.f);
  }
  preMultiplySelf(o: DOMMatrixPolyfill): DOMMatrixPolyfill {
    const r = o.multiply(this);
    return this.setValues(r.a, r.b, r.c, r.d, r.e, r.f);
  }
  translate(tx = 0, ty = 0): DOMMatrixPolyfill {
    return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, tx, ty]));
  }
  scale(sx = 1, sy = sx): DOMMatrixPolyfill {
    return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
  }
  transformPoint(p: { x?: number; y?: number } = {}): { x: number; y: number; z: number; w: number } {
    const x = p.x ?? 0, y = p.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
  inverse(): DOMMatrixPolyfill {
    const det = this.a * this.d - this.b * this.c;
    if (!det) return new DOMMatrixPolyfill();
    return new DOMMatrixPolyfill([
      this.d / det, -this.b / det, -this.c / det, this.a / det,
      (this.c * this.f - this.d * this.e) / det, (this.b * this.e - this.a * this.f) / det,
    ]);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.DOMMatrix === "undefined") g.DOMMatrix = DOMMatrixPolyfill;
if (typeof g.DOMPoint === "undefined") {
  g.DOMPoint = class { x; y; z; w; constructor(x = 0, y = 0, z = 0, w = 1) { this.x = x; this.y = y; this.z = z; this.w = w; } };
}
if (typeof g.Path2D === "undefined") {
  g.Path2D = class { addPath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} rect() {} closePath() {} };
}
if (typeof g.ImageData === "undefined") {
  g.ImageData = class { data: Uint8ClampedArray; width: number; height: number; constructor(w = 1, h = 1) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
}

export {};

export class CaptureEditor {
  constructor(canvas, changed = () => {}) {
    this.canvas = canvas; this.changed = changed; this.context = canvas.getContext("2d");
    canvas.addEventListener("pointerdown", event => { if (!this.ready) return; this.start = this.point(event); canvas.setPointerCapture(event.pointerId); });
    canvas.addEventListener("pointerup", event => {
      if (!this.start) return;
      const end = this.point(event), start = this.start; this.start = null;
      this.redact(Math.min(start.x, end.x), Math.min(start.y, end.y), Math.abs(end.x - start.x), Math.abs(end.y - start.y));
    });
    canvas.addEventListener("pointercancel", () => { this.start = null; });
  }
  point(event) { const rect = this.canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * this.canvas.width / rect.width, y: (event.clientY - rect.top) * this.canvas.height / rect.height }; }
  async load(blob) {
    if (!blob || blob.size > 20_000_000 || !["image/png", "image/jpeg", "image/webp"].includes(blob.type)) throw new Error("Choose a PNG, JPEG or WebP image up to 20 MB.");
    const bitmap = await createImageBitmap(blob);
    try {
      if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 20_000_000 || Math.max(bitmap.width, bitmap.height) > 16384) throw new Error("Choose an image up to 20 megapixels and 16,384 pixels per side.");
      this.canvas.width = bitmap.width; this.canvas.height = bitmap.height;
      this.context.drawImage(bitmap, 0, 0); this.original = this.context.getImageData(0, 0, bitmap.width, bitmap.height); this.ready = true;
      this.changed();
    } finally { bitmap.close(); }
  }
  redact(x, y, width, height) {
    if (!this.ready || ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
    this.context.fillStyle = "#000";
    this.context.fillRect(Math.floor(x), Math.floor(y), Math.ceil(width), Math.ceil(height)); this.changed();
  }
  reset() { if (this.original) { this.context.putImageData(this.original, 0, 0); this.changed(); } }
  export() { if (!this.ready) throw new Error("Choose an image first."); const image = this.canvas.toDataURL("image/png"); if (image.length > 8_388_630) throw new Error("The PNG is larger than 6 MB. Capture a smaller area."); return image; }
  clear() { this.original = null; this.ready = false; this.canvas.width = this.canvas.height = 1; }
}
